import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ParentContextSource } from '@sakiko233/pi-agent-runtime';
import { afterAll, describe, expect, it } from 'vitest';
import {
  evaluateSubagentRuntimeBudget,
  resolveSubagentLimits,
  SUBAGENT_FINALIZATION_INPUT_RESERVE_TOKENS,
  SUBAGENT_FINALIZATION_TRIGGER_TOKENS,
} from '../extensions/budget.js';
import { verifySubagentResultPackage } from '../extensions/result-package.js';
import { buildSubagentSeed } from '../extensions/seed.js';
import childExtension, {
  encodeSubagentToolResultContent,
  readSubagentUsage,
} from '../extensions/subagent-child.js';
import type { SubagentPinnedRoute, SubagentSpillReceipt } from '../extensions/types.js';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const route: SubagentPinnedRoute = {
  provider: 'test-provider',
  model: 'test-model',
  qualified_id: 'test-provider/test-model',
  context_window_tokens: 200_000,
  thinking_level: 'medium',
  origin: 'parent_current',
};

function parentContext(): ParentContextSource {
  const entries: SessionEntry[] = [
    {
      id: 'e1',
      parentId: null,
      type: 'message',
      message: { role: 'user', content: 'parent context' },
    } as unknown as SessionEntry,
  ];
  return {
    cwd: '/tmp/project',
    getSystemPrompt: () => 'parent system prompt',
    sessionManager: {
      getLeafId: () => 'e1',
      getLeafEntry: () => entries[0],
      getEntries: () => entries,
    },
  };
}

interface RecordedTool {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

interface RecordedHook {
  event: string;
  handler: (event: never, ctx: never) => unknown;
}

interface ChildHarness {
  artifactDirAbs: string;
  seedSha256: string;
  taskId: string;
  launchNonce: string;
  tools: Map<string, RecordedTool>;
  hooks: Map<string, RecordedHook>;
  activeTools: string[][];
  pi: ExtensionAPI;
}

async function childHarness(
  overrides: {
    capability?: 'inspect';
    extensionMode?: 'isolated' | 'ambient';
    limits?: Partial<ReturnType<typeof resolveSubagentLimits>>;
  } = {},
): Promise<ChildHarness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagent-child-'));
  roots.push(root);
  const artifactDirAbs = join(root, 'artifacts');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(artifactDirAbs, { recursive: true });
  const built = buildSubagentSeed(parentContext(), {
    taskId: `s${'a'.repeat(32)}`,
    launchNonce: 'n'.repeat(32),
    toolCallId: 'call-1',
    directive: 'answer with the word banana',
    capability: overrides.capability ?? 'inspect',
    extensionMode: overrides.extensionMode ?? 'isolated',
    route,
    limits: { ...resolveSubagentLimits(route), ...overrides.limits },
  });
  const seedPath = join(root, 'seed.json');
  await writeFile(seedPath, built.serialized, 'utf8');
  const tools = new Map<string, RecordedTool>();
  const hooks = new Map<string, RecordedHook>();
  const activeTools: string[][] = [];
  const pi = {
    registerTool: (definition: { name: string; execute: (id: string, p: unknown) => unknown }) => {
      tools.set(definition.name, {
        name: definition.name,
        execute: definition.execute as RecordedTool['execute'],
      });
    },
    on: (event: string, handler: (event: never, ctx: never) => unknown) => {
      hooks.set(event, { event, handler });
    },
    setActiveTools: (names: string[]) => {
      activeTools.push(names);
    },
  } as unknown as ExtensionAPI;

  const previousEnv = { ...process.env };
  process.env['PI_SUBAGENT_ARTIFACT_DIR'] = artifactDirAbs;
  process.env['PI_SUBAGENT_SEED_PATH'] = seedPath;
  process.env['PI_SUBAGENT_SEED_SHA256'] = built.sha256;
  process.env['PI_SUBAGENT_TASK_ID'] = built.seed.task_id;
  process.env['PI_SUBAGENT_LAUNCH_NONCE'] = built.seed.launch_nonce;
  try {
    childExtension(pi);
  } finally {
    for (const key of [
      'PI_SUBAGENT_ARTIFACT_DIR',
      'PI_SUBAGENT_SEED_PATH',
      'PI_SUBAGENT_SEED_SHA256',
      'PI_SUBAGENT_TASK_ID',
      'PI_SUBAGENT_LAUNCH_NONCE',
    ]) {
      const restore = previousEnv[key];
      if (restore === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = restore;
    }
  }
  return {
    artifactDirAbs,
    seedSha256: built.sha256,
    taskId: built.seed.task_id,
    launchNonce: built.seed.launch_nonce,
    tools,
    hooks,
    activeTools,
    pi,
  };
}

function fireHook(h: ChildHarness, event: string, payload: unknown, ctx: unknown): unknown {
  const hook = h.hooks.get(event);
  if (hook === undefined) throw new Error(`hook ${event} not registered`);
  return hook.handler(payload as never, ctx as never);
}

function fakeCtx(): { getSystemPrompt: () => string; abort: () => void } {
  return {
    getSystemPrompt: () => 'child system prompt',
    abort: () => undefined,
  };
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: 'assistant',
    provider: route.provider,
    model: route.model,
    stopReason: 'stop',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    },
    content: [{ type: 'text', text: 'banana answer' }],
    ...overrides,
  };
}

describe('subagent child guard', () => {
  it('loads with contract env vars and registers exactly the artifact reader', async () => {
    const h = await childHarness();
    expect([...h.tools.keys()]).toEqual(['subagent_read_artifact']);
  });

  it('refuses to load without its contract env vars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-subagent-child-'));
    roots.push(root);
    const previous = process.env['PI_SUBAGENT_ARTIFACT_DIR'];
    Reflect.deleteProperty(process.env, 'PI_SUBAGENT_ARTIFACT_DIR');
    try {
      expect(() => childExtension({} as ExtensionAPI)).toThrow(/PI_SUBAGENT_ARTIFACT_DIR/);
    } finally {
      if (previous !== undefined) process.env['PI_SUBAGENT_ARTIFACT_DIR'] = previous;
    }
  });

  it('commits exactly one verified result package on agent_end', async () => {
    const h = await childHarness();
    fireHook(h, 'turn_start', undefined, undefined);
    fireHook(h, 'message_end', { message: assistantMessage() }, undefined);
    fireHook(h, 'agent_end', undefined, undefined);
    const raw = await readFile(join(h.artifactDirAbs, 'result.json'), 'utf8');
    const verified = verifySubagentResultPackage(raw, {
      taskId: h.taskId,
      launchNonce: h.launchNonce,
      seedSha256: h.seedSha256,
      route: { provider: route.provider, model: route.model },
    });
    expect(verified.answer).toBe('banana answer');
    expect(verified.package.usage.status).toBe('observed');
    expect(verified.package.usage.status === 'observed' && verified.package.usage.usage.input).toBe(
      100,
    );
  });

  it('latches terminal conditions and never commits a degraded run', async () => {
    const h = await childHarness();
    fireHook(h, 'turn_start', undefined, undefined);
    fireHook(h, 'message_end', { message: assistantMessage({ stopReason: 'length' }) }, undefined);
    fireHook(h, 'agent_end', undefined, undefined);
    const terminal = JSON.parse(
      await readFile(join(h.artifactDirAbs, 'child-terminal.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(terminal['schema_version']).toBe('pi-subagent.child-terminal.v1');
    expect(terminal['code']).toBe('child_model_output_limit');
    await expect(readFile(join(h.artifactDirAbs, 'result.json'), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('latches route mismatch and refuses to commit', async () => {
    const h = await childHarness();
    fireHook(h, 'turn_start', undefined, undefined);
    fireHook(
      h,
      'message_end',
      { message: assistantMessage({ provider: 'someone-else', model: 'other' }) },
      undefined,
    );
    fireHook(h, 'agent_end', undefined, undefined);
    const terminal = JSON.parse(
      await readFile(join(h.artifactDirAbs, 'child-terminal.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(terminal['code']).toBe('route_mismatch');
  });

  it('spills oversized tool results and replaces them with hash-accounted receipts', async () => {
    const h = await childHarness();
    const bigPayload = 'x'.repeat(70_000);
    const replacement = fireHook(
      h,
      'tool_result',
      {
        toolName: 'read',
        toolCallId: 'call-big',
        content: [{ type: 'text', text: bigPayload }],
      },
      undefined,
    ) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    const receiptText = replacement.content[0]?.text ?? '';
    expect(receiptText).toContain('subagent spill receipt');
    expect(receiptText).toContain('spill/');
    expect(replacement.isError).toBeUndefined();
    const pkg = await committedPackage(h);
    expect(pkg.spilled_artifacts).toHaveLength(1);
    const receipt = pkg.spilled_artifacts[0] as SubagentSpillReceipt;
    expect(receipt.byte_length).toBe(Buffer.byteLength(bigPayload, 'utf8'));
    expect(receipt.content_format).toBe('single_text_utf8');
    expect(receipt.tool_name).toBe('read');
  });

  it('withholds payloads when the aggregate output cap is reached', async () => {
    const h = await childHarness({ limits: { max_total_tool_output_bytes: 100_000 } });
    fireHook(h, 'turn_start', undefined, undefined);
    const huge = 'y'.repeat(65_536);
    const first = fireHook(
      h,
      'tool_result',
      {
        toolName: 'read',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: huge }],
      },
      undefined,
    ) as { isError?: boolean };
    const second = fireHook(
      h,
      'tool_result',
      {
        toolName: 'read',
        toolCallId: 'call-2',
        content: [{ type: 'text', text: huge }],
      },
      undefined,
    ) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toContain('aggregate raw-output cap');
  });

  it('blocks tool calls once finalization runway is active', async () => {
    const h = await childHarness();
    const allowed = resolveSubagentLimits(route).allowed_input_tokens;
    const nearLimit = 'z'.repeat(allowed * 2);
    fireHook(h, 'context', { messages: [{ role: 'user', content: nearLimit }] }, fakeCtx());
    const blocked = fireHook(h, 'tool_call', {}, fakeCtx()) as { block: boolean; reason: string };
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain('final-answer runway');
    expect(h.activeTools.at(-1)).toEqual([]);
  });

  it('measures retained context and requests finalization near the allowance', async () => {
    const h = await childHarness();
    const allowed = resolveSubagentLimits(route).allowed_input_tokens;
    const nearLimit = 'z'.repeat((allowed - SUBAGENT_FINALIZATION_TRIGGER_TOKENS) * 2);
    const result = fireHook(h, 'context', { messages: [] }, fakeCtx()) as
      | { messages: unknown[] }
      | undefined;
    expect(result).toBeUndefined();
    const pressured = fireHook(
      h,
      'context',
      { messages: [{ role: 'user', content: nearLimit }] },
      fakeCtx(),
    ) as { messages: unknown[] };
    const last = pressured.messages.at(-1) as { content: string };
    expect(last.content).toContain('subagent finalization runway');
  });

  it('records a runtime-budget evidence file on first measurement', async () => {
    const h = await childHarness();
    fireHook(h, 'context', { messages: [] }, fakeCtx());
    fireHook(h, 'turn_start', undefined, undefined);
    fireHook(h, 'message_end', { message: assistantMessage() }, undefined);
    fireHook(h, 'agent_end', undefined, undefined);
    const raw = await readFile(join(h.artifactDirAbs, 'runtime-budget.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe('pi-subagent.runtime-budget.v1');
    expect(parsed['retained_growth_budget_tokens']).not.toBeNull();
  });
});

async function committedPackage(h: ChildHarness) {
  fireHook(h, 'turn_start', undefined, undefined);
  fireHook(h, 'message_end', { message: assistantMessage() }, undefined);
  fireHook(h, 'agent_end', undefined, undefined);
  const raw = await readFile(join(h.artifactDirAbs, 'result.json'), 'utf8');
  const verified = verifySubagentResultPackage(raw, {
    taskId: h.taskId,
    launchNonce: h.launchNonce,
    seedSha256: h.seedSha256,
    route: { provider: route.provider, model: route.model },
  });
  return verified.package;
}

describe('subagent child helpers', () => {
  it('encodes single-text and multi-block tool results in closed envelopes', () => {
    const single = encodeSubagentToolResultContent([{ type: 'text', text: 'plain' }]);
    expect(single.contentFormat).toBe('single_text_utf8');
    expect(single.payload.toString('utf8')).toBe('plain');
    const multi = encodeSubagentToolResultContent([
      { type: 'text', text: 'a' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
    ]);
    expect(multi.contentFormat).toBe('tool_result_content_json_v1');
    const parsed = JSON.parse(multi.payload.toString('utf8')) as Record<string, unknown>;
    expect(parsed['schema_version']).toBe('pi-subagent.tool-result-content.v1');
    expect(() => encodeSubagentToolResultContent([{ type: 'weird' } as never])).toThrow(
      /unsupported or malformed/,
    );
  });

  it('treats a partial usage record as no usage at all', () => {
    expect(readSubagentUsage(undefined)).toBeUndefined();
    expect(readSubagentUsage({ input: 1 })).toBeUndefined();
    expect(readSubagentUsage({ input: 1, cost: {} })).toBeUndefined();
    expect(
      readSubagentUsage({
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBeDefined();
  });

  it('derives retained-growth policy constants consistently with the budget module', () => {
    expect(SUBAGENT_FINALIZATION_INPUT_RESERVE_TOKENS).toBe(32 * 1024);
    expect(SUBAGENT_FINALIZATION_TRIGGER_TOKENS).toBe(8 * 1024);
    const verdict = evaluateSubagentRuntimeBudget(
      {
        retainedInputBytes: 1000,
        retainedInputMultibyteBytes: 0,
        retainedInputDenseBytes: 0,
        retainedInputAsciiWhitespaceBytes: 100,
      },
      10_000,
      { provider: route.provider, model: route.model },
    );
    expect(verdict.measuredTokens).toBeGreaterThan(0);
  });
});
