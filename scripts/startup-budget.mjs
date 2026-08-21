#!/usr/bin/env node
/**
 * Startup budget gate for the packed pi-subagent extension entry.
 *
 * Usage: node scripts/startup-budget.mjs <budget-ms>
 *
 * Packs this repository exactly as published, installs its production
 * dependencies into the extracted package, then measures the
 * `<entry> module import` line the Pi host prints under PI_TIMING=1. The
 * median of five measured runs must not exceed <budget-ms>.
 *
 * Why module import and not wall clock: the container wall clock is noisy
 * (baseline medians varied by seconds across identical arms), while the host's
 * own per-extension instrumentation is stable run to run. See
 * `.sakiko/decisions/0007-subagent-startup-import-cost.md`.
 *
 * Exit codes: 0 = within budget, 1 = over budget or measurement failed,
 * 2 = usage error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const measuredRuns = 5;

const budgetArg = process.argv[2];
if (budgetArg === undefined) {
  console.error('usage: node scripts/startup-budget.mjs <budget-ms>');
  process.exit(2);
}
const budgetMs = Number(budgetArg);
if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
  console.error(`budget must be a positive number of milliseconds, got: ${budgetArg}`);
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = runCaptured(command, args, options);
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} exited ${result.status}`);
    console.error(result.stderr);
    process.exit(1);
  }
  return result.stdout;
}

function runCaptured(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function launchPi(entryPath) {
  const env = {
    ...process.env,
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    PI_TIMING: '1',
    NO_COLOR: '1',
  };
  const result = runCaptured(
    'pi',
    [
      '--no-extensions',
      '-e',
      entryPath,
      '--no-session',
      '-p',
      '--offline',
      '--no-tools',
      'reply ok',
    ],
    { env },
  );
  const stderr = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const entryLine = stderr
    .split('\n')
    .find((line) => line.includes('subagent.ts') && line.includes('module import'));
  if (entryLine === undefined) {
    console.error('could not find "<entry> module import" in pi output; PI_TIMING may be disabled');
    console.error(stderr);
    process.exit(1);
  }
  return Number(/module import: (\d+)ms/.exec(entryLine)[1]);
}

const workDir = await mkdtemp(join(tmpdir(), 'pi-subagent-startup-budget-'));
try {
  console.error(`pi version: ${run('pi', ['--version']).trim()}`);

  // 1. Pack exactly what npm publish would ship.
  const packJson = JSON.parse(run('npm', ['pack', '--json'], { cwd: repoRoot }));
  const tarball = packJson[0].filename;
  console.error(`packed: ${tarball}`);

  // 2. Extract and install production dependencies (the shared runtime).
  const extractDir = join(workDir, 'extract');
  await mkdir(extractDir, { recursive: true });
  run('tar', ['-xzf', join(repoRoot, tarball), '-C', extractDir]);
  const packageDir = join(extractDir, 'package');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: packageDir });
  const entry = join(packageDir, 'extensions', 'subagent.ts');
  if (!existsSync(entry)) {
    console.error(`packed payload is missing the extension entry: ${entry}`);
    process.exit(1);
  }
  const installedRuntime = JSON.parse(
    await readFile(
      join(packageDir, 'node_modules', '@sakiko233', 'pi-agent-runtime', 'package.json'),
      'utf8',
    ),
  );
  console.error(`runtime resolved: @sakiko233/pi-agent-runtime@${installedRuntime.version}`);

  // 3. One warmup launch, then the measured runs.
  launchPi(entry);
  const runs = [];
  for (let i = 0; i < measuredRuns; i++) {
    runs.push(launchPi(entry));
    console.error(`  run ${i + 1}/${measuredRuns}: ${runs[runs.length - 1]}ms`);
  }
  const sorted = [...runs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // 4. Clean up the tarball npm pack dropped in the repo root.
  await rm(join(repoRoot, tarball), { force: true });

  console.error('');
  console.error(
    `startup budget: median module import ${median}ms over ${measuredRuns} runs (budget ${budgetMs}ms)`,
  );
  if (median > budgetMs) {
    console.error(`FAIL: median ${median}ms exceeds the ${budgetMs}ms budget`);
    console.error(`runs: ${runs.join(', ')}`);
    process.exit(1);
  }
  console.error('PASS');
  process.exit(0);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
