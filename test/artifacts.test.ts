import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  discardSubagentArtifactRoot,
  SUBAGENT_ARTIFACT_NAMES,
  SubagentArtifactStore,
} from '../extensions/artifacts.js';
import type { SubagentAdmissionPlanV1 } from '../extensions/budget.js';
import type { SubagentPinnedRoute } from '../extensions/types.js';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function freshCwd(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagent-artifacts-'));
  roots.push(root);
  return root;
}

const route: SubagentPinnedRoute = {
  provider: 'test-provider',
  model: 'test-model',
  qualified_id: 'test-provider/test-model',
  context_window_tokens: 200_000,
  thinking_level: 'medium',
  origin: 'parent_current',
};

const plan = { schema_version: 'pi-subagent.budget-plan.v3' } as SubagentAdmissionPlanV1;

async function createStore(cwd: string, taskId = `s${'a'.repeat(32)}`) {
  return SubagentArtifactStore.create({
    cwd,
    taskId,
    launchNonce: 'n'.repeat(32),
    sessionId: 'session-1',
    childSessionId: 'subagent-child-1',
    childSessionDir: '',
    extensionMode: 'isolated',
    route,
    limits: {
      max_turns: 24,
      max_tool_calls: 120,
      timeout_seconds: 1200,
      max_tool_result_bytes: 65_536,
      max_total_tool_output_bytes: 67_108_864,
      max_answer_bytes: 4_194_304,
      allowed_input_tokens: 150_000,
    },
    seedSha256: `sha256:${'f'.repeat(64)}`,
    now: () => new Date('2026-08-20T00:00:00.000Z'),
  });
}

describe('subagent artifact store', () => {
  it('creates an exclusive mode-0700 directory under subagent ownership', async () => {
    const cwd = await freshCwd();
    const store = await createStore(cwd);
    expect(store.artifactDir).toBe(
      join('.pi', 'subagent', `session-1-${String(process.pid)}`, `s${'a'.repeat(32)}`),
    );
    const stats = await stat(store.artifactDirAbs);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
    let duplicate: unknown;
    try {
      await createStore(cwd);
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(Error);
    expect((duplicate as Error).message).toMatch(/EEXIST/);
  });

  it('writes control artifacts durably and records manifest references', async () => {
    const cwd = await freshCwd();
    const store = await createStore(cwd);
    const seedRef = await store.writeSeed('{"seed":true}');
    expect(seedRef.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    await store.writeLedger({ schema_version: 'pi-subagent.ledger.v1' });
    await store.writeBudgetPlan(plan);
    await store.writeChildPrompt(Buffer.from('child prompt', 'utf8'));
    const manifest = JSON.parse(
      await readFile(join(store.artifactDirAbs, SUBAGENT_ARTIFACT_NAMES.manifest), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['schema_version']).toBe('pi-subagent.manifest.v2');
    expect(manifest['task_id']).toBe(`s${'a'.repeat(32)}`);
    expect(manifest['state']).toBe('launched');
    const artifacts = manifest['artifacts'] as Record<string, { sha256: string }>;
    for (const name of [
      SUBAGENT_ARTIFACT_NAMES.seed,
      SUBAGENT_ARTIFACT_NAMES.ledger,
      SUBAGENT_ARTIFACT_NAMES.budgetPlan,
      SUBAGENT_ARTIFACT_NAMES.childPrompt,
    ]) {
      expect(artifacts[name], name).toBeDefined();
    }
    expect(await readFile(join(store.artifactDirAbs, SUBAGENT_ARTIFACT_NAMES.seed), 'utf8')).toBe(
      '{"seed":true}',
    );
  });

  it('commits a result atomically and reads the exact committed bytes back', async () => {
    const cwd = await freshCwd();
    const store = await createStore(cwd);
    await expect(store.readCommittedResult()).rejects.toThrow(/no committed answer is available/);
    await store.commitResult({
      schema_version: 'pi-subagent.result.v1',
      task_id: `s${'a'.repeat(32)}`,
    } as never);
    const raw = await store.readCommittedResult();
    expect(raw).toContain('pi-subagent.result.v1');
    const manifest = JSON.parse(
      await readFile(join(store.artifactDirAbs, SUBAGENT_ARTIFACT_NAMES.manifest), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['state']).toBe('committed');
  });

  it('spills tool payloads with receipts and refuses paths that escape the store', async () => {
    const cwd = await freshCwd();
    const store = await createStore(cwd);
    const receipt = await store.spillToolPayload({
      toolName: 'read',
      toolCallId: 'call-x',
      turnSequence: 0,
      sourceCallIndex: 0,
      payload: Buffer.from('payload', 'utf8'),
      maxTotalBytes: 1024,
    });
    expect(receipt.artifact).toBe(`spill/t0000-c0000-call-x.bin`);
    expect(receipt.schema_version).toBe('pi-subagent.receipt.v1');
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    const spilled = await readdir(join(store.artifactDirAbs, 'spill'));
    expect(spilled).toEqual(['t0000-c0000-call-x.bin']);
    await expect(store.readSpillRange('../escape.bin', 0, 1)).rejects.toThrow(
      /escapes the subagent artifact directory/,
    );
    await expect(store.readSpillRange(receipt.artifact, 0, 99)).rejects.toThrow(
      /exceed the artifact size/,
    );
    const range = await store.readSpillRange(receipt.artifact, 1, 6);
    expect(range.bytes.toString('utf8')).toBe('ayload');
  });

  it('records terminal outcomes and failures without claiming success', async () => {
    const cwd = await freshCwd();
    const store = await createStore(cwd);
    await store.writeError('failed', 'boom');
    const manifest = JSON.parse(
      await readFile(join(store.artifactDirAbs, SUBAGENT_ARTIFACT_NAMES.manifest), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['state']).toBe('failed');
    expect(manifest['error']).toBe('boom');
    const failedAgain = await createStore(cwd, `s${'b'.repeat(32)}`);
    await failedAgain.setState('cancelled');
    const cancelledManifest = JSON.parse(
      await readFile(join(failedAgain.artifactDirAbs, SUBAGENT_ARTIFACT_NAMES.manifest), 'utf8'),
    ) as Record<string, unknown>;
    expect(cancelledManifest['state']).toBe('cancelled');
  });

  it('discards a partially created artifact root entirely', async () => {
    const cwd = await freshCwd();
    const store = await createStore(cwd);
    await writeFile(join(store.artifactDirAbs, 'partial.txt'), 'x', 'utf8');
    await discardSubagentArtifactRoot(store.artifactDirAbs);
    await expect(stat(store.artifactDirAbs)).rejects.toThrow(/ENOENT/);
  });
});
