import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Package payload gate for pi-subagent.
 *
 * Verifies, against a real packed tarball (never a dry-run file list alone):
 *
 * 1. The packed payload is exactly the allowlist: extensions/, README.md,
 *    LICENSE, THIRD_PARTY_NOTICES.md, package.json.
 * 2. No undeclared Pi resources (skills/prompts/themes) leak into the payload,
 *    and the pi manifest declares only the one extension entrypoint.
 * 3. The Anthropic attribution IMPLEMENTATION ships zero times: packed bytes are
 *    scanned for distinctive markers of the runtime's attribution source. Only
 *    the loader re-export may reference it.
 * 4. A synthetic packed consumer can install the tarball together with the
 *    sibling-built runtime tarball and resolve every runtime export the shipped
 *    sources import.
 */

const root = resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// --- manifest shape -----------------------------------------------------------
const pi = manifest.pi;
if (!pi || !Array.isArray(pi.extensions) || pi.extensions.length !== 1) {
  throw new Error('pi manifest must declare exactly one extension entrypoint');
}
if (pi.extensions[0] !== './extensions/subagent.ts') {
  throw new Error(`unexpected pi extension entrypoint: ${String(pi.extensions[0])}`);
}
for (const key of Object.keys(pi)) {
  if (key !== 'extensions') throw new Error(`pi manifest declares an unexpected resource: ${key}`);
}
for (const host of Object.keys(manifest.peerDependencies ?? {})) {
  if (manifest.dependencies?.[host] !== undefined) {
    throw new Error(`host package ${host} must stay a peer, never a dependency`);
  }
}
if (manifest.dependencies?.['@sakiko233/pi-agent-runtime'] === undefined) {
  throw new Error('the runtime dependency is required');
}

// --- pack both packages --------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'pi-subagent-pack-'));
try {
  const packOut = execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'silent' },
  });
  const subagentTgz = join(work, JSON.parse(packOut)[0].filename);

  const runtimeRoot = resolve(root, '..', 'pi-agent-runtime');
  const runtimePack = execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'silent' },
  });
  const runtimeTgz = join(work, JSON.parse(runtimePack)[0].filename);

  // --- payload allowlist + resource leaks --------------------------------------
  const extractDir = join(work, 'payload');
  execFileSync('tar', ['-xzf', subagentTgz, '-C', work, '--one-top-level=payload'], {
    encoding: 'utf8',
  });
  const listing = execFileSync('find', [extractDir, '-type', 'f'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((path) => path.slice(extractDir.length + 1))
    .sort();
  const allowedTopLevel = new Set([
    'package/README.md',
    'package/LICENSE',
    'package/THIRD_PARTY_NOTICES.md',
    'package/package.json',
  ]);
  for (const path of listing) {
    if (!allowedTopLevel.has(path) && !path.startsWith('package/extensions/')) {
      throw new Error(`unexpected packed path: ${path}`);
    }
    if (/(^|\/)(skills|prompts|themes)(\/|$)/.test(path)) {
      throw new Error(`Pi resource leaked into the package: ${path}`);
    }
  }
  for (const required of [
    'package/extensions/subagent.ts',
    'package/extensions/subagent-child.ts',
    'package/extensions/subagent-attribution.ts',
    'package/extensions/hook-contract-evidence.json',
  ]) {
    if (!listing.includes(required)) throw new Error(`packed payload is missing ${required}`);
  }

  // --- attribution implementation bytes ship zero times -------------------------
  const attributionMarkers = [
    'pi-agent-runtime.anthropic-attribution.claim.v1',
    'pi-agent-runtime.anthropic-attribution-proof.v1',
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  ];
  for (const path of listing) {
    const bytes = readFileSync(join(extractDir, path));
    for (const marker of attributionMarkers) {
      if (bytes.includes(marker)) {
        throw new Error(
          `attribution implementation bytes leaked into the package: ${path} contains "${marker}"`,
        );
      }
    }
  }

  // --- packed-consumer runtime export resolution --------------------------------
  const runtimeSpecifiers = new Set();
  for (const path of listing) {
    if (!path.endsWith('.ts')) continue;
    const source = readFileSync(join(extractDir, path), 'utf8');
    for (const match of source.matchAll(/from '(@sakiko233\/pi-agent-runtime[^']*)'/g)) {
      runtimeSpecifiers.add(match[1]);
    }
  }
  if (runtimeSpecifiers.size === 0) {
    throw new Error('no runtime imports found in shipped sources; the gate would be vacuous');
  }

  const consumer = join(work, 'consumer');
  execFileSync('mkdir', ['-p', consumer]);
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'pack-consumer', private: true, type: 'module' })}\n`,
  );
  execFileSync('npm', ['install', '--no-save', '--ignore-scripts', subagentTgz, runtimeTgz], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  const checkModule = join(consumer, 'check.mjs');
  writeFileSync(
    checkModule,
    `const specifiers = ${JSON.stringify([...runtimeSpecifiers])};\n` +
      `for (const specifier of specifiers) {\n` +
      `  const resolved = import.meta.resolve(specifier);\n` +
      `  if (!resolved.includes('pi-agent-runtime')) throw new Error('bad resolution: ' + specifier + ' -> ' + resolved);\n` +
      `}\n` +
      `console.log('resolved ' + specifiers.length + ' runtime specifiers from the packed consumer');\n`,
  );
  execFileSync(process.execPath, [checkModule], { cwd: consumer, encoding: 'utf8' });

  console.log(
    `package payload verified: ${String(listing.length)} files, attribution implementation absent, ${String(runtimeSpecifiers.size)} runtime specifiers resolve`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
