import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertWindowsCommandLineWithinLimit,
  canonicalJson,
  piLaunchArgv,
  replaceFileDurable,
  resolvePiLaunch,
} from '@sakiko233/pi-agent-runtime';
import { discardSubagentArtifactRoot, SubagentArtifactStore } from './artifacts.js';
import type { SubagentBackgroundClient } from './background-client.js';
import { SUBAGENT_INLINE_ANSWER_BYTES } from './budget.js';
import {
  buildSubagentChildArgv,
  ensureSubagentChildSessionDir,
  preflightSubagentLaunch,
  resolveSubagentAttributionExtensionPath,
  resolveSubagentChildExtensionPath,
  type SubagentPreflightInput,
  type SubagentPreflightResult,
  subagentChildEnv,
} from './launch.js';
import { type VerifiedSubagentResult, verifySubagentResultPackage } from './result-package.js';
import {
  SUBAGENT_ERROR_CODES,
  SUBAGENT_OUTCOME_SCHEMA_VERSION,
  type SubagentAutoDeliverMode,
  type SubagentBudgetRouteSource,
  SubagentError,
  type SubagentExtensionMode,
} from './types.js';

/**
 * Subagent run preparation, supervision, and terminal adjudication.
 *
 * The background-tasks service owns the registry entry, dock display, and the
 * terminal notification. This module owns everything the service does not: the
 * durable preflight, the child process, log streaming, cancellation routing,
 * and the adjudication of what the child actually committed. Ordering mirrors
 * the extracted source: preflight refusals create nothing, registration
 * failures destroy the prepared artifacts, and the committed result package is
 * the sole answer data plane.
 */

export interface SubagentRunFacts {
  taskId: string;
  launchNonce: string;
  artifactDir: string;
  artifactDirAbs: string;
  seedSha256: string;
  childSessionId: string;
  route: { provider: string; model: string; qualifiedId: string };
  budget: SubagentBudgetRouteSource;
  extensionMode: SubagentExtensionMode;
  autoDeliver: SubagentAutoDeliverMode;
}

export interface SubagentRunOutcome {
  status: 'committed' | 'failed' | 'cancelled';
  errorCode?: string | undefined;
  answerBytes?: number | undefined;
  answerSha256?: string | undefined;
  turns?: number | undefined;
  toolCalls?: number | undefined;
}

export interface PreparedSubagentLaunch {
  preflight: SubagentPreflightResult;
  store: SubagentArtifactStore;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  facts: SubagentRunFacts;
  childSessionDirAbs: string;
  seedPathAbs: string;
  /** Exact prompt bytes delivered to the child over stdin. */
  stdinBytes: Buffer;
}

export interface PrepareSubagentLaunchInput extends SubagentPreflightInput {
  cwd: string;
  sessionId: string | undefined;
  autoDeliver: SubagentAutoDeliverMode;
  childExtensionPath?: string | undefined;
  attributionExtensionPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Prepare a subagent launch.
 *
 * Preflight runs first and completes entirely before the artifact directory is
 * created, so every admission refusal leaves zero children AND zero artifacts.
 * When a step after directory creation fails, the partially created directory
 * is removed, so a refused launch never leaves a half-formed run behind.
 */
export async function prepareSubagentLaunch(
  input: PrepareSubagentLaunchInput,
): Promise<PreparedSubagentLaunch> {
  // Resolve the guard extension before anything is created: a package missing
  // its child guard must refuse rather than spawn an unguarded child.
  const childExtensionPath = input.childExtensionPath ?? resolveSubagentChildExtensionPath();
  const attributionExtensionPath =
    input.route.provider === 'anthropic'
      ? (input.attributionExtensionPath ?? resolveSubagentAttributionExtensionPath())
      : undefined;

  const preflight = preflightSubagentLaunch(input);

  const store = await SubagentArtifactStore.create({
    cwd: input.cwd,
    taskId: preflight.taskId,
    launchNonce: preflight.launchNonce,
    sessionId: input.sessionId,
    childSessionId: preflight.childSessionId,
    childSessionDir: '',
    extensionMode: input.extensionMode,
    route: input.route,
    limits: preflight.limits,
    seedSha256: preflight.seed.sha256,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  try {
    const seedRef = await store.writeSeed(preflight.seed.serialized);
    // The persisted seed bytes are the bytes the child reads. Nothing
    // re-serializes them between here and the child, and the child verifies the
    // hash before its first model call.
    if (seedRef.sha256 !== preflight.seed.sha256) {
      throw new SubagentError('subagent seed hash changed between construction and persistence', {
        code: 'seed_persist_failed',
        childCreated: false,
        taskId: preflight.taskId,
        artifactDir: store.artifactDir,
      });
    }
    await store.writeLedger(preflight.seed.ledger);
    await store.writeBudgetPlan(preflight.plan);
    const childSessionDirAbs = await ensureSubagentChildSessionDir(store.artifactDirAbs);
    const seedPathAbs = join(store.artifactDirAbs, 'seed.json');
    const argv = buildSubagentChildArgv({
      route: input.route,
      capability: input.capability,
      extensionMode: input.extensionMode,
      childSessionId: preflight.childSessionId,
      childSessionDir: childSessionDirAbs,
      childExtensionPath,
      attributionExtensionPath,
      systemPrompt: preflight.childSystemPrompt,
    });
    const env = subagentChildEnv(
      {
        artifactDirAbs: store.artifactDirAbs,
        seedPathAbs,
        seedSha256: preflight.seed.sha256,
        taskId: preflight.taskId,
        launchNonce: preflight.launchNonce,
      },
      input.env ?? process.env,
    );
    const facts: SubagentRunFacts = {
      taskId: preflight.taskId,
      launchNonce: preflight.launchNonce,
      artifactDir: store.artifactDir,
      artifactDirAbs: store.artifactDirAbs,
      seedSha256: preflight.seed.sha256,
      childSessionId: preflight.childSessionId,
      route: {
        provider: input.route.provider,
        model: input.route.model,
        qualifiedId: input.route.qualified_id,
      },
      budget: {
        family: preflight.plan.route.family,
        rate_source: preflight.plan.route.rate_source,
        conservative_rate_source: preflight.plan.conservative_estimate.rateSource,
      },
      extensionMode: input.extensionMode,
      autoDeliver: input.autoDeliver,
    };
    const stdinBytes = Buffer.from(preflight.childPrompt, 'utf8');
    // The persisted prompt bytes must equal the bytes sent to the child, so the
    // artifact is evidence of what the child actually received.
    await store.writeChildPrompt(stdinBytes);
    return {
      preflight,
      store,
      argv,
      env,
      facts,
      childSessionDirAbs,
      seedPathAbs,
      stdinBytes,
    };
  } catch (error) {
    // A failure after directory creation must not leave a half-formed run.
    await discardSubagentArtifactRoot(store.artifactDirAbs);
    throw error;
  }
}

export interface SubagentTerminalEvaluation {
  outcome: SubagentRunOutcome;
  result?: VerifiedSubagentResult | undefined;
  error?: SubagentError | undefined;
}

export interface EvaluateSubagentTerminalInput {
  artifactDirAbs: string;
  taskId: string;
  launchNonce: string;
  seedSha256: string;
  route: { provider: string; model: string };
  /** Terminal status observed by the run supervisor. */
  runStatus: 'completed' | 'failed' | 'killed';
  runError: string | undefined;
  /** Service-owned merged task output, when one exists. */
  serviceOutputPath?: string | undefined;
}

/**
 * Evaluate a finished subagent child.
 *
 * The committed result package is the sole answer data plane. Its presence
 * under its final name is the success signal; its absence means no answer was
 * accepted, whatever the process exit code happened to be. A child that exits
 * 0 without committing is a typed `child_exited_without_commit`, never a silent
 * empty success.
 */
export async function evaluateSubagentTerminal(
  input: EvaluateSubagentTerminalInput,
): Promise<SubagentTerminalEvaluation> {
  const evaluation = await adjudicateSubagentTerminal(input);
  // Record the parent's adjudicated view separately from the child-written
  // result package, so neither writer can overwrite the other's claim. A
  // failure to record the adjudication must not change the adjudication
  // itself, which is returned to the caller either way.
  try {
    await replaceFileDurable(
      join(input.artifactDirAbs, 'outcome.json'),
      `${canonicalJson({
        schema_version: SUBAGENT_OUTCOME_SCHEMA_VERSION,
        task_id: input.taskId,
        launch_nonce: input.launchNonce,
        observed_run_status: input.runStatus,
        outcome: evaluation.outcome,
        error_code: evaluation.error?.code ?? null,
      })}\n`,
    );
  } catch {
    // Deliberate: see above.
  }
  return evaluation;
}

async function adjudicateSubagentTerminal(
  input: EvaluateSubagentTerminalInput,
): Promise<SubagentTerminalEvaluation> {
  const resultPath = join(input.artifactDirAbs, 'result.json');
  const terminalPath = join(input.artifactDirAbs, 'child-terminal.json');
  if (!existsSync(resultPath)) {
    const recorded = existsSync(terminalPath) ? await readChildTerminal(terminalPath) : undefined;
    const cancelled = input.runStatus === 'killed';
    const code = recorded?.code ?? (cancelled ? 'child_cancelled' : 'child_exited_without_commit');
    const detail =
      recorded?.message ??
      input.runError ??
      'the subagent child exited without committing a result package';
    const preserved = [
      'seed.json',
      'budget-plan.json',
      'child-terminal.json',
      'runtime-budget.json',
    ].filter((name) => existsSync(join(input.artifactDirAbs, name)));
    if (input.serviceOutputPath !== undefined) preserved.push(input.serviceOutputPath);
    const diagnosticTargets = preserved.filter(
      (name) =>
        name === 'child-terminal.json' ||
        name === 'runtime-budget.json' ||
        name === input.serviceOutputPath,
    );
    const diagnostic =
      diagnosticTargets.length === 0
        ? 'No child terminal record or merged task output exists; inspect the preserved launch artifacts listed above.'
        : `Inspect the preserved diagnostic evidence: ${diagnosticTargets.join(', ')}.`;
    const error = new SubagentError(`subagent_run produced no committed answer: ${detail}`, {
      code: isSubagentErrorCode(code) ? code : 'child_exited_without_commit',
      childCreated: true,
      taskId: input.taskId,
      artifactDir: input.artifactDirAbs,
      preserved,
      remediation: [
        diagnostic,
        'No partial answer is returned; nothing was truncated to look like success.',
      ],
    });
    const outcome: SubagentRunOutcome = {
      status: cancelled ? 'cancelled' : 'failed',
      errorCode: error.code,
    };
    return { outcome, error };
  }

  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch (error) {
    const failure = new SubagentError(
      `subagent_run could not read its committed result package: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'artifact_read_failed',
        childCreated: true,
        taskId: input.taskId,
        artifactDir: input.artifactDirAbs,
      },
    );
    return { outcome: { status: 'failed', errorCode: failure.code }, error: failure };
  }

  try {
    const verified = verifySubagentResultPackage(raw, {
      taskId: input.taskId,
      launchNonce: input.launchNonce,
      seedSha256: input.seedSha256,
      route: input.route,
    });
    return {
      outcome: {
        status: 'committed',
        answerBytes: verified.package.answer.byte_length,
        answerSha256: verified.package.answer.sha256,
        turns: verified.package.turns,
        toolCalls: verified.package.tool_calls,
      },
      result: verified,
    };
  } catch (error) {
    if (error instanceof SubagentError) {
      return { outcome: { status: 'failed', errorCode: error.code }, error };
    }
    throw error;
  }
}

interface ChildTerminalRecord {
  code: string;
  message: string;
}

async function readChildTerminal(path: string): Promise<ChildTerminalRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const code: unknown = Reflect.get(parsed, 'code');
    const message: unknown = Reflect.get(parsed, 'message');
    if (typeof code !== 'string' || typeof message !== 'string') return undefined;
    return { code, message };
  } catch {
    // A missing or malformed child-terminal record must not mask the primary
    // "no committed answer" failure, which is reported by the caller either way.
    return undefined;
  }
}

const SUBAGENT_ERROR_CODE_SET = new Set<string>(SUBAGENT_ERROR_CODES);

function isSubagentErrorCode(value: string): value is SubagentError['code'] {
  return SUBAGENT_ERROR_CODE_SET.has(value);
}

/** Child process contract the supervisor depends on. Mirrors the extracted source's spawn surface. */
export interface SubagentChildProcess {
  pid?: number | undefined;
  stdin?: {
    write(data: Buffer, callback?: (error?: Error | null) => void): boolean;
    end(callback?: () => void): unknown;
    once(event: 'error', listener: (error: Error) => void): unknown;
  } | null;
  stdout?: { on(event: 'data', listener: (data: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (data: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type SubagentSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SubagentChildProcess;

export type SubagentRunState = 'running' | 'committed' | 'failed' | 'cancelled';

export interface SubagentRunRecord {
  readonly facts: SubagentRunFacts;
  /** Service-allocated registry task id; distinct from the subagent task id. */
  readonly serviceTaskId: string;
  state: SubagentRunState;
  error?: string | undefined;
  outcome?: SubagentRunOutcome | undefined;
  evaluation?: SubagentTerminalEvaluation | undefined;
  /** Usage is attached to a subagent_result response exactly once. */
  usageDelivered: boolean;
}

export type SubagentKillKind = 'user' | 'timeout' | 'shutdown' | 'output_cap' | 'startup';

interface RunControl {
  record: SubagentRunRecord;
  store: SubagentArtifactStore;
  child: SubagentChildProcess | undefined;
  startupError: string | undefined;
  killKind: SubagentKillKind | undefined;
  cancelId: string | undefined;
  closeObserved: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  nextSequence: number;
  chain: Promise<void>;
  chainError: unknown;
  /** Decoded child output waiting for the next sequenced log frame. */
  pendingLog: string;
  stdoutDecoder: TextDecoder;
  stderrDecoder: TextDecoder;
  forwardedOutputBytes: number;
  flushHandle: NodeJS.Timeout | undefined;
  timeoutHandle: NodeJS.Timeout | undefined;
  escalationHandle: NodeJS.Timeout | undefined;
  shuttingDown: boolean;
  settled: boolean;
  /** Service-owned merged task output path (display form), for diagnostics. */
  serviceOutputPath: string | undefined;
  terminal: Promise<SubagentRunRecord>;
  resolveTerminal: (record: SubagentRunRecord) => void;
}

/** Child output above this is refused rather than absorbed; the answer data plane is the artifact store. */
export const SUBAGENT_RUN_OUTPUT_CAP_BYTES = 20 * 1024 * 1024;
const LOG_FRAME_CHARS = 4000;
const DEFAULT_KILL_GRACE_MS = 3000;
const DEFAULT_LOG_FLUSH_MS = 200;
/** Settle error payloads are display strings; bound them explicitly. */
const SETTLE_ERROR_MAX_CHARS = 480;

export function boundedSettleError(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  if (compact.length <= SETTLE_ERROR_MAX_CHARS) return compact;
  return `${compact.slice(0, SETTLE_ERROR_MAX_CHARS - 1)}…`;
}

export interface SubagentRunSupervisorOptions {
  client: SubagentBackgroundClient;
  spawn?: SubagentSpawn | undefined;
  killProcess?: ((pid: number, signal?: NodeJS.Signals | number) => boolean) | undefined;
  platform?: NodeJS.Platform | undefined;
  logger?: Pick<Console, 'error'> | undefined;
  killGraceMs?: number | undefined;
  logFlushMs?: number | undefined;
  outputCapBytes?: number | undefined;
  /** Operability seam for tests: overrides the per-run timeout derived from limits. */
  timeoutOverrideMs?: number | undefined;
}

export interface StartSubagentRunInput {
  prepared: PreparedSubagentLaunch;
  name: string;
  description?: string | undefined;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
}

export class SubagentRunSupervisor {
  private readonly client: SubagentBackgroundClient;
  private readonly spawnImpl: SubagentSpawn;
  private readonly killProcess: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  private readonly platform: NodeJS.Platform;
  private readonly logger: Pick<Console, 'error'>;
  private readonly killGraceMs: number;
  private readonly logFlushMs: number;
  private readonly outputCapBytes: number;
  private readonly timeoutOverrideMs: number | undefined;
  private readonly controls = new Map<string, RunControl>();
  private readonly byServiceTaskId = new Map<string, RunControl>();
  private readonly offCancellation: () => void;

  constructor(options: SubagentRunSupervisorOptions) {
    this.client = options.client;
    this.spawnImpl = options.spawn ?? (nodeSpawn as unknown as SubagentSpawn);
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.logFlushMs = options.logFlushMs ?? DEFAULT_LOG_FLUSH_MS;
    this.outputCapBytes = options.outputCapBytes ?? SUBAGENT_RUN_OUTPUT_CAP_BYTES;
    this.timeoutOverrideMs = options.timeoutOverrideMs;
    this.offCancellation = this.client.onCancellation((frame) => this.handleCancellation(frame));
  }

  list(): readonly SubagentRunRecord[] {
    return [...this.controls.values()].map((control) => control.record);
  }

  /** Resolve a subagent task id exactly, then by unambiguous prefix. */
  resolve(idOrPrefix: string): SubagentRunRecord {
    const id = idOrPrefix.trim();
    if (id.length === 0) {
      throw new SubagentError('subagent_result requires a task id', {
        code: 'task_unknown',
        childCreated: false,
      });
    }
    const exact = this.controls.get(id);
    if (exact !== undefined) return exact.record;
    const matches = [...this.controls.keys()].filter((key) => key.startsWith(id));
    const only = matches[0];
    if (matches.length === 1 && only !== undefined) {
      const control = this.controls.get(only);
      if (control !== undefined) return control.record;
    }
    if (matches.length > 1) {
      throw new SubagentError(
        `subagent task id prefix "${id}" is ambiguous: ${matches.join(', ')}`,
        { code: 'task_unknown', childCreated: false },
      );
    }
    throw new SubagentError(`subagent_result does not know subagent task ${id}: unknown task`, {
      code: 'task_unknown',
      childCreated: false,
      remediation: [
        'Pass the subagent task id from the subagent_run receipt (s…), not the background registry id.',
      ],
    });
  }

  /**
   * Register and spawn one prepared subagent run.
   *
   * Durable preflight has already happened inside `prepared`. Registration with
   * the background service is the commit point for the visible task: when the
   * service rejects registration the prepared artifacts are destroyed and no
   * child is spawned.
   */
  async start(input: StartSubagentRunInput): Promise<SubagentRunRecord> {
    const prepared = input.prepared;
    let registered: Awaited<ReturnType<SubagentBackgroundClient['register']>>;
    try {
      registered = await this.client.register({
        ownerRef: prepared.facts.taskId,
        name: input.name,
        description: input.description,
        cancellable: true,
        rerunnable: false,
        notifyOnCompletion: input.notifyOnCompletion,
        triggerOnCompletion: input.triggerOnCompletion,
      });
    } catch (error) {
      await discardSubagentArtifactRoot(prepared.store.artifactDirAbs);
      throw error;
    }

    let resolveTerminal!: (record: SubagentRunRecord) => void;
    const terminal = new Promise<SubagentRunRecord>((resolve) => {
      resolveTerminal = resolve;
    });
    const record: SubagentRunRecord = {
      facts: prepared.facts,
      serviceTaskId: registered.task.id,
      state: 'running',
      usageDelivered: false,
    };
    const control: RunControl = {
      record,
      store: prepared.store,
      child: undefined,
      startupError: undefined,
      killKind: undefined,
      cancelId: undefined,
      closeObserved: undefined,
      nextSequence: registered.nextSequence,
      serviceOutputPath: registered.task.outputPath,
      chain: Promise.resolve(),
      chainError: undefined,
      pendingLog: '',
      stdoutDecoder: new TextDecoder('utf-8'),
      stderrDecoder: new TextDecoder('utf-8'),
      forwardedOutputBytes: 0,
      flushHandle: undefined,
      timeoutHandle: undefined,
      escalationHandle: undefined,
      shuttingDown: false,
      settled: false,
      terminal,
      resolveTerminal,
    };
    this.controls.set(prepared.facts.taskId, control);
    this.byServiceTaskId.set(registered.task.id, control);

    try {
      const launch = resolvePiLaunch({ platform: this.platform });
      assertWindowsCommandLineWithinLimit(launch, prepared.argv, this.platform, 'subagent-run');
      const child = this.spawnImpl(launch.executable, piLaunchArgv(launch, prepared.argv), {
        cwd: prepared.store.snapshot().cwd,
        detached: this.platform !== 'win32',
        shell: false,
        // The seed travels over stdin, never as a shell or positional argument,
        // so the bytes the child reads are exactly the bytes that were persisted
        // and hashed, with no quoting or command-line length limit in the path.
        stdio: ['pipe', 'pipe', 'pipe'],
        env: prepared.env,
        windowsHide: true,
      });
      control.child = child;
      this.wireChild(control, child, prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      control.startupError = message;
      control.record.state = 'failed';
      control.record.error = `child_spawn_failed: ${message}`;
      control.record.outcome = { status: 'failed', errorCode: 'child_spawn_failed' };
      this.enqueue(control, async () => {
        await control.store.writeError('failed', `child_spawn_failed: ${message}`);
        await this.settle(control, 'failed', `child_spawn_failed: ${message}`);
      });
      this.finish(control);
      return record;
    }

    const timeoutMs = this.timeoutOverrideMs ?? prepared.preflight.limits.timeout_seconds * 1000;
    control.timeoutHandle = setTimeout(() => {
      if (control.settled || control.closeObserved !== undefined) return;
      control.killKind = 'timeout';
      control.startupError = undefined;
      control.record.error = `child_timeout: the subagent child exceeded its ${String(prepared.preflight.limits.timeout_seconds)}s timeout`;
      this.killChild(control);
    }, timeoutMs);

    return record;
  }

  /** Resolve with the record once the run has fully settled through the service. */
  whenSettled(taskId: string): Promise<SubagentRunRecord> {
    const control = this.controls.get(taskId);
    if (control === undefined) {
      throw new SubagentError(`subagent supervisor does not know task ${taskId}`, {
        code: 'task_unknown',
        childCreated: false,
      });
    }
    return control.terminal;
  }

  /**
   * Kill every running child and wait for settlement.
   *
   * The background service also cancels external tasks during its own shutdown;
   * whichever path reaches a run first kills the child, and the close path
   * performs the cancel acknowledgement (when a frame arrived) and the killed
   * settlement exactly once.
   */
  async shutdown(reason: string): Promise<void> {
    for (const control of this.controls.values()) {
      if (control.settled || control.record.state !== 'running') continue;
      control.shuttingDown = true;
      control.killKind ??= 'shutdown';
      control.record.error = reason;
      this.killChild(control);
    }
    await Promise.all([...this.controls.values()].map((control) => control.terminal));
  }

  close(): void {
    this.offCancellation();
  }

  private wireChild(
    control: RunControl,
    child: SubagentChildProcess,
    prepared: PreparedSubagentLaunch,
  ): void {
    child.on('error', (error) => {
      control.startupError = error.message;
      this.appendLog(control, `\n[subagent spawn error: ${error.message}]\n`);
    });
    child.on('close', (code, signal) => {
      control.closeObserved = { code, signal };
      this.clearTimers(control);
      // Flush the decoder tails and every pending log byte before adjudication,
      // so the service observes all child output before the terminal settle.
      control.pendingLog += control.stdoutDecoder.decode() + control.stderrDecoder.decode();
      this.enqueue(control, () => this.flushPendingLog(control));
      this.enqueue(control, () => this.finalizeRun(control, prepared));
    });
    child.stdout?.on('data', (data) => this.captureOutput(control, 'stdout', data));
    child.stderr?.on('data', (data) => this.captureOutput(control, 'stderr', data));
    this.writeStdin(control, child, prepared.stdinBytes);
  }

  private writeStdin(control: RunControl, child: SubagentChildProcess, bytes: Buffer): void {
    const stdin = child.stdin;
    if (stdin === undefined || stdin === null) {
      control.startupError = 'subagent child has no stdin pipe';
      control.killKind = 'startup';
      this.killChild(control);
      return;
    }
    stdin.once('error', (error) => {
      control.startupError = `subagent seed could not be delivered: ${error.message}`;
      control.killKind = 'startup';
      this.appendLog(control, `\n[subagent stdin write failed: ${error.message}]\n`);
      this.killChild(control);
    });
    stdin.write(bytes, (error) => {
      if (error) {
        control.startupError = `subagent seed could not be delivered: ${error.message}`;
        control.killKind = 'startup';
        this.killChild(control);
        return;
      }
      stdin.end();
    });
  }

  private captureOutput(
    control: RunControl,
    source: 'stdout' | 'stderr',
    data: Buffer | string,
  ): void {
    if (control.settled) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    control.forwardedOutputBytes += bytes.length;
    if (control.forwardedOutputBytes > this.outputCapBytes) {
      if (control.killKind === undefined) {
        control.killKind = 'output_cap';
        control.record.error = `subagent child output cap exceeded: forwarded output passed the ${String(this.outputCapBytes)}-byte cap; the run was stopped rather than absorbing unbounded output`;
        this.appendLog(control, `\n[subagent output cap exceeded: ${control.record.error}]\n`);
        this.killChild(control);
      }
      return;
    }
    // Streaming decode keeps multibyte characters split across chunks intact.
    const decoder = source === 'stdout' ? control.stdoutDecoder : control.stderrDecoder;
    const text = decoder.decode(bytes, { stream: true });
    if (text.length > 0) this.appendLog(control, text);
  }

  private appendLog(control: RunControl, text: string): void {
    control.pendingLog += text;
    if (control.flushHandle === undefined && !control.shuttingDown) {
      control.flushHandle = setTimeout(() => {
        control.flushHandle = undefined;
        this.enqueue(control, () => this.flushPendingLog(control));
      }, this.logFlushMs);
    }
  }

  /**
   * Flush pending child output into sequenced service log frames.
   *
   * Sequences are assigned at execution time inside the chain, so the service
   * observes operations strictly in chain order. While the service is shutting
   * down it accepts only cancel_ack and settle; leftover log bytes are dropped
   * here explicitly rather than producing rejected requests.
   */
  private async flushPendingLog(control: RunControl): Promise<void> {
    if (control.flushHandle !== undefined) {
      clearTimeout(control.flushHandle);
      control.flushHandle = undefined;
    }
    while (control.pendingLog.length > 0) {
      let frame = control.pendingLog;
      if (frame.length > LOG_FRAME_CHARS) {
        let cut = LOG_FRAME_CHARS;
        const code = frame.charCodeAt(cut - 1);
        // Never split a surrogate pair across frames.
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
        frame = frame.slice(0, cut);
      }
      control.pendingLog = control.pendingLog.slice(frame.length);
      if (control.shuttingDown) continue;
      const sequence = control.nextSequence;
      const result = await this.client.log(control.record.serviceTaskId, sequence, frame);
      control.nextSequence = result.nextSequence;
    }
  }

  private enqueue(control: RunControl, op: () => Promise<void>): void {
    const run = control.chain.then(op);
    control.chain = run.catch((error: unknown) => {
      // A service-side failure is recorded, not hidden: the local record stays
      // truthful about what could no longer be reported to the service.
      control.chainError = error;
      this.logger.error(
        `[pi-subagent] background service operation failed for ${control.record.facts.taskId}:`,
        error,
      );
    });
  }

  private async settle(
    control: RunControl,
    status: 'completed' | 'failed' | 'killed',
    error?: string,
  ): Promise<void> {
    const sequence = control.nextSequence;
    const result = await this.client.settle(
      control.record.serviceTaskId,
      sequence,
      status,
      error === undefined ? undefined : boundedSettleError(error),
    );
    control.nextSequence = result.nextSequence;
  }

  private async finalizeRun(control: RunControl, prepared: PreparedSubagentLaunch): Promise<void> {
    // Settlement must conclude even when a service operation fails: the local
    // record is the owner's terminal truth, and the chain records the failure.
    try {
      await this.concludeRun(control, prepared);
    } finally {
      this.finish(control);
    }
  }

  private async concludeRun(control: RunControl, prepared: PreparedSubagentLaunch): Promise<void> {
    const close = control.closeObserved;
    if (close === undefined) throw new Error('subagent run finalized before close was observed');

    if (control.killKind === 'user' || control.killKind === 'shutdown') {
      if (control.cancelId !== undefined) {
        const sequence = control.nextSequence;
        control.nextSequence += 1;
        const ack = await this.client.cancelAck(
          control.record.serviceTaskId,
          sequence,
          control.cancelId,
        );
        control.nextSequence = ack.nextSequence;
      }
      const reason = control.record.error ?? 'the subagent run was cancelled';
      const evaluation = await evaluateSubagentTerminal({
        artifactDirAbs: prepared.store.artifactDirAbs,
        taskId: prepared.facts.taskId,
        launchNonce: prepared.facts.launchNonce,
        seedSha256: prepared.facts.seedSha256,
        route: { provider: prepared.facts.route.provider, model: prepared.facts.route.model },
        runStatus: 'killed',
        runError: reason,
        serviceOutputPath: control.serviceOutputPath,
      });
      control.record.evaluation = evaluation;
      control.record.outcome = evaluation.outcome;
      control.record.state = 'cancelled';
      await control.store.writeError('cancelled', reason);
      await this.settle(control, 'killed');
      return;
    }

    const failed =
      control.killKind !== undefined ||
      control.startupError !== undefined ||
      (close.code ?? 0) !== 0;
    const runError =
      control.record.error ??
      control.startupError ??
      (failed
        ? `Exited with code ${close.code === null ? 'null' : String(close.code)}${close.signal === null ? '' : ` (${close.signal})`}`
        : undefined);
    const evaluation = await evaluateSubagentTerminal({
      artifactDirAbs: prepared.store.artifactDirAbs,
      taskId: prepared.facts.taskId,
      launchNonce: prepared.facts.launchNonce,
      seedSha256: prepared.facts.seedSha256,
      route: { provider: prepared.facts.route.provider, model: prepared.facts.route.model },
      runStatus: failed ? 'failed' : 'completed',
      runError,
      serviceOutputPath: control.serviceOutputPath,
    });
    control.record.evaluation = evaluation;
    control.record.outcome = evaluation.outcome;
    if (evaluation.outcome.status === 'committed' && evaluation.result !== undefined) {
      control.record.state = 'committed';
      await control.store.setState('committed');
      const answerBytes = evaluation.result.package.answer.byte_length;
      const autoDeliver = prepared.facts.autoDeliver;
      if (
        !control.shuttingDown &&
        (autoDeliver === 'always' ||
          (autoDeliver === 'when_small' && answerBytes <= SUBAGENT_INLINE_ANSWER_BYTES))
      ) {
        const sequence = control.nextSequence;
        control.nextSequence += 1;
        const delivery = await this.client.log(
          control.record.serviceTaskId,
          sequence,
          `[subagent auto-delivered answer]\n${evaluation.result.answer}`,
        );
        control.nextSequence = delivery.nextSequence;
      }
      await this.settle(control, 'completed');
    } else {
      control.record.state = 'failed';
      const failure =
        evaluation.error ??
        new SubagentError('subagent run failed', {
          code: 'result_unavailable',
          childCreated: true,
          taskId: prepared.facts.taskId,
        });
      // A supervisor-owned terminal cause (timeout, output cap, failed startup)
      // is more precise than the artifact adjudication's generic no-commit code;
      // it overrides the reported code and leads the settle error.
      const supervisorCode =
        control.killKind === 'timeout'
          ? 'child_timeout'
          : control.killKind === 'startup'
            ? 'child_startup_failed'
            : undefined;
      const reportedCode = supervisorCode ?? failure.code;
      const reportedMessage =
        supervisorCode === undefined || runError === undefined
          ? failure.message
          : `${runError} ${failure.message}`;
      control.record.outcome = { ...evaluation.outcome, errorCode: reportedCode };
      control.record.error = `${reportedCode}: ${reportedMessage}`;
      await control.store.writeError('failed', control.record.error);
      await this.settle(control, 'failed', `${reportedCode}: ${reportedMessage}`);
    }
  }

  private finish(control: RunControl): void {
    this.clearTimers(control);
    // The terminal promise resolves only after every queued service operation
    // (final log flush, cancel ack, settle) has drained, so observers awaiting
    // settlement never race the service.
    void control.chain.then(() => {
      control.settled = true;
      control.resolveTerminal(control.record);
    });
  }

  private clearTimers(control: RunControl): void {
    if (control.timeoutHandle !== undefined) {
      clearTimeout(control.timeoutHandle);
      control.timeoutHandle = undefined;
    }
    if (control.escalationHandle !== undefined) {
      clearTimeout(control.escalationHandle);
      control.escalationHandle = undefined;
    }
    if (control.flushHandle !== undefined) {
      clearTimeout(control.flushHandle);
      control.flushHandle = undefined;
    }
  }

  private handleCancellation(frame: { taskId: string; cancelId: string; reason: string }): void {
    const control = this.byServiceTaskId.get(frame.taskId);
    if (control === undefined || control.settled) return;
    control.cancelId = frame.cancelId;
    control.killKind ??= 'user';
    control.record.error = frame.reason;
    if (control.closeObserved === undefined) this.killChild(control);
  }

  private killChild(control: RunControl): void {
    if (control.closeObserved !== undefined) return;
    const child = control.child;
    if (child === undefined) return;
    const pid = child.pid;
    if (this.platform === 'win32') {
      child.kill('SIGTERM');
      return;
    }
    if (pid === undefined) {
      // A child without a pid errored at spawn; its error/close path settles.
      return;
    }
    try {
      this.killProcess(-pid, 'SIGTERM');
    } catch (error) {
      // The process group is gone exactly when the child already exited; the
      // close event then carries settlement. Anything else is reported.
      if (control.closeObserved === undefined) {
        this.logger.error(
          `[pi-subagent] process-group kill failed for ${control.record.facts.taskId}:`,
          error,
        );
      }
    }
    control.escalationHandle = setTimeout(() => {
      if (control.closeObserved !== undefined || control.settled) return;
      try {
        this.killProcess(-pid, 'SIGKILL');
      } catch (error) {
        if (control.closeObserved === undefined) {
          this.logger.error(
            `[pi-subagent] escalation kill failed for ${control.record.facts.taskId}:`,
            error,
          );
        }
      }
    }, this.killGraceMs);
  }
}
