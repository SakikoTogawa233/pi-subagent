import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real-loader regression for the 0.1.2 lazy-graph escape.
 *
 * The historical entry starts runner.ts and launch.ts concurrently. Jiti's
 * async evaluator publishes a new Module into its shared parentCache before
 * evaluation finishes, and a concurrent cache hit returns that in-progress
 * exports object immediately. The runtime barrel installs its re-exports in
 * source order, so budget.ts can observe the barrel before token-budget.js has
 * installed TOKEN_BUDGET_CALIBRATION_VERSION. The policy literal then captures
 * undefined permanently even though the barrel finishes later.
 *
 * No loader is mocked here. Each probe imports the installed host's own
 * dist/core/extensions/loader.js, which constructs jiti with moduleCache:false
 * and its production alias map.
 */

const repoRoot = resolve(import.meta.dirname, '..');
const fixtures = join(repoRoot, 'test', 'fixtures');
const probeScript = join(repoRoot, 'scripts', 'real-loader-calibration-probe.mjs');
const runtimeFixture = join(fixtures, 'sakiko233-pi-agent-runtime-0.1.1.tgz');
const historicalFixture = join(fixtures, 'sakiko233-pi-subagent-0.1.2.tgz');
const calibrationVersion = 'pi-agent-runtime.input-token-calibration.v1';
const historicalError =
  'JSON value at $.policy.calibration_version is unsupported: received undefined';
const historicalFixtureSha512 =
  '4482073121ed001382bf180e8e774df8d696ba36dae3b0b769686a57aa7aacff9ba28185ef99fb53cae09119917726d3a7b1389bab9e475e73a73b5590dd4ff4';

interface HostFixture {
  version: '0.84.2' | '0.84.3';
  loaderPath: string;
  packageRoot: string;
}

interface RouteFixture {
  mode: 'default' | 'explicit';
  qualifiedId: 'zai-coding-cn/glm-5.3' | 'openai-codex/gpt-5.6-sol';
}

type ProbeResult =
  | {
      ok: true;
      taskId: string;
      route: string;
      calibrationVersion: string;
    }
  | {
      ok: false;
      name: string;
      message: string;
    };

function resolveHost(packageRoot: string, expectedVersion: HostFixture['version']): HostFixture {
  const manifest = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(JSON.stringify(require(${JSON.stringify(join(packageRoot, 'package.json'))}).version))`,
      ],
      { encoding: 'utf8' },
    ),
  ) as string;
  expect(manifest).toBe(expectedVersion);
  return {
    version: expectedVersion,
    packageRoot,
    loaderPath: join(packageRoot, 'dist', 'core', 'extensions', 'loader.js'),
  };
}

const hosts = [
  resolveHost(join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent'), '0.84.2'),
  resolveHost(join(repoRoot, 'node_modules', 'pi-coding-agent-0-84-3'), '0.84.3'),
] as const;

const routes = [
  { mode: 'default', qualifiedId: 'zai-coding-cn/glm-5.3' },
  { mode: 'explicit', qualifiedId: 'openai-codex/gpt-5.6-sol' },
] as const satisfies readonly RouteFixture[];

const matrix = hosts.flatMap((host) => routes.map((route) => ({ host, route })));
const roots: string[] = [];
let suiteRoot: string;
let historicalEntry: string;
let candidateEntry: string;

async function packCandidate(destination: string): Promise<string> {
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'silent' },
  });
  const packed = (JSON.parse(output) as Array<{ filename: string }>)[0];
  if (packed === undefined) throw new Error('npm pack returned no candidate tarball');
  return join(destination, packed.filename);
}

async function installPluginTarball(
  root: string,
  pluginTarball: string,
): Promise<{ entry: string; version: string }> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'real-loader-calibration-fixture', private: true })}\n`,
  );
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-save',
      '--legacy-peer-deps',
      pluginTarball,
      runtimeFixture,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_loglevel: 'error' },
    },
  );
  const packageRoot = join(root, 'node_modules', '@sakiko233', 'pi-subagent');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return { entry: join(packageRoot, 'extensions', 'subagent.ts'), version: manifest.version };
}

function runProbe(
  host: HostFixture,
  entry: string,
  route: RouteFixture,
  label: string,
): ProbeResult {
  const cwd = join(
    suiteRoot,
    'runs',
    label,
    host.version,
    route.mode,
  );
  const result = spawnSync(
    process.execPath,
    [probeScript, host.loaderPath, entry, route.mode, cwd],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `real-loader probe exited ${String(result.status)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout.trim()) as ProbeResult;
}

beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), 'pi-subagent-real-loader-calibration-'));
  roots.push(suiteRoot);

  const actualHistoricalSha512 = createHash('sha512')
    .update(await readFile(historicalFixture))
    .digest('hex');
  expect(actualHistoricalSha512).toBe(historicalFixtureSha512);

  const historical = await installPluginTarball(
    join(suiteRoot, 'historical-install'),
    historicalFixture,
  );
  expect(historical.version).toBe('0.1.2');
  historicalEntry = historical.entry;

  const candidateTarball = await packCandidate(suiteRoot);
  const candidate = await installPluginTarball(
    join(suiteRoot, 'candidate-install'),
    candidateTarball,
  );
  const repoManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  expect(candidate.version).toBe(repoManifest.version);
  candidateEntry = candidate.entry;
}, 120_000);

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential('real pi jiti loader calibration binding', () => {
  it.each(hosts)('pins the production loader configuration on pi $version', async (host) => {
    const loaderSource = await readFile(host.loaderPath, 'utf8');
    expect(loaderSource).toContain('moduleCache: false');
    expect(loaderSource).toContain('alias: getAliases()');
    const hostManifest = JSON.parse(
      await readFile(join(host.packageRoot, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(hostManifest.dependencies['jiti']).toBe('2.7.0');
  });

  it.each(matrix)(
    'reproduces registry 0.1.2 on pi $host.version with the $route.mode route',
    ({ host, route }) => {
      const result = runProbe(host, historicalEntry, route, 'historical');
      expect(result).toMatchObject({
        ok: false,
        name: 'TypeError',
        message: historicalError,
      });
    },
  );

  it.each(matrix)(
    'launches the candidate on pi $host.version with the $route.mode route',
    ({ host, route }) => {
      const result = runProbe(host, candidateEntry, route, 'candidate');
      if (!result.ok) throw new Error(result.message);
      expect(result.taskId).toMatch(/^s[0-9a-f]{32}$/);
      expect(result.route).toBe(route.qualifiedId);
      expect(result.calibrationVersion).toBe(calibrationVersion);
    },
  );
});
