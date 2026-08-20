import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { ParentContextSource } from '@sakiko233/pi-agent-runtime';
import { writeFileDurable } from '@sakiko233/pi-agent-runtime';
import {
  buildSubagentResultPackage,
  serializeSubagentResultPackage,
} from '../extensions/result-package.js';
import { createSubagentExtension } from '../extensions/subagent.js';
import {
  SUBAGENT_LAUNCH_DETAILS_SCHEMA_VERSION,
  SUBAGENT_RESULT_TOOL_NAME,
  SUBAGENT_RESULT_VIEW_SCHEMA_VERSION,
  SUBAGENT_RUN_ATTESTED_TOOL_NAME,
  SUBAGENT_RUN_TOOL_NAME,
  SubagentError,
  type SubagentPinnedRoute,
} from '../extensions/types.js';
import { MemoryEventBus, makeFakeSpawn, StubService } from './helpers/fakes.js';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const model = { provider: 'test-provider', id: 'test-model', contextWindow: 200_000 };

interface CapturedTool {
  name: string;
  parameters: Record<string, unknown>;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: never,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
    usage?: unknown;
  }>;
}

class StubPi {
  readonly events = new MemoryEventBus();
  readonly tools = new Map<string, CapturedTool>();
  readonly sentMessages: Array<{ message: Record<string, unknown>; options: unknown }> = [];
  readonly notifications: Array<{ text: string; level: string }> = [];
  private readonly handlers = new Map<string, Array<(...args: never[]) => unknown>>();

  registerTool(definition: CapturedTool): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool ${definition.name} registered twice`);
    }
    this.tools.set(definition.name, definition);
  }

  on(event: string, handler: (...args: never[]) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  getThinkingLevel(): string {
    return 'medium';
  }

  sendMessage(message: Record<string, unknown>, options: unknown): void {
    this.sentMessages.push({ message, options });
  }

  async emitSessionEvent(event: 'session_start' | 'session_shutdown', ctx: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler({}, ctx as never);
    }
  }
}

function stubCtx(cwd: string, ui = false): ExtensionContext {
  const entries: SessionEntry[] = [
    {
      id: 'e1',
      parentId: null,
      type: 'message',
      message: { role: 'user', content: 'parent context' },
    } as unknown as SessionEntry,
  ];
  return {
    cwd,
    hasUI: ui,
    ui: {
      notify: (text: string, level: string) => {
        void text;
        void level;
      },
    },
    model,
    modelRegistry: {
      getAll: () => [model],
      find: (provider: string, modelId: string) =>
        provider === model.provider && modelId === model.id ? model : undefined,
      isUsingOAuth: () => true,
    },
    sessionManager: {
      getLeafId: () => 'e1',
      getLeafEntry: () => entries[0],
      getEntries: () => entries,
      getSessionId: () => 'parent-session',
    },
    getSystemPrompt: () => 'parent system prompt',
  } as unknown as ExtensionContext;
}

interface Harness {
  pi: StubPi;
  bus: MemoryEventBus;
  service: StubService | undefined;
  fake: ReturnType<typeof makeFakeSpawn>['fake'];
  start: (cwd: string) => Promise<void>;
  errors: string[];
}

function harness(withService: boolean): Harness {
  const bus = new MemoryEventBus();
  const service = withService ? new StubService(bus) : undefined;
  const { spawn, fake } = makeFakeSpawn();
  const pi = new StubPi();
  const errors: string[] = [];
  const extension = createSubagentExtension({
    spawn,
    killProcess: () => true,
    platform: 'linux',
    killGraceMs: 20,
    logFlushMs: 5,
    connectOptions: { timeoutMs: 60, graceMs: 5, ownerTag: 'entrypoint-test' },
    logger: {
      error: (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      },
    },
  });
  extension(pi as unknown as ExtensionAPI);
  return {
    pi,
    bus,
    service,
    fake,
    errors,
    start: async (cwd: string) => {
      await pi.emitSessionEvent('session_start', stubCtx(cwd));
    },
  };
}

async function tempCwd(prefix = 'pi-subagent-entry-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function commitChildResult(
  artifactDirAbs: string,
  identity: { taskId: string; launchNonce: string; seedSha256: string },
  answer: string,
): Promise<void> {
  const pkg = buildSubagentResultPackage({
    taskId: identity.taskId,
    launchNonce: identity.launchNonce,
    seedSha256: identity.seedSha256,
    directiveSha256: createHash('sha256').update(Buffer.from('Investigate the thing', 'utf8')).digest('hex'),
    route: { provider: model.provider, model: model.id },
    routeAttestations: [{ provider: model.provider, model: model.id, stop_reason: 'stop' }],
    stopReason: 'stop',
    turns: 2,
    toolCalls: 3,
    usage: {
      status: 'observed',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    answerBlocks: [answer],
    spilledArtifacts: [],
  });
  await writeFileDurable(join(artifactDirAbs, 'result.json'), serializeSubagentResultPackage(pkg));
}

describe('entrypoint startup gating', () => {
  it('registers none of the three tools when the service is absent', async () => {
    const h = harness(false);
    const cwd = await tempCwd();
    await h.start(cwd);
    expect(h.pi.tools.size).toBe(0);
    expect(h.errors.some((line) => line.includes('pi-background-tasks'))).toBe(true);
    expect(
      h.pi.sentMessages.some(
        (entry) =>
          typeof entry.message['content'] === 'string' &&
          (entry.message['content'] as string).includes('pi-background-tasks'),
      ),
    ).toBe(true);
  });

  it('registers none of the three tools when two services answer', async () => {
    const h = harness(true);
    new StubService(h.bus);
    const cwd = await tempCwd();
    await h.start(cwd);
    expect(h.pi.tools.size).toBe(0);
    expect(h.errors.some((line) => line.includes('exactly one'))).toBe(true);
  });

  it('registers exactly the three subagent tools after a clean handshake', async () => {
    const h = harness(true);
    const cwd = await tempCwd();
    await h.start(cwd);
    expect([...h.pi.tools.keys()].sort()).toEqual([
      SUBAGENT_RESULT_TOOL_NAME,
      SUBAGENT_RUN_TOOL_NAME,
      SUBAGENT_RUN_ATTESTED_TOOL_NAME,
    ]);
    for (const tool of h.pi.tools.values()) {
      expect(tool.parameters['additionalProperties']).toBe(false);
    }
    // A second session start re-handshakes without duplicating registration.
    await h.start(cwd);
    expect(h.pi.tools.size).toBe(3);
  });

  it('rejects unknown argument keys in every tool', async () => {
    const h = harness(true);
    await h.start(await tempCwd());
    for (const [name, args] of [
      [SUBAGENT_RUN_TOOL_NAME, { name: 'x', prompt: 'y', bogus: 1 }],
      [SUBAGENT_RESULT_TOOL_NAME, { taskId: 'x', bogus: 1 }],
      [
        SUBAGENT_RUN_ATTESTED_TOOL_NAME,
        { name: 'x', provider: 'p', model: 'm', prompt: 'q', reportPath: 'r.md', bogus: 1 },
      ],
    ] as const) {
      const tool = h.pi.tools.get(name);
      expect(tool).toBeDefined();
      expect(() => tool?.prepareArguments?.(args)).toThrow(/unsupported key/);
    }
  });
});

describe('subagent_run and subagent_result through the entrypoint', () => {
  it('launches, settles through the service, and retrieves the verified answer inline once', async () => {
    const h = harness(true);
    const cwd = await tempCwd();
    await h.start(cwd);
    const ctx = stubCtx(cwd);
    const runTool = h.pi.tools.get(SUBAGENT_RUN_TOOL_NAME);
    expect(runTool).toBeDefined();
    if (runTool === undefined) throw new Error('missing subagent_run');
    const receipt = await runTool.execute(
      'call-1',
      { name: 'Investigate thing', prompt: 'Investigate the thing' } as never,
      undefined,
      undefined,
      ctx,
    );
    const receiptText = receipt.content[0]?.text ?? '';
    expect(receiptText).toContain('subagent');
    const details = receipt.details ?? {};
    expect(details['schema_version']).toBe(SUBAGENT_LAUNCH_DETAILS_SCHEMA_VERSION);
    const subagentTaskId = details['task_id'];
    expect(typeof subagentTaskId).toBe('string');
    expect(subagentTaskId as string).toMatch(/^s[0-9a-f]{32}$/);
    const serviceTask = details['service_task'] as Record<string, unknown>;
    expect(typeof serviceTask['id']).toBe('string');
    expect(serviceTask['id']).not.toBe(subagentTaskId);

    // Running result view is a typed not-ready, never a block.
    const resultTool = h.pi.tools.get(SUBAGENT_RESULT_TOOL_NAME);
    if (resultTool === undefined) throw new Error('missing subagent_result');
    const running = await resultTool.execute(
      'call-2',
      { taskId: subagentTaskId } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(running.details?.['schema_version']).toBe(SUBAGENT_RESULT_VIEW_SCHEMA_VERSION);
    expect(running.details?.['state']).toBe('running');
    expect(running.details?.['delivery']).toBe('none');
    expect(running.content[0]?.text).toContain('never blocks');

    // The child commits its verified package and exits.
    const artifactDir = details['artifact_dir'] as string;
    const identity = {
      taskId: subagentTaskId as string,
      launchNonce: details['launch_nonce'] as string,
      seedSha256: details['seed_sha256'] as string,
    };
    await commitChildResult(join(cwd, artifactDir), identity, 'the verified answer');
    h.fake.children[0]?.close(0);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const serviceTasks = [...(h.service?.tasks.values() ?? [])];
    expect(serviceTasks).toHaveLength(1);
    expect(serviceTasks[0]?.status).toBe('completed');

    const first = await resultTool.execute(
      'call-3',
      { taskId: subagentTaskId } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(first.details?.['state']).toBe('committed');
    expect(first.details?.['delivery']).toBe('inline');
    expect(first.details?.['answer_sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(first.content[0]?.text).toContain('the verified answer');
    expect(first.usage).toBeDefined();

    const second = await resultTool.execute(
      'call-4',
      { taskId: subagentTaskId } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(second.content[0]?.text).toContain('the verified answer');
    expect(second.usage).toBeUndefined();
    expect(second.details?.['usage_delivered']).toBe(false);
  });

  it('fails loudly when inline delivery is requested for an oversized answer', async () => {
    const h = harness(true);
    const cwd = await tempCwd();
    await h.start(cwd);
    const ctx = stubCtx(cwd);
    const runTool = h.pi.tools.get(SUBAGENT_RUN_TOOL_NAME);
    if (runTool === undefined) throw new Error('missing subagent_run');
    const receipt = await runTool.execute(
      'call-1',
      { name: 'Big answer', prompt: 'Investigate the thing' } as never,
      undefined,
      undefined,
      ctx,
    );
    const details = receipt.details ?? {};
    const identity = {
      taskId: details['task_id'] as string,
      launchNonce: details['launch_nonce'] as string,
      seedSha256: details['seed_sha256'] as string,
    };
    const oversized = 'x'.repeat(49 * 1024);
    await commitChildResult(join(cwd, details['artifact_dir'] as string), identity, oversized);
    h.fake.children[0]?.close(0);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const resultTool = h.pi.tools.get(SUBAGENT_RESULT_TOOL_NAME);
    if (resultTool === undefined) throw new Error('missing subagent_result');
    await expect(
      resultTool.execute(
        'call-2',
        { taskId: identity.taskId, delivery: 'inline' } as never,
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'result_too_large_for_inline' });
    const artifactView = await resultTool.execute(
      'call-3',
      { taskId: identity.taskId } as never,
      undefined,
      undefined,
      ctx,
    );
    expect(artifactView.details?.['delivery']).toBe('artifact');
    expect(artifactView.content[0]?.text).not.toContain(oversized);
  });

  it('rejects an unknown task id with the typed task_unknown error', async () => {
    const h = harness(true);
    const cwd = await tempCwd();
    await h.start(cwd);
    const resultTool = h.pi.tools.get(SUBAGENT_RESULT_TOOL_NAME);
    if (resultTool === undefined) throw new Error('missing subagent_result');
    await expect(
      resultTool.execute(
        'call-9',
        { taskId: 's'.concat('0'.repeat(32)) } as never,
        undefined,
        undefined,
        stubCtx(cwd),
      ),
    ).rejects.toMatchObject({ code: 'task_unknown' });
  });

  it('kills running children and settles killed on session shutdown', async () => {
    const h = harness(true);
    const cwd = await tempCwd();
    await h.start(cwd);
    const ctx = stubCtx(cwd);
    const runTool = h.pi.tools.get(SUBAGENT_RUN_TOOL_NAME);
    if (runTool === undefined) throw new Error('missing subagent_run');
    const receipt = await runTool.execute(
      'call-1',
      { name: 'Shutdown run', prompt: 'Investigate the thing' } as never,
      undefined,
      undefined,
      ctx,
    );
    const details = receipt.details ?? {};
    const shutdown = h.pi.emitSessionEvent('session_shutdown', ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.fake.children[0]?.close(null, 'SIGTERM');
    await shutdown;
    const serviceTask = [...(h.service?.tasks.values() ?? [])][0];
    expect(serviceTask?.status).toBe('killed');
    expect(details['task_id']).toMatch(/^s[0-9a-f]{32}$/);
  });
});

describe('subagent_run_attested through the entrypoint', () => {
  it('launches one attested child and returns the evidence receipt', async () => {
    const cwd = await tempCwd('pi-subagent-entry-git-');
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
    await writeFile(join(cwd, '.gitignore'), '.pi/\nreport.md\n');
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd });

    const h = harness(true);
    await h.start(cwd);
    const ctx = stubCtx(cwd);
    const tool = h.pi.tools.get(SUBAGENT_RUN_ATTESTED_TOOL_NAME);
    if (tool === undefined) throw new Error('missing subagent_run_attested');
    const receipt = await tool.execute(
      'call-1',
      {
        name: 'Attested probe',
        provider: 'test-provider',
        model: 'test-model',
        prompt: 'Write the report file, then stop.',
        reportPath: 'report.md',
      } as never,
      undefined,
      undefined,
      ctx,
    );
    const text = receipt.content[0]?.text ?? '';
    expect(text).toContain('Attested');
    expect(text).toMatch(/\(a[0-9a-f]{32}\)/);
    expect(text).toContain('.pi/subagent/attested/');
    expect(receipt.details?.['schema_version']).toBe('pi-subagent.attested-launch.v1');

    // Unsupported OAuth providers refuse before spawning.
    await expect(
      tool.execute(
        'call-2',
        {
          name: 'Bad provider',
          provider: 'deepseek',
          model: 'r1',
          prompt: 'x',
          reportPath: 'report.md',
        } as never,
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/Unsupported|not found/);
    expect(h.fake.calls).toHaveLength(1);
  });
});
