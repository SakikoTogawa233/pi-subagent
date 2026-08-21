import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Bootstrap development dependencies, installing the sibling `pi-agent-runtime`
 * checkout as a packed tarball.
 *
 * The runtime is published to npm, but this setup command deliberately uses
 * the sibling checkout's packed bytes so development and coordinated local
 * changes are tested instead of silently resolving the registry copy. It packs
 * the sibling repository exactly the way the runtime's own synthetic-consumer
 * tests do, then installs the full dependency tree with the tarball satisfying
 * the manifest's published `^0.1.1` range (`--no-save` keeps package.json on
 * the published range).
 */

const runtimeRoot = resolve(process.cwd(), '..', 'pi-agent-runtime');

if (!existsSync(resolve(runtimeRoot, 'package.json'))) {
  throw new Error(
    `sibling runtime checkout not found at ${runtimeRoot}; clone pi-agent-runtime next to this repository before running setup:runtime`,
  );
}

console.log(`packing @sakiko233/pi-agent-runtime from ${runtimeRoot}`);
const output = execFileSync('npm', ['pack', '--json', '--pack-destination', process.cwd()], {
  cwd: runtimeRoot,
  encoding: 'utf8',
  env: { ...process.env, npm_config_loglevel: 'silent' },
});
const packed = JSON.parse(output);
const entry = packed[0];
if (entry === undefined) throw new Error('npm pack returned no package entry');
console.log(`packed ${entry.filename}`);

console.log('installing runtime tarball into this repository');
execFileSync('npm', ['install', '--no-save', '--ignore-scripts', entry.filename], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: 'inherit',
  env: { ...process.env, npm_config_loglevel: 'error' },
});
console.log('runtime tarball installed');
