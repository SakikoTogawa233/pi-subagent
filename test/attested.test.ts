import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@sakiko233/pi-agent-runtime';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildSubagentAttestedArgv,
  buildSubagentPiAttestation,
  gitAuthoritySnapshot,
  makeSubagentAttestedPaths,
  makeSubagentAttestedTaskId,
  observeSubagentPiOAuth,
  parseSubagentPiJsonEvents,
  resolveSubagentReportPath,
  type StructuredSubagentPiLaunchRequest,
  SUBAGENT_ATTESTED_TASK_ID_PATTERN,
  SubagentAttestedSupervisor,
  subagentAttestedChildEnv,
  validateSubagentAttestedLaunchRequest,
} from '../extensions/attested.js';
import { SubagentBackgroundClient } from '../extensions/background-client.js';
import { SUBAGENT_ATTESTATION_SCHEMA_VERSION } from '../extensions/types.js';
import { MemoryEventBus, makeFakeSpawn, StubService } from './helpers/fakes.js';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-subagent-attested-'));
  roots.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'fixture\n');
  // The attested contract requires a clean worktree at start and finish; the
  // report and the evidence store are ignored exactly as in the source repo's
  // attested-run fixtures.
  await writeFile(join(dir, '.gitignore'), '.pi/\nreport.md\ndocs/\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const oauthModel = {
  provider: 'openai-codex',
  id: 'gpt-test',
  api: 'openai-responses',
  contextWindow: 200_000,
};

function oauthRegistry(models = [oauthModel]) {
  return {
    find: (provider: string, modelId: string) =>
      models.find((model) => model.provider === provider && model.id === modelId),
    isUsingOAuth: () => true,
  };
}

function request(
  overrides: Partial<StructuredSubagentPiLaunchRequest> = {},
): StructuredSubagentPiLaunchRequest {
  return {
    name: 'Attested probe',
    provider: 'openai-codex',
    model: 'gpt-test',
    prompt: 'Write the report file, then stop.',
    reportPath: 'report.md',
    ...overrides,
  };
}

function eventStream(cwd: string, answer: string): string {
  const usage = {
    input: 12,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return (
    [
      JSON.stringify({ type: 'session', id: 'pi-session-1', cwd }),
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          model: 'gpt-test',
          stopReason: 'stop',
          usage,
          content: [{ type: 'text', text: answer }],
        },
      }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n') + '\n'
  );
}

async function connectClient(bus: MemoryEventBus): Promise<SubagentBackgroundClient> {
  return SubagentBackgroundClient.connect(bus, {
    timeoutMs: 300,
    graceMs: 5,
    ownerTag: 'attested-test',
  });
}

describe('attested request validation and launch shape', () => {
  it('rejects blank fields and argv-owning overrides', () => {
    expect(() => validateSubagentAttestedLaunchRequest(request({ name: ' ' }))).toThrow(/name/);
    expect(() => validateSubagentAttestedLaunchRequest(request({ prompt: '' }))).toThrow(/prompt/);
    expect(() => validateSubagentAttestedLaunchRequest(request({ reportPath: '' }))).toThrow(
      /report path/i,
    );
    for (const bad of [
      '--api-key',
      '--api-key=x',
      '--auth-file',
      '-p',
      '--print',
      '--mode',
      '--mode=json',
      '--provider',
      '--model=x',
      '--thinking',
    ]) {
      expect(() =>
        validateSubagentAttestedLaunchRequest(request({ extraPiArgs: [bad] })),
      ).toThrow();
    }
  });

  it('builds the pinned argv with the prompt last and attribution first for Anthropic', () => {
    const argv = buildSubagentAttestedArgv(
      request({ thinking: 'high', extraPiArgs: ['--verbose'] }),
    );
    expect(argv.slice(0, 6)).toEqual([
      'pi',
      '--mode',
      'json',
      '--provider',
      'openai-codex',
      '--model',
    ]);
    expect(argv).toContain('gpt-test');
    expect(argv).toContain('--thinking');
    expect(argv).toContain('high');
    expect(argv).toContain('--verbose');
    expect(argv.at(-1)).toBe('Write the report file, then stop.');

    const anthropic = buildSubagentAttestedArgv(
      request({ provider: 'anthropic', model: 'claude-test' }),
      '/pkg/subagent-attribution.ts',
    );
    expect(anthropic).toContain('--extension');
    expect(anthropic).toContain('/pkg/subagent-attribution.ts');
    expect(() =>
      buildSubagentAttestedArgv(request({ provider: 'anthropic', model: 'claude-test' })),
    ).toThrow(/attribution/);
  });

  it('strips direct credential environment from the child', () => {
    const env = subagentAttestedChildEnv({
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      OPENAI_BASE_URL: 'https://proxy.invalid',
      PI_AUTH_FILE: '/tmp/auth.json',
      PATH: '/usr/bin',
    });
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['OPENAI_BASE_URL']).toBeUndefined();
    expect(env['PI_AUTH_FILE']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('constrains the report path to the task cwd and away from metadata stores', async () => {
    const cwd = await tempRepo();
    await expect(resolveSubagentReportPath(cwd, '/abs/report.md')).rejects.toThrow(/relative/);
    await expect(resolveSubagentReportPath(cwd, '../escape.md')).rejects.toThrow(/inside/);
    await expect(resolveSubagentReportPath(cwd, '.git/notes.md')).rejects.toThrow(/Git metadata/);
    await expect(resolveSubagentReportPath(cwd, '.pi/tasks/x.md')).rejects.toThrow(/task store/);
    await mkdir(join(cwd, 'docs'), { recursive: true });
    expect(await resolveSubagentReportPath(cwd, 'docs/report.md')).toBe(
      join(cwd, 'docs', 'report.md'),
    );
  });

  it('generates attested ids in the subagent namespace', () => {
    const id = makeSubagentAttestedTaskId();
    expect(id).toMatch(SUBAGENT_ATTESTED_TASK_ID_PATTERN);
  });
});

describe('OAuth observation and event parsing', () => {
  it('observes OAuth through the registry and rejects non-OAuth or unsupported providers', () => {
    const observation = observeSubagentPiOAuth(oauthRegistry(), 'openai-codex', 'gpt-test');
    expect(observation.credentialKind).toBe('oauth');
    expect(observation.routeClass).toBe('subscription-agent');
    expect(observation.channel).toBe('subscription-codex');
    expect(observation.directApiKey).toBe(false);
    expect(() => observeSubagentPiOAuth(oauthRegistry(), 'openai-codex', 'missing')).toThrow(
      /not found/,
    );
    expect(() =>
      observeSubagentPiOAuth(
        { find: () => oauthModel, isUsingOAuth: () => false },
        'openai-codex',
        'gpt-test',
      ),
    ).toThrow(/OAuth/);
    expect(() =>
      observeSubagentPiOAuth(
        oauthRegistry([
          { provider: 'deepseek', id: 'r1', api: 'deepseek-api', contextWindow: 64_000 },
        ]),
        'deepseek',
        'r1',
      ),
    ).toThrow(/Unsupported/);
  });

  it('parses a conforming event stream and rejects malformed ones', async () => {
    const cwd = await tempRepo();
    const parsed = parseSubagentPiJsonEvents(Buffer.from(eventStream(cwd, 'the answer'), 'utf8'));
    expect(parsed.piSessionId).toBe('pi-session-1');
    expect(parsed.provider).toBe('openai-codex');
    expect(parsed.model).toBe('gpt-test');
    expect(parsed.finalStopReason).toBe('stop');
    expect(parsed.tokenUsage.totalTokens).toBe(16);
    expect(parsed.humanTranscript).toContain('the answer');

    expect(() => parseSubagentPiJsonEvents(Buffer.from('{"type":"session"}\n', 'utf8'))).toThrow();
    expect(() =>
      parseSubagentPiJsonEvents(Buffer.from(eventStream(cwd, 'x').trimEnd(), 'utf8')),
    ).toThrow(/newline/);
    const wrongStop = eventStream(cwd, 'x').replace('"stopReason":"stop"', '"stopReason":"length"');
    expect(() => parseSubagentPiJsonEvents(Buffer.from(wrongStop, 'utf8'))).toThrow(/stop reason/);
  });
});

describe('attestation sidecar', () => {
  it('refuses changed or dirty Git authority and route mismatch', async () => {
    const cwd = await tempRepo();
    const authority = await gitAuthoritySnapshot(cwd);
    expect(authority.clean).toBe(true);
    const paths = makeSubagentAttestedPaths(
      join(cwd, '.pi', 'subagent', 'attested'),
      '.pi/subagent/attested',
      'a'.padEnd(33, '0'),
    );
    await mkdir(join(cwd, '.pi', 'subagent', 'attested'), { recursive: true });
    for (const path of [
      paths.outputAbsPath,
      paths.metadataAbsPath,
      paths.eventsAbsPath,
      paths.stderrAbsPath,
      paths.wrapperAbsPath,
    ]) {
      await writeFile(path, 'x\n');
    }
    const reportAbsPath = join(cwd, 'report.md');
    await writeFile(reportAbsPath, '# report\n');
    const parsed = parseSubagentPiJsonEvents(Buffer.from(eventStream(cwd, 'a'), 'utf8'));
    const auth = observeSubagentPiOAuth(oauthRegistry(), 'openai-codex', 'gpt-test');
    const base = {
      taskId: 'a'.padEnd(33, '0'),
      paths,
      attestedDir: '.pi/subagent/attested',
      argv: ['pi', '--mode', 'json'],
      cwdRealpath: cwd,
      repoRootRealpath: cwd,
      startAuthority: authority,
      finishAuthority: authority,
      parsedEvents: parsed,
      auth,
      authProvider: 'openai-codex',
      authModelId: 'gpt-test',
      prompt: Buffer.from('prompt', 'utf8'),
      reportAbsPath,
      lifecycle: {
        status: 'completed' as const,
        startTimeMs: 1,
        endTimeMs: 2,
        exitCode: 0 as number | null,
        signal: null as NodeJS.Signals | null,
        bytesWritten: 2,
      },
    };
    await expect(
      buildSubagentPiAttestation({
        ...base,
        finishAuthority: { ...authority, commit: 'f'.repeat(40) },
      }),
    ).rejects.toThrow(/authority changed/);
    await expect(
      buildSubagentPiAttestation({
        ...base,
        finishAuthority: { ...authority, clean: false },
      }),
    ).rejects.toThrow(/clean/);
    const wrongModel = parseSubagentPiJsonEvents(
      Buffer.from(eventStream(cwd, 'a').replaceAll('"gpt-test"', '"gpt-other"'), 'utf8'),
    );
    await expect(buildSubagentPiAttestation({ ...base, parsedEvents: wrongModel })).rejects.toThrow(
      /provider\/model/,
    );

    const attestation = await buildSubagentPiAttestation(base);
    expect(attestation['schema_version']).toBe(SUBAGENT_ATTESTATION_SCHEMA_VERSION);
    const selfHash = attestation['attestation_sha256'];
    expect(typeof selfHash).toBe('string');
    const withoutSelf = { ...attestation };
    Reflect.deleteProperty(withoutSelf, 'attestation_sha256');
    const recomputed = `sha256:${createHash('sha256')
      .update(Buffer.from(canonicalJson(withoutSelf), 'utf8'))
      .digest('hex')}`;
    expect(selfHash).toBe(recomputed);
  });
});

describe('SubagentAttestedSupervisor', () => {
  it('captures raw events, writes the sidecar only after success, and settles completed', async () => {
    const cwd = await tempRepo();
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const supervisor = new SubagentAttestedSupervisor({
      client,
      spawn,
      platform: 'linux',
      killGraceMs: 20,
    });
    const record = await supervisor.start({
      request: request(),
      cwd,
      modelRegistry: oauthRegistry(),
    });
    expect(record.id).toMatch(SUBAGENT_ATTESTED_TASK_ID_PATTERN);
    expect(service.tasks.get(record.serviceTaskId)?.ownerRef).toBe(record.id);
    const call = fake.calls[0];
    expect(call?.args[0]).toBe('--mode');
    expect(call?.args.at(-1)).toBe('Write the report file, then stop.');
    expect(call?.options.env?.['OPENAI_API_KEY']).toBeUndefined();

    // The conforming child writes its report and a complete JSONL event stream.
    await writeFile(join(cwd, 'report.md'), '# attested report\n');
    const child = fake.children[0];
    child?.emitStdout(eventStream(cwd, 'report written'));
    child?.emitStderr('some diagnostics\n');
    child?.close(0);
    const settled = await supervisor.whenSettled(record.id);
    expect(settled.state).toBe('completed');
    expect(service.tasks.get(record.serviceTaskId)?.status).toBe('completed');

    const attestationRaw = await readFile(record.paths.attestationAbsPath, 'utf8');
    const attestation = JSON.parse(attestationRaw) as Record<string, unknown>;
    expect(attestation['schema_version']).toBe(SUBAGENT_ATTESTATION_SCHEMA_VERSION);
    const invocation = attestation['invocation'] as Record<string, unknown>;
    expect(invocation['provider']).toBe('openai-codex');
    expect(invocation['model_id']).toBe('gpt-test');
    expect(invocation['credential_kind']).toBe('oauth');
    const artifacts = attestation['artifacts'] as Record<string, { sha256: string }>;
    const reportSha = `sha256:${createHash('sha256').update(Buffer.from('# attested report\n', 'utf8')).digest('hex')}`;
    expect(artifacts['report']?.sha256).toBe(reportSha);
    // Raw capture is preserved alongside the sidecar.
    expect((await readFile(record.paths.stderrAbsPath, 'utf8')).includes('diagnostics')).toBe(true);
    expect((await readFile(record.paths.eventsAbsPath, 'utf8')).includes('agent_start')).toBe(true);
    const output = await readFile(record.paths.outputAbsPath, 'utf8');
    expect(output).toContain('report written');
  });

  it('emits no sidecar and settles failed when the child exits non-zero', async () => {
    const cwd = await tempRepo();
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const supervisor = new SubagentAttestedSupervisor({
      client,
      spawn,
      platform: 'linux',
      killGraceMs: 20,
    });
    const record = await supervisor.start({
      request: request(),
      cwd,
      modelRegistry: oauthRegistry(),
    });
    fake.children[0]?.emitStderr('boom\n');
    fake.children[0]?.close(1);
    const settled = await supervisor.whenSettled(record.id);
    expect(settled.state).toBe('failed');
    expect(settled.error).toContain('Exited with code 1');
    expect(service.tasks.get(record.serviceTaskId)?.status).toBe('failed');
    expect(existsSync(record.paths.attestationAbsPath)).toBe(false);
    expect(await readFile(record.paths.stderrAbsPath, 'utf8')).toContain('boom');
  });

  it('emits no sidecar and settles failed when the worktree changed during the run', async () => {
    const cwd = await tempRepo();
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const supervisor = new SubagentAttestedSupervisor({
      client,
      spawn,
      platform: 'linux',
      killGraceMs: 20,
    });
    const record = await supervisor.start({
      request: request(),
      cwd,
      modelRegistry: oauthRegistry(),
    });
    await writeFile(join(cwd, 'report.md'), '# report\n');
    // The child leaves the worktree dirty: authority can no longer be attested.
    await writeFile(join(cwd, 'untracked.txt'), 'drift\n');
    fake.children[0]?.emitStdout(eventStream(cwd, 'done'));
    fake.children[0]?.close(0);
    const settled = await supervisor.whenSettled(record.id);
    expect(settled.state).toBe('failed');
    expect(settled.error).toMatch(/clean|authority/i);
    expect(existsSync(record.paths.attestationAbsPath)).toBe(false);
    expect(service.tasks.get(record.serviceTaskId)?.status).toBe('failed');
  });

  it('routes cancellation: kills the child, acks, and settles killed without a sidecar', async () => {
    const cwd = await tempRepo();
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const groupKills: Array<[number, string | undefined]> = [];
    const supervisor = new SubagentAttestedSupervisor({
      client,
      spawn,
      killProcess: (pid, signal) => {
        groupKills.push([pid, signal as string | undefined]);
        return true;
      },
      platform: 'linux',
      killGraceMs: 20,
    });
    const record = await supervisor.start({
      request: request(),
      cwd,
      modelRegistry: oauthRegistry(),
    });
    const cancelId = service.publishCancellation(record.serviceTaskId, 'user');
    expect(groupKills[0]).toEqual([-4242, 'SIGTERM']);
    fake.children[0]?.close(null, 'SIGTERM');
    const settled = await supervisor.whenSettled(record.id);
    expect(settled.state).toBe('killed');
    const ops = service.operationsFor(record.serviceTaskId);
    expect(ops.indexOf('cancel_ack')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('settle')).toBeGreaterThan(ops.indexOf('cancel_ack'));
    const ackFrame = service.frames.find((frame) => frame.operation === 'cancel_ack');
    expect(ackFrame?.payload?.['cancel_id']).toBe(cancelId);
    expect(service.tasks.get(record.serviceTaskId)?.status).toBe('killed');
    expect(existsSync(record.paths.attestationAbsPath)).toBe(false);
  });

  it('refuses a dirty worktree before any registration or spawn', async () => {
    const cwd = await tempRepo();
    await writeFile(join(cwd, 'dirty.txt'), 'dirty\n');
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connectClient(bus);
    const { spawn, fake } = makeFakeSpawn();
    const supervisor = new SubagentAttestedSupervisor({
      client,
      spawn,
      platform: 'linux',
      killGraceMs: 20,
    });
    await expect(
      supervisor.start({ request: request(), cwd, modelRegistry: oauthRegistry() }),
    ).rejects.toThrow(/clean/);
    expect(fake.calls).toHaveLength(0);
    expect(service.tasks.size).toBe(0);
  });
});
