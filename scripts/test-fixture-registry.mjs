import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const modeFile = process.argv[3];

const packages = new Map();
const tarballs = new Map();
for (const entry of config.packages) {
  const bytes = readFileSync(entry.tarball);
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', entry.tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
  const versions = packages.get(manifest.name) ?? new Map();
  versions.set(manifest.version, { manifest, bytes });
  packages.set(manifest.name, versions);
  tarballs.set(
    `/${encodeURIComponent(manifest.name)}/-/${manifest.name.split('/').at(-1)}-${manifest.version}.tgz`,
    {
      bytes,
      contentType: 'application/octet-stream',
    },
  );
}

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const tarball = tarballs.get(path);
  if (tarball !== undefined) {
    response.writeHead(200, { 'content-type': tarball.contentType });
    response.end(tarball.bytes);
    return;
  }

  const name = decodeURIComponent(path.slice(1));
  const versions = packages.get(name);
  if (versions === undefined) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const mode = readFileSync(modeFile, 'utf8').trim();
  const latest = config.latest[mode][name];
  const body = {
    name,
    'dist-tags': { latest },
    versions: Object.fromEntries(
      [...versions].map(([version, { manifest, bytes }]) => [
        version,
        {
          ...manifest,
          dist: {
            shasum: createHash('sha1').update(bytes).digest('hex'),
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
            tarball: `http://127.0.0.1:${server.address().port}/${encodeURIComponent(name)}/-/${name.split('/').at(-1)}-${version}.tgz`,
          },
        },
      ]),
    ),
  };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
