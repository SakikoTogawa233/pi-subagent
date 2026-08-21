import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [agentDirArgument, mode] = process.argv.slice(2);
const agentDir = resolve(agentDirArgument);
const installRoot = join(agentDir, 'npm');
const codingAgentEntry = new URL(import.meta.resolve('@earendil-works/pi-coding-agent'));
const codingAgentRoot = resolve(dirname(codingAgentEntry.pathname), '..');
const codingAgentManifest = JSON.parse(
  await readFile(join(codingAgentRoot, 'package.json'), 'utf8'),
);
if (codingAgentManifest.version !== '0.84.2') {
  throw new Error(`expected Pi 0.84.2, got ${String(codingAgentManifest.version)}`);
}

const subagentPath = join(
  installRoot,
  'node_modules',
  '@sakiko233',
  'pi-subagent',
  'extensions',
  'subagent.ts',
);
const loaderPath = join(codingAgentRoot, 'dist', 'core', 'extensions', 'loader.js');
const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
const loadResult = await loadExtensions([subagentPath], installRoot);
if (loadResult.errors.length !== 0) {
  throw new Error(loadResult.errors.map(({ error }) => error).join('\n'));
}
if (loadResult.extensions.length !== 1) {
  throw new Error(`expected one subagent extension, got ${String(loadResult.extensions.length)}`);
}

if (mode === 'load') {
  console.log('Pi 0.84.2 loaded the installed pi-subagent extension through Jiti');
  process.exit(0);
}
if (mode !== 'start') throw new Error(`unknown smoke mode: ${String(mode)}`);

const {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import('@earendil-works/pi-coding-agent');
const cwd = join(agentDir, 'smoke-project');
await mkdir(cwd, { recursive: true });
const backgroundPath = join(
  installRoot,
  'node_modules',
  '@sakiko233',
  'pi-background-tasks',
  'extensions',
  'background-tasks.ts',
);
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  additionalExtensionPaths: [backgroundPath, subagentPath],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  noThemes: true,
  eventBus: createEventBus(),
});
await loader.reload();
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: null,
});
const { session } = await createAgentSession({
  cwd,
  agentDir,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager,
  modelRuntime,
  noTools: 'builtin',
});
try {
  await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
  const subagentTools = session
    .getActiveToolNames()
    .filter((name) => name.startsWith('subagent_'))
    .sort();
  const expected = ['subagent_result', 'subagent_run', 'subagent_run_attested'].sort();
  if (JSON.stringify(subagentTools) !== JSON.stringify(expected)) {
    throw new Error(`unexpected subagent tools: ${JSON.stringify(subagentTools)}`);
  }
  console.log(
    JSON.stringify({
      pi_version: codingAgentManifest.version,
      extension_errors: [],
      subagent_tools: subagentTools,
    }),
  );
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
