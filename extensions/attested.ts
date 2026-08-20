import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertWindowsCommandLineWithinLimit,
  canonicalJson,
  observeModelRegistryOAuth,
  piLaunchArgv,
  replaceFileDurable,
  resolvePiLaunch,
  writeFileDurable,
} from '@sakiko233/pi-agent-runtime';
import type { SubagentBackgroundClient } from './background-client.js';
import { resolveSubagentAttributionExtensionPath } from './launch.js';
import { boundedSettleError } from './runner.js';
import { SUBAGENT_ATTESTATION_SCHEMA_VERSION } from './types.js';

/**
 * Attested single-child Pi runs.
 *
 * Extracted from the source repository's attested Pi task surface and renamed
 * to subagent ownership. The contract is preserved: exactly one direct
 * `pi --mode json` child, raw event/stderr capture, OAuth observation through
 * the ModelRegistry, report-path confinement, clean-Git authority at start and
 * finish, and a self-hashed attestation sidecar written only after successful
 * completion. Task identity, dock display, and the terminal publication are
 * owned by the background-tasks external-task service; this module owns the
 * evidence.
 */

export const SUBAGENT_ATTESTED_TASK_ID_PATTERN = /^a[0-9a-f]{32}$/;

export interface StructuredSubagentPiLaunchRequest {
  name: string;
  provider: string;
  model: string;
  prompt: string;
  reportPath: string;
  extraPiArgs?: string[] | undefined;
  thinking?: string | undefined;
  timeoutSeconds?: number | undefined;
}

export interface SubagentAttestedPaths {
  outputAbsPath: string;
  metadataAbsPath: string;
  eventsAbsPath: string;
  stderrAbsPath: string;
  wrapperAbsPath: string;
  attestationAbsPath: string;
  outputPath: string;
  metadataPath: string;
  eventsPath: string;
  stderrPath: string;
  wrapperPath: string;
  attestationPath: string;
}

export interface GitAuthoritySnapshot {
  commit: string;
  tree: string;
  clean: boolean;
}

export interface ParsedSubagentPiEvents {
  piSessionId: string;
  piCwd: string;
  provider: string;
  model: string;
  providerScopedModelId: string;
  finalStopReason: string;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costTotal?: number | undefined;
  };
  assistantCount: number;
  toolUsage: { total: number; failed: number; byName: Record<string, number> };
  humanTranscript: string;
}

export interface SubagentAuthObservation {
  apiIdentity: string;
  authClass: string;
  credentialKind: 'oauth';
  routeClass: 'subscription-agent';
  channel: string;
  directApiKey: false;
}

export function makeSubagentAttestedTaskId(): string {
  return `a${randomBytes(16).toString('hex')}`;
}

export function validateSubagentAttestedLaunchRequest(
  input: StructuredSubagentPiLaunchRequest,
): void {
  if (!input.name.trim()) throw new Error('Attested Pi task requires a concise name');
  if (!input.provider.trim()) throw new Error('Attested Pi task requires provider');
  if (!input.model.trim()) throw new Error('Attested Pi task requires model');
  if (!input.prompt) throw new Error('Attested Pi task requires prompt text');
  if (!input.reportPath.trim()) throw new Error('Attested Pi task requires a report path');
  const args = input.extraPiArgs ?? [];
  for (const arg of args) {
    if (arg === '--api-key' || arg.startsWith('--api-key=')) {
      throw new Error('Attested Pi tasks forbid direct --api-key launch arguments');
    }
    if (arg === '--auth-file' || arg.startsWith('--auth-file=')) {
      throw new Error('Attested Pi tasks forbid alternate auth-file launch arguments');
    }
    if (arg === '-p' || arg === '--print' || arg === '--mode' || arg.startsWith('--mode=')) {
      throw new Error('Attested Pi tasks own print/json mode arguments');
    }
    if (
      arg === '--provider' ||
      arg.startsWith('--provider=') ||
      arg === '--model' ||
      arg.startsWith('--model=')
    ) {
      throw new Error('Use structured provider/model fields, not duplicate Pi args');
    }
    if (arg === '--thinking' || arg.startsWith('--thinking=')) {
      throw new Error('Use the structured thinking field, not duplicate Pi args');
    }
  }
}

const SUBAGENT_ATTESTED_REMOVED_ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'PI_API_KEY',
  'PI_API_BASE_URL',
  'PI_AUTH_FILE',
] as const;

export function subagentAttestedChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of SUBAGENT_ATTESTED_REMOVED_ENV_KEYS) Reflect.deleteProperty(out, key);
  return out;
}

export function buildSubagentAttestedArgv(
  input: StructuredSubagentPiLaunchRequest,
  attributionExtensionPath?: string,
): string[] {
  validateSubagentAttestedLaunchRequest(input);
  const args = ['pi', '--mode', 'json', '--provider', input.provider, '--model', input.model];
  if (input.provider === 'anthropic') {
    if (!attributionExtensionPath?.trim()) {
      throw new Error('Anthropic attested Pi tasks require the package attribution extension');
    }
    args.push('--extension', attributionExtensionPath);
  }
  if (input.thinking?.trim()) args.push('--thinking', input.thinking.trim());
  args.push(...(input.extraPiArgs ?? []), input.prompt);
  return args;
}

export async function resolveSubagentReportPath(cwd: string, reportPath: string): Promise<string> {
  if (isAbsolute(reportPath))
    throw new Error('Attested Pi report path must be relative to task cwd');
  const resolved = resolve(cwd, reportPath);
  const relativePath = relative(cwd, resolved);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Attested Pi report path must stay inside task cwd');
  }
  const parts = relativePath.split(sep);
  if (parts[0] === '.git' || (parts[0] === '.pi' && parts[1] === 'tasks')) {
    throw new Error('Attested Pi report path cannot target Git metadata or the fixed task store');
  }
  return resolved;
}

export async function gitAuthoritySnapshot(cwd: string): Promise<GitAuthoritySnapshot> {
  const commit = await runGit(cwd, ['rev-parse', 'HEAD']);
  const tree = await runGit(cwd, ['rev-parse', 'HEAD^{tree}']);
  const status = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  return { commit, tree, clean: status.length === 0 };
}

export async function gitRepoRoot(cwd: string): Promise<string> {
  return realpath(await runGit(cwd, ['rev-parse', '--show-toplevel']));
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = nodeSpawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(out).toString('utf8').trim());
        return;
      }
      reject(
        new Error(`git ${args.join(' ')} failed: ${Buffer.concat(err).toString('utf8').trim()}`),
      );
    });
  });
}

interface OAuthRegistryLike {
  find(
    provider: string,
    modelId: string,
  ): { provider: string; id: string; api: string } | undefined;
  isUsingOAuth?(model: { provider: string; id: string; api: string }): boolean;
}

/**
 * Observe the OAuth credential for the pinned route through the runtime.
 *
 * The runtime proves the model exists and is OAuth-backed; this package then
 * pins the two subscription channels it knows how to attest. Any other
 * provider is a loud refusal, never an unattested launch.
 */
export function observeSubagentPiOAuth(
  registry: OAuthRegistryLike,
  provider: string,
  modelId: string,
): SubagentAuthObservation {
  const observed = observeModelRegistryOAuth(registry, provider, modelId);
  const channel =
    provider === 'openai-codex'
      ? 'subscription-codex'
      : provider === 'anthropic'
        ? 'subscription-anthropic'
        : undefined;
  const authClass =
    provider === 'openai-codex'
      ? 'pi-codex-oauth'
      : provider === 'anthropic'
        ? 'pi-anthropic-oauth'
        : undefined;
  if (channel === undefined || authClass === undefined) {
    throw new Error(`Unsupported attested Pi OAuth provider: ${provider}`);
  }
  return {
    apiIdentity: observed.api,
    authClass,
    credentialKind: 'oauth',
    routeClass: 'subscription-agent',
    channel,
    directApiKey: false,
  };
}

type JsonRecord = Record<PropertyKey, unknown>;

function isJsonObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeUsage(value: unknown): ParsedSubagentPiEvents['tokenUsage'] {
  if (!isJsonObject(value))
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const input = nonNegativeInteger(value['input']);
  const output = nonNegativeInteger(value['output']);
  const cacheRead = nonNegativeInteger(value['cacheRead']);
  const cacheWrite = nonNegativeInteger(value['cacheWrite']);
  const totalTokens =
    nonNegativeInteger(value['totalTokens']) || input + output + cacheRead + cacheWrite;
  const cost = isJsonObject(value['cost']) ? readNumber(value['cost'], 'total') : undefined;
  const usage: ParsedSubagentPiEvents['tokenUsage'] = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
  };
  if (cost !== undefined && cost >= 0) usage.costTotal = cost;
  return usage;
}

function appendUsage(
  target: ParsedSubagentPiEvents['tokenUsage'],
  delta: ParsedSubagentPiEvents['tokenUsage'],
): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.totalTokens += delta.totalTokens;
  if (delta.costTotal !== undefined) target.costTotal = (target.costTotal ?? 0) + delta.costTotal;
}

function textFromAssistantMessage(message: JsonRecord): string[] {
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isJsonObject(part)) return [];
    if (part['type'] === 'text' && typeof part['text'] === 'string') return [part['text']];
    return [];
  });
}

function countToolCalls(message: JsonRecord, tools: ParsedSubagentPiEvents['toolUsage']): void {
  const content = message['content'];
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!isJsonObject(part) || part['type'] !== 'toolCall') continue;
    const name = typeof part['name'] === 'string' && part['name'] ? part['name'] : 'tool';
    tools.total += 1;
    tools.byName[name] = (tools.byName[name] ?? 0) + 1;
  }
}

export function parseSubagentPiJsonEvents(raw: Buffer): ParsedSubagentPiEvents {
  const text = raw.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('Pi JSON event stream is not newline-terminated');
  let sessionId: string | undefined;
  let sessionCwd: string | undefined;
  let sessionCount = 0;
  let agentStartCount = 0;
  let agentEndCount = 0;
  let provider: string | undefined;
  let model: string | undefined;
  let finalStopReason: string | undefined;
  let assistantCount = 0;
  const usage: ParsedSubagentPiEvents['tokenUsage'] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  const tools: ParsedSubagentPiEvents['toolUsage'] = { total: 0, failed: 0, byName: {} };
  const transcript: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parsed: unknown = JSON.parse(line);
    if (!isJsonObject(parsed)) throw new Error('Pi JSON event line is not an object');
    const eventType = parsed['type'];
    if (eventType === 'session') {
      sessionCount += 1;
      sessionId = readString(parsed, 'id');
      sessionCwd = readString(parsed, 'cwd');
      continue;
    }
    if (eventType === 'agent_start') agentStartCount += 1;
    if (eventType === 'agent_end') agentEndCount += 1;
    if (eventType === 'tool_execution_start') {
      const name = readString(parsed, 'toolName') ?? readString(parsed, 'tool_name') ?? 'tool';
      tools.total += 1;
      tools.byName[name] = (tools.byName[name] ?? 0) + 1;
      transcript.push(`→ ${name}`);
      continue;
    }
    if (eventType === 'tool_execution_end') {
      if (parsed['isError'] === true) {
        tools.failed += 1;
        const name = readString(parsed, 'toolName') ?? readString(parsed, 'tool_name') ?? 'tool';
        transcript.push(`✗ ${name} failed`);
      }
      continue;
    }
    if (eventType !== 'message_end' || !isJsonObject(parsed['message'])) continue;
    const message = parsed['message'];
    if (message['role'] !== 'assistant') continue;
    assistantCount += 1;
    const messageProvider = readString(message, 'provider');
    const messageModel = readString(message, 'model');
    if (!messageProvider || !messageModel) {
      throw new Error('Assistant message lacks provider/model in Pi JSON events');
    }
    if (provider !== undefined && provider !== messageProvider)
      throw new Error('Pi assistant provider changed during task');
    if (model !== undefined && model !== messageModel)
      throw new Error('Pi assistant model changed during task');
    provider = messageProvider;
    model = messageModel;
    appendUsage(usage, normalizeUsage(message['usage']));
    countToolCalls(message, tools);
    transcript.push(...textFromAssistantMessage(message));
    if (message['error'] !== undefined && message['error'] !== null)
      throw new Error('Assistant message reported an error');
    const stopReason = readString(message, 'stopReason');
    if (stopReason) finalStopReason = stopReason;
  }
  if (sessionCount !== 1 || !sessionId || !sessionCwd)
    throw new Error('Pi JSON events must contain exactly one session header');
  if (agentStartCount !== 1) throw new Error('Pi JSON events must contain exactly one agent_start');
  if (agentEndCount !== 1) throw new Error('Pi JSON events must contain exactly one agent_end');
  if (assistantCount < 1 || !provider || !model)
    throw new Error('Pi JSON events contain no assistant message');
  if (finalStopReason !== 'stop')
    throw new Error(`Pi final stop reason is not stop: ${finalStopReason ?? 'missing'}`);
  return {
    piSessionId: sessionId,
    piCwd: sessionCwd,
    provider,
    model,
    providerScopedModelId: `${provider}/${model}`,
    finalStopReason,
    tokenUsage: usage,
    assistantCount,
    toolUsage: tools,
    humanTranscript: `${transcript.filter((line) => line.trim()).join('\n')}\n`,
  };
}

export function sha256Buffer(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export async function sha256File(path: string): Promise<{ byteLength: number; sha256: string }> {
  const bytes = await readFile(path);
  return { byteLength: bytes.length, sha256: sha256Buffer(bytes) };
}

export function makeSubagentAttestedPaths(
  dirAbs: string,
  dirDisplay: string,
  id: string,
): SubagentAttestedPaths {
  return {
    outputAbsPath: join(dirAbs, `${id}.output`),
    metadataAbsPath: join(dirAbs, `${id}.json`),
    eventsAbsPath: join(dirAbs, `${id}.pi-events.jsonl`),
    stderrAbsPath: join(dirAbs, `${id}.stderr`),
    wrapperAbsPath: join(dirAbs, `${id}.pi-telemetry-wrapper.cjs`),
    attestationAbsPath: join(dirAbs, `${id}.attestation.json`),
    outputPath: join(dirDisplay, `${id}.output`),
    metadataPath: join(dirDisplay, `${id}.json`),
    eventsPath: join(dirDisplay, `${id}.pi-events.jsonl`),
    stderrPath: join(dirDisplay, `${id}.stderr`),
    wrapperPath: join(dirDisplay, `${id}.pi-telemetry-wrapper.cjs`),
    attestationPath: join(dirDisplay, `${id}.attestation.json`),
  };
}

export interface SubagentAttestedLifecycle {
  status: 'completed' | 'failed' | 'killed';
  startTimeMs: number;
  endTimeMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  bytesWritten: number;
}

export interface SubagentAttestationInput {
  taskId: string;
  paths: SubagentAttestedPaths;
  /** Display path of the attested artifact directory. */
  attestedDir: string;
  argv: string[];
  cwdRealpath: string;
  repoRootRealpath: string;
  startAuthority: GitAuthoritySnapshot;
  finishAuthority: GitAuthoritySnapshot;
  parsedEvents: ParsedSubagentPiEvents;
  auth: SubagentAuthObservation;
  /** The pinned route from the structured launch request. */
  authProvider: string;
  authModelId: string;
  prompt: Buffer;
  reportAbsPath: string;
  lifecycle: SubagentAttestedLifecycle;
}

export async function buildSubagentPiAttestation(
  input: SubagentAttestationInput,
): Promise<JsonRecord> {
  if (
    input.startAuthority.commit !== input.finishAuthority.commit ||
    input.startAuthority.tree !== input.finishAuthority.tree
  ) {
    throw new Error('Git authority changed during attested Pi task');
  }
  if (!input.startAuthority.clean || !input.finishAuthority.clean) {
    throw new Error('Git worktree must be clean at attested Pi task start and finish');
  }
  if (
    input.parsedEvents.provider !== input.authProvider ||
    input.parsedEvents.model !== input.authModelId
  ) {
    throw new Error('Observed Pi provider/model do not match selected ModelRegistry model');
  }
  const metadata = await sha256File(input.paths.metadataAbsPath);
  const output = await sha256File(input.paths.outputAbsPath);
  const events = await sha256File(input.paths.eventsAbsPath);
  const stderr = await sha256File(input.paths.stderrAbsPath);
  const wrapper = await sha256File(input.paths.wrapperAbsPath);
  const report = await sha256File(input.reportAbsPath);
  const promptHash = sha256Buffer(input.prompt);
  const attestation: { [key: string]: unknown } = {
    schema_version: SUBAGENT_ATTESTATION_SCHEMA_VERSION,
    locator: {
      session_dir: input.attestedDir,
      task_id: input.taskId,
      metadata_ref: input.paths.metadataPath,
      output_ref: input.paths.outputPath,
      events_ref: input.paths.eventsPath,
      stderr_ref: input.paths.stderrPath,
      wrapper_ref: input.paths.wrapperPath,
    },
    source_hashes: {
      metadata_sha256: metadata.sha256,
      output_sha256: output.sha256,
      events_sha256: events.sha256,
      stderr_sha256: stderr.sha256,
      wrapper_sha256: wrapper.sha256,
    },
    lifecycle: {
      status: input.lifecycle.status,
      start_time_ms: input.lifecycle.startTimeMs,
      end_time_ms: input.lifecycle.endTimeMs,
      exit_code: input.lifecycle.exitCode,
      signal: input.lifecycle.signal,
      bytes_written: input.lifecycle.bytesWritten,
    },
    invocation: {
      pi_session_id: input.parsedEvents.piSessionId,
      argv: input.argv,
      cwd_realpath: input.cwdRealpath,
      provider: input.parsedEvents.provider,
      model_id: input.parsedEvents.model,
      provider_scoped_model_id: input.parsedEvents.providerScopedModelId,
      api_identity: input.auth.apiIdentity,
      auth_class: input.auth.authClass,
      credential_kind: input.auth.credentialKind,
      route_class: input.auth.routeClass,
      channel: input.auth.channel,
      direct_api_key: input.auth.directApiKey,
      final_stop_reason: input.parsedEvents.finalStopReason,
    },
    authority: {
      repo_root_realpath: input.repoRootRealpath,
      start_commit_oid: input.startAuthority.commit,
      start_tree_oid: input.startAuthority.tree,
      finish_commit_oid: input.finishAuthority.commit,
      finish_tree_oid: input.finishAuthority.tree,
      start_worktree_clean: input.startAuthority.clean,
      finish_worktree_clean: input.finishAuthority.clean,
    },
    artifacts: {
      prompt: { byte_length: input.prompt.length, sha256: promptHash },
      task_output: { byte_length: output.byteLength, sha256: output.sha256 },
      stderr: { byte_length: stderr.byteLength, sha256: stderr.sha256 },
      transcript: { byte_length: events.byteLength, sha256: events.sha256 },
      report: { byte_length: report.byteLength, sha256: report.sha256 },
    },
    attestation_sha256: '',
  };
  const withoutSelf = { ...attestation };
  Reflect.deleteProperty(withoutSelf, 'attestation_sha256');
  attestation['attestation_sha256'] = sha256Buffer(Buffer.from(canonicalJson(withoutSelf), 'utf8'));
  return attestation;
}

export interface SubagentAttestedRecord {
  readonly id: string;
  readonly serviceTaskId: string;
  readonly name: string;
  readonly paths: SubagentAttestedPaths;
  state: 'running' | 'completed' | 'failed' | 'killed';
  error?: string | undefined;
  pid?: number | undefined;
  model?: string | undefined;
}

export interface SubagentAttestedSupervisorOptions {
  client: SubagentBackgroundClient;
  spawn?:
    | ((
        command: string,
        args: string[],
        options: SpawnOptions,
      ) => import('./runner.js').SubagentChildProcess)
    | undefined;
  killProcess?: ((pid: number, signal?: NodeJS.Signals | number) => boolean) | undefined;
  platform?: NodeJS.Platform | undefined;
  logger?: Pick<Console, 'error'> | undefined;
  killGraceMs?: number | undefined;
  /** Operability seam for tests: overrides request.timeoutSeconds. */
  timeoutOverrideMs?: number | undefined;
}

export interface StartSubagentAttestedInput {
  request: StructuredSubagentPiLaunchRequest;
  cwd: string;
  modelRegistry: OAuthRegistryLike;
  env?: NodeJS.ProcessEnv | undefined;
  attributionExtensionPath?: string | undefined;
}

interface AttestedControl {
  record: SubagentAttestedRecord;
  chain: Promise<void>;
  nextSequence: number;
  cancelId: string | undefined;
  /** Backstop kill used by shutdown and cancellation routing. */
  kill: (() => void) | undefined;
  settled: boolean;
  terminal: Promise<SubagentAttestedRecord>;
  resolveTerminal: (record: SubagentAttestedRecord) => void;
}

const DEFAULT_KILL_GRACE_MS = 3000;

export class SubagentAttestedSupervisor {
  private readonly client: SubagentBackgroundClient;
  private readonly spawnImpl: NonNullable<SubagentAttestedSupervisorOptions['spawn']>;
  private readonly killProcess: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  private readonly platform: NodeJS.Platform;
  private readonly logger: Pick<Console, 'error'>;
  private readonly killGraceMs: number;
  private readonly timeoutOverrideMs: number | undefined;
  private readonly controls = new Map<string, AttestedControl>();
  private readonly byServiceTaskId = new Map<string, AttestedControl>();
  private readonly offCancellation: () => void;

  constructor(options: SubagentAttestedSupervisorOptions) {
    this.client = options.client;
    this.spawnImpl = options.spawn ?? (nodeSpawn as never);
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.timeoutOverrideMs = options.timeoutOverrideMs;
    this.offCancellation = this.client.onCancellation((frame) => {
      const control = this.byServiceTaskId.get(frame.taskId);
      if (control === undefined || control.settled) return;
      control.cancelId = frame.cancelId;
      const kill = control.kill;
      if (kill !== undefined) kill();
    });
  }

  list(): readonly SubagentAttestedRecord[] {
    return [...this.controls.values()].map((control) => control.record);
  }

  whenSettled(id: string): Promise<SubagentAttestedRecord> {
    const control = this.controls.get(id);
    if (control === undefined) throw new Error(`unknown attested subagent task ${id}`);
    return control.terminal;
  }

  async shutdown(reason: string): Promise<void> {
    for (const control of this.controls.values()) {
      if (control.settled || control.record.state !== 'running') continue;
      control.record.error = reason;
      control.kill?.();
    }
    await Promise.all([...this.controls.values()].map((control) => control.terminal));
  }

  close(): void {
    this.offCancellation();
  }

  /**
   * Launch one attested Pi child.
   *
   * Every refusal — validation, report-path confinement, OAuth observation,
   * Git authority — happens before registration and before any evidence file is
   * created, so a refused launch leaves no registry entry and no artifacts.
   */
  async start(input: StartSubagentAttestedInput): Promise<SubagentAttestedRecord> {
    const attributionExtensionPath =
      input.request.provider === 'anthropic'
        ? (input.attributionExtensionPath ?? resolveSubagentAttributionExtensionPath())
        : undefined;
    const argv = buildSubagentAttestedArgv(input.request, attributionExtensionPath);
    const launch = resolvePiLaunch({ platform: this.platform });
    assertWindowsCommandLineWithinLimit(launch, argv.slice(1), this.platform, 'subagent-attested');

    const id = makeSubagentAttestedTaskId();
    if (!SUBAGENT_ATTESTED_TASK_ID_PATTERN.test(id)) {
      throw new Error('Generated attested task id is invalid');
    }
    const attestedDirAbs = join(input.cwd, '.pi', 'subagent', 'attested');
    const attestedDirDisplay = join('.pi', 'subagent', 'attested');
    const paths = makeSubagentAttestedPaths(attestedDirAbs, attestedDirDisplay, id);
    const promptBytes = Buffer.from(input.request.prompt, 'utf8');
    const reportAbsPath = await resolveSubagentReportPath(input.cwd, input.request.reportPath);
    const auth = observeSubagentPiOAuth(
      input.modelRegistry,
      input.request.provider,
      input.request.model,
    );
    const repoRootRealpath = await gitRepoRoot(input.cwd);
    const cwdRealpath = await realpath(input.cwd);
    const startAuthority = await gitAuthoritySnapshot(input.cwd);
    if (!startAuthority.clean) {
      throw new Error('Attested Pi task requires a clean worktree at start');
    }
    const timeoutSeconds =
      typeof input.request.timeoutSeconds === 'number' &&
      Number.isFinite(input.request.timeoutSeconds) &&
      input.request.timeoutSeconds > 0
        ? Math.floor(input.request.timeoutSeconds)
        : undefined;

    const registered = await this.client.register({
      ownerRef: id,
      name: input.request.name,
      description: `attested subagent Pi run on ${input.request.provider}/${input.request.model}`,
      cancellable: true,
      rerunnable: false,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
    });

    let resolveTerminal!: (record: SubagentAttestedRecord) => void;
    const terminal = new Promise<SubagentAttestedRecord>((resolvePromise) => {
      resolveTerminal = resolvePromise;
    });
    const record: SubagentAttestedRecord = {
      id,
      serviceTaskId: registered.task.id,
      name: input.request.name,
      paths,
      state: 'running',
    };
    const control: AttestedControl = {
      record,
      chain: Promise.resolve(),
      nextSequence: registered.nextSequence,
      cancelId: undefined,
      kill: undefined,
      settled: false,
      terminal,
      resolveTerminal,
    };
    const startTimeMs = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let startupError: string | undefined;
    let killKind: 'user' | 'timeout' | 'shutdown' | undefined;
    let closeObserved: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let escalationHandle: NodeJS.Timeout | undefined;
    let child: import('./runner.js').SubagentChildProcess | undefined;
    let killRequestedBeforeSpawn = false;

    const killChild = (): void => {
      if (closeObserved !== undefined) return;
      if (child === undefined) {
        // A kill request that lands before the child exists aborts the spawn:
        // the run settles as killed and no orphan is ever created.
        killRequestedBeforeSpawn = true;
        return;
      }
      if (this.platform === 'win32') {
        child.kill('SIGTERM');
        return;
      }
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        this.killProcess(-pid, 'SIGTERM');
      } catch (error) {
        if (closeObserved === undefined) {
          this.logger.error(`[pi-subagent] attested group kill failed for ${id}:`, error);
        }
      }
      escalationHandle = setTimeout(() => {
        if (closeObserved !== undefined || control.settled) return;
        try {
          this.killProcess(-pid, 'SIGKILL');
        } catch (error) {
          if (closeObserved === undefined) {
            this.logger.error(`[pi-subagent] attested escalation kill failed for ${id}:`, error);
          }
        }
      }, this.killGraceMs);
    };
    // The kill control is wired before registration is published, so a cancel
    // frame or shutdown arriving at any point after publication always has a
    // live kill path.
    control.kill = () => {
      killKind ??= 'shutdown';
      killChild();
    };
    this.controls.set(id, control);
    this.byServiceTaskId.set(registered.task.id, control);

    await mkdir(attestedDirAbs, { recursive: true, mode: 0o700 });
    await writeFileDurable(paths.outputAbsPath, '');
    await writeFileDurable(paths.eventsAbsPath, '');
    await writeFileDurable(paths.stderrAbsPath, '');
    await writeFileDurable(
      paths.wrapperAbsPath,
      'direct-spawn attested Pi task; no shell telemetry wrapper is used\n',
    );
    await this.writeMetadata(paths, record, 'running', startTimeMs, null, null, 0);

    if (killRequestedBeforeSpawn) {
      // The kill request arrived during evidence setup. Settle as killed with
      // empty raw capture; no child was ever spawned.
      this.enqueue(control, async () => {
        try {
          await this.finalize(control, {
            request: input.request,
            cwd: input.cwd,
            argv,
            paths,
            promptBytes,
            reportAbsPath,
            auth,
            repoRootRealpath,
            cwdRealpath,
            startAuthority,
            startTimeMs,
            stdoutChunks,
            stderrChunks,
            startupError,
            killKind: control.cancelId !== undefined ? 'user' : (killKind ?? 'shutdown'),
            close: { code: null, signal: null },
          });
        } finally {
          control.settled = true;
          control.resolveTerminal(control.record);
        }
      });
      return record;
    }

    child = this.spawnImpl(launch.executable, piLaunchArgv(launch, argv.slice(1)), {
      cwd: input.cwd,
      detached: this.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: subagentAttestedChildEnv(input.env ?? process.env),
      windowsHide: true,
    });
    record.pid = child.pid;

    child.on('error', (error) => {
      startupError = error.message;
    });
    child.stdout?.on('data', (data: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
    });
    child.stderr?.on('data', (data: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
    });
    child.on('close', (code, signal) => {
      const observed = { code, signal };
      closeObserved = observed;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (escalationHandle !== undefined) clearTimeout(escalationHandle);
      this.enqueue(control, async () => {
        try {
          await this.finalize(control, {
            request: input.request,
            cwd: input.cwd,
            argv,
            paths,
            promptBytes,
            reportAbsPath,
            auth,
            repoRootRealpath,
            cwdRealpath,
            startAuthority,
            startTimeMs,
            stdoutChunks,
            stderrChunks,
            startupError,
            killKind: control.cancelId !== undefined ? 'user' : killKind,
            close: observed,
          });
        } finally {
          control.settled = true;
          control.resolveTerminal(control.record);
        }
      });
    });

    const timeoutMs =
      this.timeoutOverrideMs ?? (timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000);
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        if (closeObserved !== undefined || control.settled) return;
        killKind = 'timeout';
        control.record.error = `Timed out after ${String(timeoutSeconds ?? 0)}s`;
        killChild();
      }, timeoutMs);
    }

    return record;
  }

  private enqueue(control: AttestedControl, op: () => Promise<void>): void {
    const run = control.chain.then(op);
    control.chain = run.catch((error: unknown) => {
      this.logger.error(
        `[pi-subagent] background service operation failed for attested ${control.record.id}:`,
        error,
      );
    });
  }

  private async settle(
    control: AttestedControl,
    status: 'completed' | 'failed' | 'killed',
    error?: string,
  ): Promise<void> {
    const result = await this.client.settle(
      control.record.serviceTaskId,
      control.nextSequence,
      status,
      error === undefined ? undefined : boundedSettleError(error),
    );
    control.nextSequence = result.nextSequence;
  }

  private async writeMetadata(
    paths: SubagentAttestedPaths,
    record: SubagentAttestedRecord,
    status: 'running' | 'completed' | 'failed' | 'killed',
    startTimeMs: number,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    bytesWritten: number,
  ): Promise<void> {
    await replaceFileDurable(
      paths.metadataAbsPath,
      `${JSON.stringify(
        {
          id: record.id,
          name: record.name,
          status,
          start_time_ms: startTimeMs,
          end_time_ms: status === 'running' ? null : Date.now(),
          exit_code: exitCode,
          signal,
          bytes_written: bytesWritten,
          error: record.error ?? null,
        },
        null,
        2,
      )}\n`,
    );
  }

  private async finalize(
    control: AttestedControl,
    input: {
      request: StructuredSubagentPiLaunchRequest;
      cwd: string;
      argv: string[];
      paths: SubagentAttestedPaths;
      promptBytes: Buffer;
      reportAbsPath: string;
      auth: SubagentAuthObservation;
      repoRootRealpath: string;
      cwdRealpath: string;
      startAuthority: GitAuthoritySnapshot;
      startTimeMs: number;
      stdoutChunks: Buffer[];
      stderrChunks: Buffer[];
      startupError: string | undefined;
      killKind: 'user' | 'timeout' | 'shutdown' | undefined;
      close: { code: number | null; signal: NodeJS.Signals | null };
    },
  ): Promise<void> {
    const { record, paths } = { record: control.record, paths: input.paths };
    const rawEvents = Buffer.concat(input.stdoutChunks);
    const rawStderr = Buffer.concat(input.stderrChunks);

    let status: 'completed' | 'failed' | 'killed';
    let error: string | undefined;
    if (input.startupError !== undefined) {
      status = 'failed';
      error = input.startupError;
    } else if (input.killKind === 'timeout') {
      status = 'failed';
      error = record.error ?? 'Timed out';
    } else if (input.killKind === 'user' || input.killKind === 'shutdown') {
      status = 'killed';
      error = record.error;
    } else if ((input.close.code ?? 0) === 0 && input.close.signal === null) {
      status = 'completed';
    } else {
      status = 'failed';
      error = `Exited with code ${input.close.code === null ? 'null' : String(input.close.code)}${input.close.signal === null ? '' : ` (${input.close.signal})`}`;
    }

    try {
      await writeFileDurable(paths.eventsAbsPath, rawEvents);
      await writeFileDurable(paths.stderrAbsPath, rawStderr);

      let parsed: ParsedSubagentPiEvents | undefined;
      let outputBytes: Buffer;
      if (status === 'completed') {
        try {
          parsed = parseSubagentPiJsonEvents(rawEvents);
          record.model = parsed.providerScopedModelId;
          outputBytes = Buffer.from(parsed.humanTranscript, 'utf8');
        } catch (parseError) {
          status = 'failed';
          error = parseError instanceof Error ? parseError.message : String(parseError);
          outputBytes = Buffer.from(`[attested subagent Pi task error: ${error}]\n`, 'utf8');
        }
      } else {
        outputBytes = rawStderr;
      }
      await writeFileDurable(paths.outputAbsPath, outputBytes);
      const endTimeMs = Date.now();

      if (status === 'completed' && parsed !== undefined) {
        const finishAuthority = await gitAuthoritySnapshot(input.cwd);
        await this.writeMetadata(
          paths,
          record,
          'completed',
          input.startTimeMs,
          input.close.code,
          input.close.signal,
          outputBytes.length,
        );
        // The sidecar exists only when every check inside it has passed.
        const attestation = await buildSubagentPiAttestation({
          taskId: record.id,
          paths,
          attestedDir: join('.pi', 'subagent', 'attested'),
          argv: input.argv,
          cwdRealpath: input.cwdRealpath,
          repoRootRealpath: input.repoRootRealpath,
          startAuthority: input.startAuthority,
          finishAuthority,
          parsedEvents: parsed,
          auth: input.auth,
          authProvider: input.request.provider,
          authModelId: input.request.model,
          prompt: input.promptBytes,
          reportAbsPath: input.reportAbsPath,
          lifecycle: {
            status: 'completed',
            startTimeMs: input.startTimeMs,
            endTimeMs,
            exitCode: input.close.code,
            signal: input.close.signal,
            bytesWritten: outputBytes.length,
          },
        });
        await replaceFileDurable(
          paths.attestationAbsPath,
          `${JSON.stringify(attestation, null, 2)}\n`,
        );
        record.state = 'completed';
        await this.settle(control, 'completed');
        return;
      }

      await this.writeMetadata(
        paths,
        record,
        status,
        input.startTimeMs,
        input.close.code,
        input.close.signal,
        outputBytes.length,
      );
      record.state = status;
      record.error = error;
      if (status === 'killed') {
        if (control.cancelId !== undefined) {
          const ack = await this.client.cancelAck(
            record.serviceTaskId,
            control.nextSequence,
            control.cancelId,
          );
          control.nextSequence = ack.nextSequence;
        }
        await this.settle(control, 'killed');
        return;
      }
      await this.settle(control, 'failed', error ?? 'attested subagent Pi task failed');
    } catch (finalizationError) {
      const message = `attested subagent Pi task finalization failed: ${finalizationError instanceof Error ? finalizationError.message : String(finalizationError)}`;
      record.state = 'failed';
      record.error = message;
      this.logger.error(`[pi-subagent] ${message}`);
      await this.settle(control, 'failed', message);
    }
  }
}
