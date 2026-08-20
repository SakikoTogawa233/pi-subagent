import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ParentContextSource } from '@sakiko233/pi-agent-runtime';
import { writeFileDurable } from '@sakiko233/pi-agent-runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { SubagentBackgroundClient } from '../extensions/background-client.js';
import { loadSubagentHookContractEvidence } from '../extensions/hook-contract.js';
import {
  buildSubagentResultPackage,
  serializeSubagentResultPackage,
} from '../extensions/result-package.js';
import {
  evaluateSubagentTerminal,
  type PreparedSubagentLaunch,
  type PrepareSubagentLaunchInput,
  prepareSubagentLaunch,
  SubagentRunSupervisor,
} from '../extensions/runner.js';
import {
  SUBAGENT_OUTCOME_SCHEMA_VERSION,
  SubagentError,
  type SubagentPinnedRoute,
} from '../extensions/types.js';
import { MemoryEventBus, makeFakeSpawn, StubService } from './helpers/fakes.js';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagent-runner-'));
  roots.push(dir);
  return dir;
}

const route: SubagentPinnedRoute = {
  provider: 'test-provider',
  model: 'test-model',
  qualified_id: 'test-provider/test-model',
  context_window_tokens: 200_000,
  thinking_level: 'medium',
  origin: 'parent_current',
};

function parentContext(cwd: string): ParentContextSource {
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
    getSystemPrompt: () => 'parent system prompt',
    sessionManager: {
      getLeafId: () => 'e1',
      getLeafEntry: () => entries[0],
      getEntries: () => entries,
    },
  };
}

const hookEvidence = loadSubagentHookContractEvidence(
  await readFile(
    fileURLToPath(new URL('../extensions/hook-contract-evidence.json', import.meta.url)),
    'utf8',
  ),
);

async function prepare(overrides: Partial<PrepareSubagentLaunchInput> = {}): Promise<{
  cwd: string;
  prepared: PreparedSubagentLaunch;
}> {
  const cwd = await tempCwd();
  const prepared = await prepareSubagentLaunch({
    ctx: parentContext(cwd),
    toolCallId: 'call-1',
    prompt: 'Investigate the thing',
    capability: 'inspect',
    extensionMode: 'isolated',
    route,
    limitOverrides: {},
    hookEvidence,
    cwd,
    sessionId: 'parent-session',
    autoDeliver: 'never',
    ...overrides,
  });
  return { cwd, prepared };
}

async function commitChildResult(prepared: PreparedSubagentLaunch, answer: string): Promise<void> {
  const pkg = buildSubagentResultPackage({
    taskId: prepared.preflight.taskId,
    launchNonce: prepared.preflight.launchNonce,
    seedSha256: prepared.preflight.seed.sha256,
    directiveSha256: prepared.preflight.seed.seed.directive.sha256,
    route: { provider: route.provider, model: route.model },
    routeAttestations: [{ provider: route.provider, model: route.model, stop_reason: 'stop' }],
    stopReason: 'stop',
    turns: 1,
    toolCalls: 0,
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
  await writeFileDurable(
    join(prepared.store.artifactDirAbs, 'result.json'),
    serializeSubagentResultPackage(pkg),
  );
}

async function connectClient(bus: MemoryEventBus): Promise<SubagentBackgroundClient> {
  return SubagentBackgroundClient.connect(bus, {
    timeoutMs: 300,
    graceMs: 5,
    ownerTag: 'runner-test',
  });
}

describe('prepareSubagentLaunch', () => {
  it('persists the seed, ledger, plan, and exact child prompt before any spawn', async () => {
    const { cwd, prepared } = await prepare();
    const dir = prepared.store.artifactDirAbs;
    expect(existsSync(join(dir, 'seed.json'))).toBe(true);
    expect(existsSync(join(dir, 'context-omission-ledger.json'))).toBe(true);
    expect(existsSync(join(dir, 'budget-plan.json'))).toBe(true);
    expect(existsSync(join(dir, 'child-prompt.txt'))).toBe(true);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(dir, 'spill'))).toBe(true);

    const persistedSeed = await readFile(join(dir, 'seed.json'), 'utf8');
    expect(persistedSeed).toBe(prepared.preflight.seed.serialized);
    const persistedPrompt = await readFile(join(dir, 'child-prompt.txt'));
    expect(persistedPrompt.equals(prepared.stdinBytes)).toBe(true);

    expect(prepared.argv).toContain('--mode');
    expect(prepared.argv).toContain('--provider');
    expect(prepared.argv).toContain('test-provider');
    expect(prepared.argv).toContain(prepared.preflight.childSessionId);
    expect(prepared.env['PI_SUBAGENT_SEED_SHA256']).toBe(prepared.preflight.seed.sha256);
    expect(prepared.env['PI_SUBAGENT_TASK_ID']).toBe(prepared.preflight.taskId);
    expect(prepared.facts.route.qualifiedId).toBe('test-provider/test-model');
    expect(prepared.facts.artifactDirAbs).toBe(dir);
    expect(prepared.store.snapshot().state).toBe('launched');
    expect(cwd).toBe(prepared.store.snapshot().cwd);
  });

  it('refuses an under-capacity route with zero artifacts on disk', async () => {
    const cwd = await tempCwd();
    const tinyRoute: SubagentPinnedRoute = { ...route, context_window_tokens: 4096 };
    const failure = await prepareSubagentLaunch({
      ctx: parentContext(cwd),
      toolCallId: 'call-1',
      prompt: 'Investigate the thing',
      capability: 'inspect',
      extensionMode: 'isolated',
      route: tinyRoute,
      limitOverrides: {},
      hookEvidence,
      cwd,
      sessionId: 'parent-session',
      autoDeliver: 'never',
    }).then(
      () => {
        throw new Error('expected prepare to refuse');
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SubagentError);
    expect((failure as SubagentError).code).toBe('route_capacity_unknown');
    expect((failure as SubagentError).childCreated).toBe(false);
    expect(existsSync(join(cwd, '.pi'))).toBe(false);
  });
});

describe('evaluateSubagentTerminal', () => {
  it('adjudicates a committed package and records the outcome artifact', async () => {
    const { prepared } = await prepare();
    await commitChildResult(prepared, 'the verified answer');
    const evaluation = await evaluateSubagentTerminal({
      artifactDirAbs: prepared.store.artifactDirAbs,
      taskId: prepared.preflight.taskId,
      launchNonce: prepared.preflight.launchNonce,
      seedSha256: prepared.preflight.seed.sha256,
      route: { provider: route.provider, model: route.model },
      runStatus: 'completed',
      runError: undefined,
    });
    expect(evaluation.error).toBeUndefined();
    expect(evaluation.outcome.status).toBe('committed');
    expect(evaluation.outcome.answerSha256).toBe(evaluation.result?.package.answer.sha256);
    expect(evaluation.result?.answer).toBe('the verified answer');
    const outcomeRaw = JSON.parse(
      await readFile(join(prepared.store.artifactDirAbs, 'outcome.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(outcomeRaw['schema_version']).toBe(SUBAGENT_OUTCOME_SCHEMA_VERSION);
    expect(outcomeRaw['observed_run_status']).toBe('completed');
  });

  it('adjudicates a missing package with a child terminal record as the typed child failure', async () => {
    const { prepared } = await prepare();
    await writeFileDurable(
      join(prepared.store.artifactDirAbs, 'child-terminal.json'),
      `${JSON.stringify({
        schema_version: 'pi-subagent.child-terminal.v1',
        task_id: prepared.preflight.taskId,
        launch_nonce: prepared.preflight.launchNonce,
        code: 'child_turn_limit',
        message: 'the subagent child exceeded its turn limit',
        turns: 25,
        tool_calls: 40,
        spilled_artifacts: [],
      })}\n`,
    );
    const evaluation = await evaluateSubagentTerminal({
      artifactDirAbs: prepared.store.artifactDirAbs,
      taskId: prepared.preflight.taskId,
      launchNonce: prepared.preflight.launchNonce,
      seedSha256: prepared.preflight.seed.sha256,
      route: { provider: route.provider, model: route.model },
      runStatus: 'completed',
      runError: undefined,
    });
    expect(evaluation.result).toBeUndefined();
    expect(evaluation.outcome.status).toBe('failed');
    expect(evaluation.error?.code).toBe('child_turn_limit');
    expect(evaluation.error?.message).toContain('turn limit');
  });

  it('adjudicates a killed run without a package as cancelled', async () => {
    const { prepared } = await prepare();
    const evaluation = await evaluateSubagentTerminal({
      artifactDirAbs: prepared.store.artifactDirAbs,
      taskId: prepared.preflight.taskId,
      launchNonce: prepared.preflight.launchNonce,
      seedSha256: prepared.preflight.seed.sha256,
      route: { provider: route.provider, model: route.model },
      runStatus: 'killed',
      runError: 'Cancellation requested',
    });
    expect(evaluation.outcome.status).toBe('cancelled');
    expect(evaluation.error?.code).toBe('child_cancelled');
  });

  it('rejects a tampered package with a hash failure and never returns its bytes', async () => {
    const { prepared } = await prepare();
    await commitChildResult(prepared, 'the verified answer');
    const resultPath = join(prepared.store.artifactDirAbs, 'result.json');
    const raw = await readFile(resultPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      answer: { blocks: Array<{ data_base64: string }> };
    };
    const block = parsed.answer.blocks[0];
    if (block === undefined) throw new Error('expected one answer block');
    const original = Buffer.from(block.data_base64, 'base64');
    const flipped = Buffer.from(original);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    block.data_base64 = flipped.toString('base64');
    await writeFileDurable(resultPath, JSON.stringify(parsed));
    const evaluation = await evaluateSubagentTerminal({
      artifactDirAbs: prepared.store.artifactDirAbs,
      taskId: prepared.preflight.taskId,
      launchNonce: prepared.preflight.launchNonce,
      seedSha256: prepared.preflight.seed.sha256,
      route: { provider: route.provider, model: route.model },
      runStatus: 'completed',
      runError: undefined,
    });
    expect(evaluation.result).toBeUndefined();
    expect(evaluation.error?.code).toBe('answer_hash_mismatch');
    expect(evaluation.outcome.status).toBe('failed');
  });

  it('treats a clean exit without a commit as a typed no-commit failure', async () => {
    const { prepared } = await prepare();
    const evaluation = await evaluateSubagentTerminal({
      artifactDirAbs: prepared.store.artifactDirAbs,
      taskId: prepared.preflight.taskId,
      launchNonce: prepared.preflight.launchNonce,
      seedSha256: prepared.preflight.seed.sha256,
      route: { provider: route.provider, model: route.model },
      runStatus: 'completed',
      runError: undefined,
    });
    expect(evaluation.error?.code).toBe('child_exited_without_commit');
    expect(evaluation.outcome.status).toBe('failed');
    expect(evaluation.error?.preserved).toContain('seed.json');
  });
});

describe('SubagentRunSupervisor', () => {
  it('registers, spawns, streams logs, and settles completed with a committed result', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const groupKills: Array<[number, string | undefined]> = [];
    const supervisor = new SubagentRunSupervisor({
      client,
      spawn,
      killProcess: (pid, signal) => {
        groupKills.push([pid, signal as string | undefined]);
        return true;
      },
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
    });
    const { prepared } = await prepare();
    const record = await supervisor.start({
      prepared,
      name: 'Investigate thing',
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    });
    expect(record.state).toBe('running');
    expect(record.facts.taskId).toBe(prepared.preflight.taskId);
    // The service-allocated task carries the subagent task id as its owner ref.
    const serviceTask = service.tasks.get(record.serviceTaskId);
    expect(serviceTask?.ownerRef).toBe(prepared.preflight.taskId);
    expect(serviceTask?.status).toBe('running');

    const call = fake.calls[0];
    expect(call?.args).toContain('test-provider');
    expect(call?.options.env?.['PI_SUBAGENT_TASK_ID']).toBe(prepared.preflight.taskId);

    const child = fake.children[0];
    child?.emitStdout('reading files\n');
    await commitChildResult(prepared, 'the verified answer');
    child?.close(0);
    const settled = await supervisor.whenSettled(record.facts.taskId);
    expect(settled.state).toBe('committed');
    expect(settled.outcome?.status).toBe('committed');
    expect(service.tasks.get(record.serviceTaskId)?.status).toBe('completed');
    expect(service.tasks.get(record.serviceTaskId)?.logs.join('\n')).toContain('reading files');
    expect(groupKills).toHaveLength(0);
  });

  it('settles failed with a typed error when the child exits without committing', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const supervisor = new SubagentRunSupervisor({
      client,
      spawn,
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
    });
    const { prepared } = await prepare();
    const record = await supervisor.start({
      prepared,
      name: 'Doomed run',
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    });
    fake.children[0]?.close(0);
    const settled = await supervisor.whenSettled(record.facts.taskId);
    expect(settled.state).toBe('failed');
    expect(settled.outcome?.errorCode).toBe('child_exited_without_commit');
    const serviceTask = service.tasks.get(record.serviceTaskId);
    expect(serviceTask?.status).toBe('failed');
    expect(serviceTask?.error).toContain('child_exited_without_commit');
  });

  it('routes cancellation: aborts the child group, acks, then settles killed', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const groupKills: Array<[number, string | undefined]> = [];
    const supervisor = new SubagentRunSupervisor({
      client,
      spawn,
      killProcess: (pid, signal) => {
        groupKills.push([pid, signal as string | undefined]);
        return true;
      },
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
    });
    const { prepared } = await prepare();
    const record = await supervisor.start({
      prepared,
      name: 'Cancellable run',
      notifyOnCompletion: true,
      triggerOnCompletion: false,
    });
    const cancelId = service.publishCancellation(record.serviceTaskId, 'user asked to stop');
    expect(groupKills).toEqual([[-4242, 'SIGTERM']]);
    fake.children[0]?.close(null, 'SIGTERM');
    const settled = await supervisor.whenSettled(record.facts.taskId);
    expect(settled.state).toBe('cancelled');
    const ops = service.operationsFor(record.serviceTaskId);
    const ackIndex = ops.indexOf('cancel_ack');
    const settleIndex = ops.indexOf('settle');
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(settleIndex).toBeGreaterThan(ackIndex);
    const ackFrame = service.frames.find((frame) => frame.operation === 'cancel_ack');
    expect(ackFrame?.payload?.['cancel_id']).toBe(cancelId);
    expect(service.tasks.get(record.serviceTaskId)?.status).toBe('killed');
  });

  it('kills the child on timeout and settles failed', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const groupKills: Array<[number, string | undefined]> = [];
    const supervisor = new SubagentRunSupervisor({
      client,
      spawn,
      killProcess: (pid, signal) => {
        groupKills.push([pid, signal as string | undefined]);
        return true;
      },
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
      timeoutOverrideMs: 30,
    });
    const { prepared } = await prepare();
    const record = await supervisor.start({
      prepared,
      name: 'Slow run',
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(groupKills[0]).toEqual([-4242, 'SIGTERM']);
    fake.children[0]?.close(null, 'SIGTERM');
    const settled = await supervisor.whenSettled(record.facts.taskId);
    expect(settled.state).toBe('failed');
    expect(settled.outcome?.errorCode).toBe('child_timeout');
    expect(service.tasks.get(record.serviceTaskId)?.status).toBe('failed');
    expect(service.tasks.get(record.serviceTaskId)?.error).toContain('child_timeout');
  });

  it('discards artifacts and never spawns when the service rejects registration', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    service.rejectOperations.add('register');
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const supervisor = new SubagentRunSupervisor({
      client,
      spawn,
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
    });
    const { prepared } = await prepare();
    const artifactDirAbs = prepared.store.artifactDirAbs;
    await expect(
      supervisor.start({
        prepared,
        name: 'Rejected run',
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      }),
    ).rejects.toMatchObject({ name: 'BackgroundServiceError', code: 'request_failed' });
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(artifactDirAbs)).toBe(false);
  });

  it('settles failed and preserves artifacts when the spawn itself fails', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    fake.next = () => {
      throw new Error('spawn pi ENOENT');
    };
    const supervisor = new SubagentRunSupervisor({
      client,
      spawn,
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
    });
    const { prepared } = await prepare();
    const record = await supervisor.start({
      prepared,
      name: 'Unspawnable run',
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    });
    const settled = await supervisor.whenSettled(record.facts.taskId);
    expect(settled.state).toBe('failed');
    expect(settled.error).toContain('child_spawn_failed');
    expect(service.tasks.get(record.serviceTaskId)?.status).toBe('failed');
    expect(existsSync(join(prepared.store.artifactDirAbs, 'manifest.json'))).toBe(true);
  });

  it('caps forwarded child output and settles failed rather than absorbing unbounded logs', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const groupKills: Array<[number, string | undefined]> = [];
    const supervisor = new SubagentRunSupervisor({
      client,
      spawn,
      killProcess: (pid, signal) => {
        groupKills.push([pid, signal as string | undefined]);
        return true;
      },
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
      outputCapBytes: 1024,
    });
    const { prepared } = await prepare();
    const record = await supervisor.start({
      prepared,
      name: 'Flooding run',
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    });
    fake.children[0]?.emitStdout('x'.repeat(4096));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(groupKills[0]).toEqual([-4242, 'SIGTERM']);
    fake.children[0]?.close(null, 'SIGTERM');
    const settled = await supervisor.whenSettled(record.facts.taskId);
    expect(settled.state).toBe('failed');
    expect(settled.error).toContain('output cap');
    expect(service.tasks.get(record.serviceTaskId)?.status).toBe('failed');
  });

  it('auto-delivers the verified answer as a final log frame only when asked', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const supervisor = new SubagentRunSupervisor({
      client,
      spawn,
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
    });
    const { prepared } = await prepare({ autoDeliver: 'always' });
    const record = await supervisor.start({
      prepared,
      name: 'Delivering run',
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    });
    await commitChildResult(prepared, 'delivered answer body');
    fake.children[0]?.close(0);
    const settled = await supervisor.whenSettled(record.facts.taskId);
    expect(settled.state).toBe('committed');
    const logs = service.tasks.get(record.serviceTaskId)?.logs.join('\n') ?? '';
    expect(logs).toContain('delivered answer body');
  });

  it('resolves records by exact id and unambiguous prefix and rejects the unknown', async () => {
    const bus = new MemoryEventBus();
    new StubService(bus);
    const client = await connectClient(bus);
    const { spawn } = makeFakeSpawn();
    const supervisor = new SubagentRunSupervisor({
      client,
      spawn,
      platform: 'linux',
      killGraceMs: 20,
      logFlushMs: 5,
    });
    const { prepared } = await prepare();
    const record = await supervisor.start({
      prepared,
      name: 'Resolvable run',
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    });
    expect(supervisor.resolve(record.facts.taskId).facts.taskId).toBe(record.facts.taskId);
    expect(supervisor.resolve(record.facts.taskId.slice(0, 12)).facts.taskId).toBe(
      record.facts.taskId,
    );
    expect(() => supervisor.resolve('s'.concat('f'.repeat(32)))).toThrowError(/unknown/i);
  });
});
