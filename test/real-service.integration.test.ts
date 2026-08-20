import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentSession,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { writeFileDurable } from '@sakiko233/pi-agent-runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { SubagentBackgroundClient } from '../extensions/background-client.js';
import {
  buildSubagentResultPackage,
  serializeSubagentResultPackage,
} from '../extensions/result-package.js';
import { createSubagentExtension } from '../extensions/subagent.js';
import {
  SUBAGENT_RESULT_TOOL_NAME,
  SUBAGENT_RUN_ATTESTED_TOOL_NAME,
  SUBAGENT_RUN_TOOL_NAME,
} from '../extensions/types.js';
import { type MemoryEventBus, makeFakeSpawn, StubPi } from './helpers/fakes.js';

/**
 * Real-service integration: the actual pi-background-tasks extension from the
 * sibling `feat/extract-agent-workflows` checkout is loaded in-process through
 * Pi's SDK, exactly like the source repository's own SDK tests load it. No
 * stub service is involved anywhere in this file.
 */

const subagentRoot = fileURLToPath(new URL('..', import.meta.url));
const backgroundExtensionPath = resolve(
  subagentRoot,
  '..',
  'pi-background-tasks',
  'extensions',
  'background-tasks.ts',
);
const subagentExtensionPath = resolve(subagentRoot, 'extensions', 'subagent.ts');

if (!existsSync(backgroundExtensionPath)) {
  throw new Error(
    `sibling pi-background-tasks checkout not found at ${backgroundExtensionPath}; the real-service integration test requires it`,
  );
}

process.env['PI_BG_DISABLE_UPDATE_CHECK'] = '1';

const roots: string[] = [];
const sessions: AgentSession[] = [];

afterAll(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface SdkHarness {
  session: AgentSession;
  cwd: string;
  bus: ReturnType<typeof createEventBus>;
}

async function sdkHarness(extensionPaths: string[]): Promise<SdkHarness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagent-integration-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  // A static provider gives the session's real ModelRegistry one model so the
  // subagent route pin can resolve without any network or credentials.
  const providerExtensionPath = join(root, 'test-provider-extension.ts');
  await writeFile(
    providerExtensionPath,
    `export default function testProviderExtension(pi) {
  pi.registerProvider('test-provider', {
    name: 'Test Provider',
    api: 'openai-responses',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'test-key',
    models: [
      {
        id: 'test-model',
        name: 'Test Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  });
}
`,
  );
  const bus = createEventBus();
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [...extensionPaths, providerExtensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    eventBus: bus,
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
  sessions.push(session);
  // Pi's SDK does not fire session_start during createAgentSession; the source
  // repository's SDK tests emit it explicitly, and so do we.
  await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
  return { session, cwd, bus };
}

interface BgStatusResult {
  content: Array<{ type: string; text?: string }>;
  details: { tasks?: Array<Record<string, unknown>> };
}

async function bgStatus(session: AgentSession): Promise<Array<Record<string, unknown>>> {
  const tool = session.getToolDefinition('bg_status');
  if (tool === undefined) throw new Error('real background-tasks extension did not load bg_status');
  const result = (await tool.execute(
    'call-bg-status',
    {},
    undefined,
    undefined,
    session.extensionRunner.createContext(),
  )) as BgStatusResult;
  return result.details.tasks ?? [];
}

const SUBAGENT_TOOLS = [
  SUBAGENT_RUN_TOOL_NAME,
  SUBAGENT_RESULT_TOOL_NAME,
  SUBAGENT_RUN_ATTESTED_TOOL_NAME,
];

describe('real pi-background-tasks service', () => {
  it('with the real service present, the entrypoint registers exactly the three tools', async () => {
    const { session } = await sdkHarness([backgroundExtensionPath, subagentExtensionPath]);
    const active = session.getActiveToolNames();
    for (const name of SUBAGENT_TOOLS) {
      expect(active, `expected ${name} to be active`).toContain(name);
    }
    // The package contributes exactly those three tools: everything else that
    // is active belongs to the real background-tasks lifecycle surface.
    expect(session.getToolDefinition(SUBAGENT_RUN_TOOL_NAME)).toBeDefined();
    expect(active).toContain('bg_run');
    expect(active).toContain('bg_status');
  });

  it('without the service, load reports loudly and registers no tools', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      const { session } = await sdkHarness([subagentExtensionPath]);
      const active = session.getActiveToolNames();
      for (const name of SUBAGENT_TOOLS) {
        expect(active).not.toContain(name);
      }
    } finally {
      console.error = original;
    }
    expect(
      errors.some((line) => line.includes('[pi-subagent]') && line.includes('pi-background-tasks')),
    ).toBe(true);
  });

  it('drives a full subagent run through the one real registry, alongside a second owner', async () => {
    const { session, cwd, bus } = await sdkHarness([backgroundExtensionPath]);

    // The real entrypoint code, connected to the same session bus, with the
    // child process scripted (no real provider call). Everything between —
    // handshake, register, log, cancel routing, settle — is the real service.
    const localBus = bus as unknown as MemoryEventBus;
    const pi = new StubPi(localBus);
    const { spawn, fake } = makeFakeSpawn();
    const extension = createSubagentExtension({
      spawn,
      killProcess: () => true,
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
      connectOptions: { timeoutMs: 500, graceMs: 20, ownerTag: 'integration' },
      logger: { error: () => undefined },
    });
    extension(pi as never);
    const ctx = session.extensionRunner.createContext();
    await pi.emitSessionEvent('session_start', ctx);
    expect([...pi.tools.keys()].sort()).toEqual([
      SUBAGENT_RESULT_TOOL_NAME,
      SUBAGENT_RUN_TOOL_NAME,
      SUBAGENT_RUN_ATTESTED_TOOL_NAME,
    ]);

    const runTool = pi.tools.get(SUBAGENT_RUN_TOOL_NAME);
    if (runTool === undefined) throw new Error('missing subagent_run');
    const receipt = await runTool.execute(
      'call-run-1',
      {
        name: 'Integration probe',
        prompt: 'Investigate the thing',
        route: { provider: 'test-provider', model: 'test-model' },
      } as never,
      undefined,
      undefined,
      ctx,
    );
    const details = receipt.details ?? {};
    const subagentTaskId = details['task_id'] as string;
    expect(subagentTaskId).toMatch(/^s[0-9a-f]{32}$/);

    // (a) the managed external task appears in the one real registry.
    const duringRun = await bgStatus(session);
    const entry = duringRun.find((task) => {
      const owner = task['owner'] as { id: string; ref: string } | undefined;
      return owner?.ref === subagentTaskId;
    });
    expect(entry, 'subagent external task should appear in the real registry').toBeDefined();
    expect((entry?.['owner'] as { id: string }).id).toContain('pi-subagent:integration');
    expect(entry?.['status']).toBe('running');

    // (c) a second owner (the future fusion owner) coexists in the same service.
    const fusionOwner = await SubagentBackgroundClient.connect(bus, {
      timeoutMs: 500,
      graceMs: 20,
      ownerTag: 'fusion-sim',
    });
    const fusionRegistration = await fusionOwner.register({
      ownerRef: 'f'.padEnd(33, '0'),
      name: 'Simulated fusion workflow',
      cancellable: true,
      rerunnable: false,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
    });
    const both = await bgStatus(session);
    const owners = both
      .map((task) => (task['owner'] as { id: string; ref: string } | undefined)?.ref)
      .filter((ref) => ref !== undefined);
    expect(owners).toContain(subagentTaskId);
    expect(owners).toContain('f'.padEnd(33, '0'));

    // The scripted child commits its verified package and exits cleanly.
    const artifactDirAbs = join(cwd, details['artifact_dir'] as string);
    const pkg = buildSubagentResultPackage({
      taskId: subagentTaskId,
      launchNonce: details['launch_nonce'] as string,
      seedSha256: details['seed_sha256'] as string,
      directiveSha256: createHash('sha256')
        .update(Buffer.from('Investigate the thing', 'utf8'))
        .digest('hex'),
      route: { provider: 'test-provider', model: 'test-model' },
      routeAttestations: [{ provider: 'test-provider', model: 'test-model', stop_reason: 'stop' }],
      stopReason: 'stop',
      turns: 1,
      toolCalls: 0,
      usage: {
        status: 'observed',
        usage: {
          input: 3,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      answerBlocks: ['integration verified answer'],
      spilledArtifacts: [],
    });
    await writeFileDurable(
      join(artifactDirAbs, 'result.json'),
      serializeSubagentResultPackage(pkg),
    );
    fake.children[0]?.emitStdout('child ran\n');
    fake.children[0]?.close(0);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));

    const afterRun = await bgStatus(session);
    const settled = afterRun.find((task) => task['id'] === entry?.['id']);
    expect(settled?.['status']).toBe('completed');

    // Retrieval goes through the verified data plane.
    const resultTool = pi.tools.get(SUBAGENT_RESULT_TOOL_NAME);
    if (resultTool === undefined) throw new Error('missing subagent_result');
    const result = await resultTool.execute(
      'call-result-1',
      { taskId: subagentTaskId } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(result.details?.['state']).toBe('committed');
    expect(result.content[0]?.text).toContain('integration verified answer');

    await fusionOwner.settle(
      fusionRegistration.task.id,
      fusionRegistration.nextSequence,
      'completed',
    );
  }, 30_000);
});
