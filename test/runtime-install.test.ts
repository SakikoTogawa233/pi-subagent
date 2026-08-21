import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const fixtures = join(repoRoot, 'test', 'fixtures');
const registryScript = join(repoRoot, 'scripts', 'test-fixture-registry.mjs');
const smokeScript = join(repoRoot, 'scripts', 'smoke-installed-packages.mjs');
const roots: string[] = [];
let registry: ChildProcessWithoutNullStreams;
let registryUrl: string;
let modeFile: string;
let packedSubagent: string;

const fixtureFiles = {
  runtime010: join(fixtures, 'sakiko233-pi-agent-runtime-0.1.0.tgz'),
  runtime011: join(fixtures, 'sakiko233-pi-agent-runtime-0.1.1.tgz'),
  background300: join(fixtures, 'sakiko233-pi-background-tasks-3.0.0.tgz'),
  subagent010: join(fixtures, 'sakiko233-pi-subagent-0.1.0.tgz'),
};

const expectedFixtureSha512 = {
  [fixtureFiles.runtime010]:
    '99c57c28e8654f60447250fd75edbb8ed1ab072fccf42b0b2fa8a7674ccbc3029c0a3b54e922314ff3e98583c8455506b6dc325fa29a532fa30305423470cbbb',
  [fixtureFiles.runtime011]:
    'b947798408aac2a7298bb3c8ffb94866b875795ca0bc0a8f8be0e5f69c88a58a50714c49abbc1e31ec3f992d8c7cc7c821263fdec3f0bbb68a19004c94a6f071',
  [fixtureFiles.background300]:
    '66ccf162a758844a13c852b052577a713910acaeb103b536f3834c6108ab1c40607e1cf27f6dc4939f6f3ad65e899f739feefc58b80f3bb881897ae4c74e46e6',
  [fixtureFiles.subagent010]:
    'f6bb0cd35e2db81914bf61dfc52b48267acc24ea14bb8b1eb8c70ecaef252e98dc9c93478075a363482d1db34d50727f2ce8be03cc00eb0df5b8d5478ed55fc8',
};

interface PackEntry {
  filename: string;
}

async function packRepairedSubagent(root: string): Promise<string> {
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', root], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'silent' },
  });
  const entry = (JSON.parse(output) as PackEntry[])[0];
  if (entry === undefined) throw new Error('npm pack returned no package entry');
  packedSubagent = join(root, entry.filename);

  const staged = join(root, 'repaired-release');
  await mkdir(staged);
  execFileSync('tar', ['-xzf', packedSubagent, '-C', staged]);
  const manifestPath = join(staged, 'package', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '0.1.1';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const stagedOutput = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', root, join(staged, 'package')],
    {
      encoding: 'utf8',
      env: { ...process.env, npm_config_loglevel: 'silent' },
    },
  );
  const stagedEntry = (JSON.parse(stagedOutput) as PackEntry[])[0];
  if (stagedEntry === undefined) throw new Error('staged npm pack returned no package entry');
  return join(root, stagedEntry.filename);
}

async function startRegistry(configPath: string): Promise<void> {
  registry = spawn(process.execPath, [registryScript, configPath, modeFile], {
    stdio: 'pipe',
  });
  registryUrl = await new Promise<string>((resolvePromise, reject) => {
    registry.stdout.once('data', (chunk) => resolvePromise(String(chunk).trim()));
    registry.once('error', reject);
    registry.once('exit', (code) => reject(new Error(`fixture registry exited ${String(code)}`)));
  });
}

async function createAgentDir(root: string): Promise<string> {
  const agentDir = join(root, 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'settings.json'),
    `${JSON.stringify(
      {
        npmCommand: [
          'npm',
          '--registry',
          registryUrl,
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
        ],
      },
      null,
      2,
    )}\n`,
  );
  return agentDir;
}

function piInstall(agentDir: string, source: string): string {
  return execFileSync('pi', ['install', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_BG_DISABLE_UPDATE_CHECK: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      npm_config_loglevel: 'error',
    },
  });
}

function smoke(agentDir: string, mode: 'load' | 'start'): string {
  return execFileSync(process.execPath, [smokeScript, agentDir, mode], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_BG_DISABLE_UPDATE_CHECK: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    },
  });
}

async function assertTwoPackageTopology(agentDir: string, runtimeVersion: string): Promise<void> {
  const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  expect(settings.packages).toEqual([
    'npm:@sakiko233/pi-background-tasks',
    'npm:@sakiko233/pi-subagent',
  ]);
  const rootManifest = JSON.parse(await readFile(join(agentDir, 'npm', 'package.json'), 'utf8'));
  expect(Object.keys(rootManifest.dependencies).sort()).toEqual([
    '@sakiko233/pi-background-tasks',
    '@sakiko233/pi-subagent',
  ]);
  expect(rootManifest.dependencies['@sakiko233/pi-agent-runtime']).toBeUndefined();
  const installedRuntime = JSON.parse(
    await readFile(
      join(agentDir, 'npm', 'node_modules', '@sakiko233', 'pi-agent-runtime', 'package.json'),
      'utf8',
    ),
  );
  expect(installedRuntime.version).toBe(runtimeVersion);
  expect(installedRuntime.pi).toBeUndefined();
  for (const resource of ['extensions', 'skills', 'prompts', 'themes', 'commands', 'tools']) {
    expect(installedRuntime.files).not.toContain(resource);
  }
}

beforeAll(async () => {
  expect(execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim()).toBe('0.84.2');
  const root = await mkdtemp(join(tmpdir(), 'pi-subagent-runtime-install-suite-'));
  roots.push(root);
  for (const [path, digest] of Object.entries(expectedFixtureSha512)) {
    const actual = createHash('sha512')
      .update(await readFile(path))
      .digest('hex');
    expect(actual, path).toBe(digest);
  }
  modeFile = join(root, 'registry-mode');
  await writeFile(modeFile, 'historical\n');
  const repairedRelease = await packRepairedSubagent(root);
  const configPath = join(root, 'registry.json');
  await writeFile(
    configPath,
    `${JSON.stringify({
      packages: [
        { tarball: fixtureFiles.runtime010 },
        { tarball: fixtureFiles.runtime011 },
        { tarball: fixtureFiles.background300 },
        { tarball: fixtureFiles.subagent010 },
        { tarball: repairedRelease },
      ],
      latest: {
        historical: {
          '@sakiko233/pi-agent-runtime': '0.1.0',
          '@sakiko233/pi-background-tasks': '3.0.0',
          '@sakiko233/pi-subagent': '0.1.0',
        },
        fixed: {
          '@sakiko233/pi-agent-runtime': '0.1.1',
          '@sakiko233/pi-background-tasks': '3.0.0',
          '@sakiko233/pi-subagent': '0.1.1',
        },
      },
    })}\n`,
  );
  await startRegistry(configPath);
}, 120_000);

afterAll(async () => {
  registry.kill('SIGTERM');
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.sequential('fixed transitive runtime installation', () => {
  it('reproduces the historical locked runtime failure and upgrades through Pi package install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-subagent-runtime-upgrade-'));
    roots.push(root);
    const agentDir = await createAgentDir(root);
    piInstall(agentDir, 'npm:@sakiko233/pi-background-tasks');
    piInstall(agentDir, 'npm:@sakiko233/pi-subagent');
    await assertTwoPackageTopology(agentDir, '0.1.0');

    let historicalFailure = '';
    try {
      smoke(agentDir, 'load');
    } catch (error) {
      const commandError = error as { message: string; stderr?: string };
      historicalFailure = `${commandError.message}\n${commandError.stderr ?? ''}`;
    }
    expect(historicalFailure).toContain('dist/compat.js/api/constrained-sampling');
    expect(historicalFailure).toContain(
      'node_modules/@sakiko233/pi-agent-runtime/dist/anthropic-attribution.js',
    );

    await writeFile(modeFile, 'fixed\n');
    piInstall(agentDir, 'npm:@sakiko233/pi-subagent');
    const output = smoke(agentDir, 'start');
    expect(output).toContain('"pi_version":"0.84.2"');
    expect(output).toContain(
      '"subagent_tools":["subagent_result","subagent_run","subagent_run_attested"]',
    );
    await assertTwoPackageTopology(agentDir, '0.1.1');
  }, 120_000);

  it('installs only the two user packages cleanly and starts all three subagent tools', async () => {
    await writeFile(modeFile, 'fixed\n');
    const root = await mkdtemp(join(tmpdir(), 'pi-subagent-runtime-clean-'));
    roots.push(root);
    const agentDir = await createAgentDir(root);
    piInstall(agentDir, 'npm:@sakiko233/pi-background-tasks');
    piInstall(agentDir, 'npm:@sakiko233/pi-subagent');
    await assertTwoPackageTopology(agentDir, '0.1.1');
    const output = smoke(agentDir, 'start');
    expect(output).toContain('"extension_errors":[]');
    expect(output).toContain(
      '"subagent_tools":["subagent_result","subagent_run","subagent_run_attested"]',
    );
  }, 120_000);

  it('packs a manifest that excludes runtime 0.1.0 and bundles no runtime Pi resource', () => {
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', packedSubagent, 'package/package.json'], {
        encoding: 'utf8',
      }),
    );
    expect(manifest.dependencies['@sakiko233/pi-agent-runtime']).toBe('^0.1.1');
    expect(manifest.pi).toEqual({ extensions: ['./extensions/subagent.ts'] });
    const listing = execFileSync('tar', ['-tzf', packedSubagent], { encoding: 'utf8' });
    expect(listing).not.toContain('node_modules/@sakiko233/pi-agent-runtime');
  });
});
