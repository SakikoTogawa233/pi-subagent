import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Startup import contract.
 *
 * The host's extension loader transpiles every module of every extension on
 * each Pi start with no module cache (`moduleCache: false`, fresh jiti per
 * extension). Measured on Pi 0.84.2 (see `.sakiko/decisions/0007`), a static
 * import of `@sakiko233/pi-agent-runtime` alone costs ~660-720 ms of module
 * import; the whole entry cost ~780 ms while every other installed extension
 * paid <= 78 ms.
 *
 * This contract keeps the startup import graph light: the entry point and the
 * modules it loads statically may import nothing beyond the pinned allowlist.
 * Heavy graphs (`./runner.js`, `./attested.js`, `./launch.js`, `./budget.js`,
 * and anything importing `@sakiko233/pi-agent-runtime` as a value) must be
 * reached only through the lazy loaders in `./lazy.ts`.
 */

const extensionsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extensions');

/** Modules the entry may load statically. Extend only with measured-justification. */
const ENTRY_STATIC_IMPORT_ALLOWLIST = new Set([
  'node:fs/promises',
  'node:url',
  '@earendil-works/pi-tui',
  'typebox',
  './background-client.js',
  './common.js',
  './hook-contract.js',
  './types.js',
]);

/**
 * Modules in the entry's static closure that must themselves stay light.
 * Their static value imports are limited to node builtins, host packages the
 * loader aliases natively, and other light modules in this set.
 */
const LIGHT_MODULE_CLOSURE = ['./background-client.js', './common.js', './hook-contract.js', './types.js'];

interface StaticImport {
  /** Import specifier exactly as written. */
  specifier: string;
  /** True when every imported binding is type-only (erased at transpile). */
  typeOnly: boolean;
}

/**
 * Extract static imports from TypeScript source text. Dynamic `import('...')`
 * is intentionally not matched: it is the sanctioned lazy path.
 */
function extractStaticImports(source: string): StaticImport[] {
  const imports: StaticImport[] = [];
  const pattern = /^import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? '';
    const specifier = match[2] ?? '';
    if (clause.trim() === '') {
      imports.push({ specifier, typeOnly: false });
      continue;
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces === null) {
      // `import * as x` or default import: always a value binding.
      imports.push({ specifier, typeOnly: clause.trimStart().startsWith('type ') });
      continue;
    }
    const specifiers = (braces[1] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const typeOnly =
      clause.trimStart().startsWith('type ') ||
      (specifiers.length > 0 && specifiers.every((entry) => entry.startsWith('type ')));
    imports.push({ specifier, typeOnly });
  }
  return imports;
}

describe('startup import contract', () => {
  it('the entry statically imports only allowlisted light modules as values', async () => {
    const source = await readFile(join(extensionsDir, 'subagent.ts'), 'utf8');
    const valueImports = extractStaticImports(source).filter((entry) => !entry.typeOnly);
    const specifiers = valueImports.map((entry) => entry.specifier);
    const disallowed = specifiers.filter((specifier) => !ENTRY_STATIC_IMPORT_ALLOWLIST.has(specifier));
    expect(
      disallowed,
      `subagent.ts must not statically import heavy modules; found: ${disallowed.join(', ')}`,
    ).toEqual([]);
    expect(specifiers.length, 'the entry must keep at least its light modules static').toBeGreaterThan(0);
  });

  it('the entry never statically imports the shared runtime as a value', async () => {
    const source = await readFile(join(extensionsDir, 'subagent.ts'), 'utf8');
    const runtimeImports = extractStaticImports(source).filter(
      (entry) => entry.specifier === '@sakiko233/pi-agent-runtime' && !entry.typeOnly,
    );
    expect(runtimeImports, 'runtime must be reached only via lazy dynamic import').toEqual([]);
  });

  it.each(LIGHT_MODULE_CLOSURE)('%s stays light: no static value import outside node builtins, aliased host packages, and the light closure', async (relative) => {
    const source = await readFile(join(extensionsDir, relative), 'utf8');
    const valueImports = extractStaticImports(source).filter((entry) => !entry.typeOnly);
    const allowed = new Set<string>([
      ...[...LIGHT_MODULE_CLOSURE, './lazy.js'].filter((entry) => entry !== relative),
    ]);
    const disallowed = valueImports
      .map((entry) => entry.specifier)
      .filter(
        (specifier) =>
          !specifier.startsWith('node:') &&
          !specifier.startsWith('@earendil-works/') &&
          specifier !== 'typebox' &&
          !allowed.has(specifier),
      );
    expect(disallowed, `${relative} pulls heavy static imports: ${disallowed.join(', ')}`).toEqual([]);
  });

  it('the lazy loaders exist for every heavy module kept off the startup path', async () => {
    const source = await readFile(join(extensionsDir, 'lazy.ts'), 'utf8');
    for (const heavy of ['./runner.js', './attested.js', './launch.js', './budget.js']) {
      expect(source, `lazy.ts must dynamically import ${heavy}`).toContain(`import(${JSON.stringify(heavy)})`);
    }
  });
});
