/**
 * Lazy loaders for the heavy module graphs.
 *
 * The Pi extension loader transpiles every extension module on every start
 * with no module cache, and a fresh jiti instance per extension. Loading
 * `@sakiko233/pi-agent-runtime` (imported for values by runner/attested/
 * launch/budget) through that pipeline costs ~660-720 ms of module import on
 * Pi 0.84.2 — measured in `.sakiko/decisions/0007-subagent-startup-import-cost.md`.
 *
 * These four modules are therefore imported only when a subagent tool actually
 * executes. Each loader hands out the same module promise for the lifetime of
 * the process, so the transpile cost is paid exactly once per session, at
 * first use.
 */

let runnerModule: Promise<typeof import('./runner.js')> | undefined;
let launchModule: Promise<typeof import('./launch.js')> | undefined;
let budgetModule: Promise<typeof import('./budget.js')> | undefined;
let attestedModule: Promise<typeof import('./attested.js')> | undefined;
let heavyImportChain: Promise<void> = Promise.resolve();

/**
 * Serialize lazy graph roots across Jiti's shared parent cache.
 *
 * Jiti publishes an async module into `parentCache` before evaluation finishes,
 * and a concurrent import returns that module's current `exports` immediately.
 * The runtime barrel installs re-exports sequentially, so overlapping heavy
 * roots can observe it before the token-budget exports exist. One import root at
 * a time keeps every named binding behind the completed barrel evaluation.
 */
function serializeHeavyImport<T>(load: () => Promise<T>): Promise<T> {
  const loaded = heavyImportChain.then(load);
  heavyImportChain = loaded.then(() => undefined);
  return loaded;
}

export function loadRunnerModule(): Promise<typeof import('./runner.js')> {
  runnerModule ??= serializeHeavyImport(() => import('./runner.js'));
  return runnerModule;
}

export function loadLaunchModule(): Promise<typeof import('./launch.js')> {
  launchModule ??= serializeHeavyImport(() => import('./launch.js'));
  return launchModule;
}

export function loadBudgetModule(): Promise<typeof import('./budget.js')> {
  budgetModule ??= serializeHeavyImport(() => import('./budget.js'));
  return budgetModule;
}

export function loadAttestedModule(): Promise<typeof import('./attested.js')> {
  attestedModule ??= serializeHeavyImport(() => import('./attested.js'));
  return attestedModule;
}
