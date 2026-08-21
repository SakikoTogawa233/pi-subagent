import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Usage } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { type Static, Type } from 'typebox';
import type { StructuredSubagentPiLaunchRequest, SubagentAttestedSupervisor } from './attested.js';
import type { ExternalTaskSnapshot } from './background-client.js';
import { type ConnectOptions, SubagentBackgroundClient } from './background-client.js';
import { truncateChars } from './common.js';
import {
  loadSubagentHookContractEvidence,
  type SubagentHookContractEvidence,
} from './hook-contract.js';
import {
  loadAttestedModule,
  loadBudgetModule,
  loadLaunchModule,
  loadRunnerModule,
} from './lazy.js';
import type { SubagentRunSupervisor, SubagentSpawn } from './runner.js';
import {
  SUBAGENT_ATTESTED_LAUNCH_DETAILS_SCHEMA_VERSION,
  SUBAGENT_AUTO_DELIVER_MODES,
  SUBAGENT_CAPABILITIES,
  SUBAGENT_DEFAULT_MAX_TOOL_CALLS,
  SUBAGENT_DEFAULT_MAX_TURNS,
  SUBAGENT_DEFAULT_TIMEOUT_SECONDS,
  SUBAGENT_EXTENSION_MODES,
  SUBAGENT_LAUNCH_DETAILS_SCHEMA_VERSION,
  SUBAGENT_RESULT_TOOL_NAME,
  SUBAGENT_RESULT_VIEW_SCHEMA_VERSION,
  SUBAGENT_RUN_ATTESTED_TOOL_NAME,
  SUBAGENT_RUN_TOOL_NAME,
  type SubagentAutoDeliverMode,
  type SubagentBudgetRouteSource,
  type SubagentCapability,
  type SubagentDeliveryMode,
  SubagentError,
  type SubagentExtensionMode,
  type SubagentRoute,
} from './types.js';

/**
 * pi-subagent entrypoint.
 *
 * Startup gating: at session start the extension completes the background
 * external-task v2 handshake. When no unique compatible service answers, the
 * dependency error is reported loudly and NONE of the three tools is
 * registered. On success exactly `subagent_run`, `subagent_result`, and
 * `subagent_run_attested` are registered.
 *
 * Startup cost: this module and its static import closure stay light on
 * purpose. The heavy graphs (`./runner.js`, `./launch.js`, `./budget.js`,
 * `./attested.js`, and through them `@sakiko233/pi-agent-runtime`) cost
 * ~660-720 ms of jiti transpile on every Pi start, so they are imported
 * lazily at first tool execution through `./lazy.js`. The contract is pinned
 * by `test/startup-import-contract.test.ts`; the budget by
 * `scripts/startup-budget.mjs`.
 */

/** Shipped copy of the observed Pi hook-contract evidence, loaded once per launch. */
const HOOK_EVIDENCE_PATH = fileURLToPath(new URL('./hook-contract-evidence.json', import.meta.url));

export const SubagentRunParams = Type.Object(
  {
    name: Type.String({
      description: 'Short human-readable task name shown in the bg footer dock. Use 2-6 words.',
    }),
    prompt: Type.String({
      description:
        'Authoritative instruction for the subagent. The projected conversation is supporting background only.',
    }),
    route: Type.Optional(
      Type.Object(
        {
          provider: Type.String({ description: 'Exact provider name to pin.' }),
          model: Type.String({ description: 'Exact provider-local model id to pin.' }),
        },
        {
          additionalProperties: false,
          description: 'Explicit route. Defaults to the current model.',
        },
      ),
    ),
    capability: Type.Optional(
      Type.String({
        description:
          'Capability profile. Only "inspect" (read/search/list, no shell, no writes, no network, no recursion) is supported.',
      }),
    ),
    extensionMode: Type.Optional(
      Type.String({
        description:
          'Extension discovery: isolated | ambient. Default isolated. Ambient is for extension-registered providers and executes arbitrary discovered extension code, weakening process isolation.',
      }),
    ),
    maxTurns: Type.Optional(
      Type.Number({
        description: `Maximum agent turns. Default ${String(SUBAGENT_DEFAULT_MAX_TURNS)}.`,
      }),
    ),
    maxToolCalls: Type.Optional(
      Type.Number({
        description: `Maximum tool calls. Default ${String(SUBAGENT_DEFAULT_MAX_TOOL_CALLS)}.`,
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: `Wall-clock timeout. Default ${String(SUBAGENT_DEFAULT_TIMEOUT_SECONDS)}.`,
      }),
    ),
    autoDeliver: Type.Optional(
      Type.String({
        description:
          'Whether the completion log carries the verified answer: never | when_small | always. Default never; retrieve with subagent_result.',
      }),
    ),
    notifyOnCompletion: Type.Optional(
      Type.Boolean({ description: 'Deliver the durable terminal notification. Default true.' }),
    ),
    triggerOnCompletion: Type.Optional(
      Type.Boolean({ description: 'Let that notification start a follow-up turn. Default true.' }),
    ),
  },
  { additionalProperties: false },
);

export const SubagentResultParams = Type.Object(
  {
    taskId: Type.String({
      description: 'Subagent task id from the subagent_run receipt (s…).',
    }),
    delivery: Type.Optional(
      Type.String({
        description:
          'inline returns the verified answer text; artifact returns metadata plus the artifact reference. Oversized answers are never truncated.',
      }),
    ),
  },
  { additionalProperties: false },
);

export const SubagentAttestedParams = Type.Object(
  {
    name: Type.String({ description: 'Short human-readable name for this attested Pi task.' }),
    provider: Type.String({
      description: 'Exact Pi provider to launch, for example openai-codex or anthropic.',
    }),
    model: Type.String({ description: 'Exact provider-local Pi model id to launch.' }),
    prompt: Type.String({ description: 'Prompt bytes passed as the single user prompt to Pi.' }),
    reportPath: Type.String({
      description:
        'Relative path, inside the task cwd, that the child Pi run must write as its report.',
    }),
    extraPiArgs: Type.Optional(
      Type.Array(
        Type.String({
          description:
            'Additional literal Pi argv entries; mode/provider/model/api-key args are rejected.',
        }),
      ),
    ),
    thinking: Type.Optional(Type.String({ description: 'Optional Pi thinking level argument.' })),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: 'Optional timeout; task is failed and killed when exceeded' }),
    ),
  },
  { additionalProperties: false },
);

type SubagentRunParamsValue = Static<typeof SubagentRunParams>;
type SubagentResultParamsValue = Static<typeof SubagentResultParams>;
type SubagentAttestedParamsValue = Static<typeof SubagentAttestedParams>;

const RUN_PARAM_KEYS = new Set([
  'name',
  'prompt',
  'route',
  'capability',
  'extensionMode',
  'maxTurns',
  'maxToolCalls',
  'timeoutSeconds',
  'autoDeliver',
  'notifyOnCompletion',
  'triggerOnCompletion',
]);
const RESULT_PARAM_KEYS = new Set(['taskId', 'delivery']);
const ATTESTED_PARAM_KEYS = new Set([
  'name',
  'provider',
  'model',
  'prompt',
  'reportPath',
  'extraPiArgs',
  'thinking',
  'timeoutSeconds',
]);

export interface SubagentLaunchDetails {
  schema_version: typeof SUBAGENT_LAUNCH_DETAILS_SCHEMA_VERSION;
  /** Subagent-owned task id; pass this to subagent_result. */
  task_id: string;
  launch_nonce: string;
  /** Service-allocated background registry snapshot. */
  service_task: ExternalTaskSnapshot;
  route: { provider: string; model: string; qualified_id: string; origin: string };
  child_session_id: string;
  artifact_dir: string;
  seed_sha256: string;
  seed_utf8_bytes: number;
  budget: SubagentBudgetRouteSource;
  extension_mode: SubagentExtensionMode;
  auto_deliver: SubagentAutoDeliverMode;
  notify_on_completion: boolean;
  trigger_on_completion: boolean;
}

export interface SubagentResultViewDetails {
  schema_version: typeof SUBAGENT_RESULT_VIEW_SCHEMA_VERSION;
  task_id: string;
  state: 'running' | 'committed' | 'failed' | 'cancelled';
  delivery: SubagentDeliveryMode | 'none';
  route?: { provider: string; model: string } | undefined;
  budget?: SubagentBudgetRouteSource | undefined;
  extension_mode?: SubagentExtensionMode | undefined;
  answer_bytes?: number | undefined;
  answer_sha256?: string | undefined;
  turns?: number | undefined;
  tool_calls?: number | undefined;
  usage?: { status: string } | undefined;
  usage_delivered?: boolean | undefined;
  artifact_dir?: string | undefined;
  error_code?: string | undefined;
}

export interface SubagentAttestedLaunchDetails {
  schema_version: typeof SUBAGENT_ATTESTED_LAUNCH_DETAILS_SCHEMA_VERSION;
  task_id: string;
  service_task: ExternalTaskSnapshot;
  provider: string;
  model: string;
  output_path: string;
  attestation_path: string;
  report_path: string;
}

function textContent(text: string) {
  return [{ type: 'text' as const, text }];
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  args: Record<PropertyKey, unknown>,
  allowed: Set<string>,
  tool: string,
): void {
  const unknownKeys = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new SubagentError(
      `${tool} contains unsupported key(s): ${unknownKeys.sort().join(', ')}`,
      { code: 'invalid_arguments', childCreated: false },
    );
  }
}

function requireCapability(value: unknown): SubagentCapability {
  if (value === undefined) return 'inspect';
  if (value === 'inspect') return 'inspect';
  throw new SubagentError(
    `subagent_run capability must be one of ${SUBAGENT_CAPABILITIES.join(', ')}. Writable profiles are deliberately out of scope in this version.`,
    { code: 'invalid_arguments', childCreated: false },
  );
}

function requireExtensionMode(value: unknown): SubagentExtensionMode {
  if (value === undefined) return 'isolated';
  if (value === 'isolated' || value === 'ambient') return value;
  throw new SubagentError(
    `subagent_run extensionMode must be one of ${SUBAGENT_EXTENSION_MODES.join(', ')}`,
    { code: 'invalid_arguments', childCreated: false },
  );
}

function requireAutoDeliver(value: unknown): SubagentAutoDeliverMode {
  if (value === undefined) return 'never';
  if (value === 'never' || value === 'when_small' || value === 'always') return value;
  throw new SubagentError(
    `subagent_run autoDeliver must be one of ${SUBAGENT_AUTO_DELIVER_MODES.join(', ')}`,
    { code: 'invalid_arguments', childCreated: false },
  );
}

function requireDelivery(value: unknown): SubagentDeliveryMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'inline' || value === 'artifact') return value;
  throw new SubagentError('subagent_result delivery must be inline or artifact', {
    code: 'invalid_arguments',
    childCreated: false,
  });
}

function requireRoute(value: unknown): SubagentRoute | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new SubagentError('subagent_run route must be an object', {
      code: 'invalid_arguments',
      childCreated: false,
    });
  }
  const provider = value['provider'];
  const model = value['model'];
  if (typeof provider !== 'string' || provider.length === 0)
    throw new SubagentError('subagent_run route.provider must be a non-empty string', {
      code: 'invalid_arguments',
      childCreated: false,
    });
  if (typeof model !== 'string' || model.length === 0)
    throw new SubagentError('subagent_run route.model must be a non-empty string', {
      code: 'invalid_arguments',
      childCreated: false,
    });
  return { provider, model };
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new SubagentError(`subagent_run ${label} must be a positive integer`, {
      code: 'invalid_arguments',
      childCreated: false,
    });
  }
  return value;
}

export interface SubagentExtensionDeps {
  connectOptions?: ConnectOptions | undefined;
  spawn?: SubagentSpawn | undefined;
  killProcess?: ((pid: number, signal?: NodeJS.Signals | number) => boolean) | undefined;
  platform?: NodeJS.Platform | undefined;
  logger?: Pick<Console, 'error'> | undefined;
  killGraceMs?: number | undefined;
  logFlushMs?: number | undefined;
  outputCapBytes?: number | undefined;
  timeoutOverrideMs?: number | undefined;
  /** Overridable so tests can supply observed evidence without touching disk. */
  loadHookEvidence?: (() => Promise<SubagentHookContractEvidence>) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

const DEFAULT_CONNECT_OPTIONS: ConnectOptions = {
  timeoutMs: 2_000,
  graceMs: 50,
  ownerTag: 'primary',
};

async function defaultHookEvidence(): Promise<SubagentHookContractEvidence> {
  let raw: string;
  try {
    raw = await readFile(HOOK_EVIDENCE_PATH, 'utf8');
  } catch (error) {
    throw new SubagentError(
      `subagent_run cannot verify the Pi hook contract: the recorded evidence at ${HOOK_EVIDENCE_PATH} is unreadable (${error instanceof Error ? error.message : String(error)}). No child was created.`,
      {
        code: 'subagent_hook_contract_unsupported',
        childCreated: false,
        remediation: [
          'Run the Pi hook characterisation gate to regenerate the evidence for this Pi build.',
          'The guard is never bypassed when its evidence is missing.',
        ],
      },
    );
  }
  return loadSubagentHookContractEvidence(raw);
}

interface SessionState {
  client: SubagentBackgroundClient;
  /** Constructed at first subagent_run/subagent_result call, never at startup. */
  runs: Promise<SubagentRunSupervisor> | undefined;
  /** Constructed at first subagent_run_attested call, never at startup. */
  attested: Promise<SubagentAttestedSupervisor> | undefined;
}

export function createSubagentExtension(deps: SubagentExtensionDeps = {}) {
  const logger = deps.logger ?? console;

  const ensureRuns = (session: SessionState): Promise<SubagentRunSupervisor> => {
    if (session.runs === undefined) {
      session.runs = (async () => {
        const { SubagentRunSupervisor: Supervisor } = await loadRunnerModule();
        return new Supervisor({
          client: session.client,
          spawn: deps.spawn,
          killProcess: deps.killProcess,
          platform: deps.platform,
          logger,
          killGraceMs: deps.killGraceMs,
          logFlushMs: deps.logFlushMs,
          outputCapBytes: deps.outputCapBytes,
          timeoutOverrideMs: deps.timeoutOverrideMs,
        });
      })();
    }
    return session.runs;
  };

  const ensureAttested = (session: SessionState): Promise<SubagentAttestedSupervisor> => {
    if (session.attested === undefined) {
      session.attested = (async () => {
        const { SubagentAttestedSupervisor: Supervisor } = await loadAttestedModule();
        return new Supervisor({
          client: session.client,
          spawn: deps.spawn,
          killProcess: deps.killProcess,
          platform: deps.platform,
          logger,
          killGraceMs: deps.killGraceMs,
          timeoutOverrideMs: deps.timeoutOverrideMs,
        });
      })();
    }
    return session.attested;
  };

  return function subagentExtension(pi: ExtensionAPI): void {
    let state: SessionState | undefined;
    let toolsRegistered = false;

    const requireState = (): SessionState => {
      if (state === undefined) {
        // Unreachable through the model-visible surface: tools exist only after
        // a successful handshake. A direct call before that is a loud error.
        throw new SubagentError(
          'pi-subagent is not connected to the pi-background-tasks service; the handshake has not completed in this session.',
          { code: 'background_service_unavailable', childCreated: false },
        );
      }
      return state;
    };

    pi.on('session_start', async (_event, ctx) => {
      let client: SubagentBackgroundClient;
      try {
        client = await SubagentBackgroundClient.connect(
          pi.events,
          deps.connectOptions ?? DEFAULT_CONNECT_OPTIONS,
        );
      } catch (error) {
        reportDependencyFailure(pi, ctx, error);
        return;
      }
      state = { client, runs: undefined, attested: undefined };
      if (!toolsRegistered) {
        registerSubagentTools(
          pi,
          requireState,
          ensureRuns,
          ensureAttested,
          deps.loadHookEvidence ?? defaultHookEvidence,
        );
        toolsRegistered = true;
      }
    });

    pi.on('session_shutdown', async () => {
      const current = state;
      state = undefined;
      if (current === undefined) return;
      const reason = 'Killed during Pi session shutdown/reload';
      const shutdowns: Promise<void>[] = [];
      const runsPromise = current.runs;
      if (runsPromise !== undefined) {
        shutdowns.push(
          (async () => {
            const supervisor = await runsPromise;
            await supervisor.shutdown(reason);
            supervisor.close();
          })(),
        );
      }
      const attestedPromise = current.attested;
      if (attestedPromise !== undefined) {
        shutdowns.push(
          (async () => {
            const supervisor = await attestedPromise;
            await supervisor.shutdown(reason);
            supervisor.close();
          })(),
        );
      }
      await Promise.all(shutdowns);
    });
  };

  function reportDependencyFailure(pi: ExtensionAPI, ctx: ExtensionContext, error: unknown): void {
    const message = `[pi-subagent] dependency error: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(message);
    if (ctx.hasUI) ctx.ui.notify(message, 'error');
    pi.sendMessage(
      {
        customType: 'pi-subagent-dependency-error',
        content: `${message} The subagent_run, subagent_result, and subagent_run_attested tools are NOT available in this session.`,
        display: true,
        details: {
          code: isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'unknown',
        },
      },
      { deliverAs: 'nextTurn', triggerTurn: false },
    );
  }
}

function registerSubagentTools(
  pi: ExtensionAPI,
  requireState: () => SessionState,
  ensureRuns: (state: SessionState) => Promise<SubagentRunSupervisor>,
  ensureAttested: (state: SessionState) => Promise<SubagentAttestedSupervisor>,
  loadHookEvidence: () => Promise<SubagentHookContractEvidence>,
): void {
  pi.registerTool<typeof SubagentRunParams, SubagentLaunchDetails>({
    name: SUBAGENT_RUN_TOOL_NAME,
    label: 'Subagent Run',
    description:
      'Launch one background Pi subagent seeded with a frozen projection of the current conversation, then return a launch receipt immediately. The child has its own session, a route pinned at launch that is never substituted, and read-only tools. Extension discovery is isolated by default; ambient mode supports extension-registered providers but executes arbitrary discovered extension code. Retrieve its verified answer with subagent_result.',
    promptSnippet:
      'Delegate an investigation to a background subagent that already has this conversation as context',
    promptGuidelines: [
      'Use subagent_run when work should continue in the background and the worker needs what you already know: it is seeded with a projection of this conversation.',
      'The prompt is authoritative. State exactly what you want investigated and what the answer should contain.',
      'The subagent is inspect-only at the model-visible tool boundary: it can read, search, and list files, but cannot run shell commands, edit or write files, use the network, or delegate further.',
      'Extension discovery is isolated by default. Use extensionMode:"ambient" only when the pinned provider is registered by an ambient user/project extension.',
      'Ambient mode executes arbitrary discovered extension code in the child process. Tool allowlists do not sandbox extension code, so ambient mode weakens inspect-only process isolation.',
      'Facts that exist only inside omitted tool output are not available to the subagent. Restate such findings in the prompt.',
      'subagent_run returns immediately. Do not poll; retrieve the answer with subagent_result after the terminal notification arrives.',
    ],
    parameters: SubagentRunParams,
    prepareArguments(args): SubagentRunParamsValue {
      if (!isRecord(args))
        throw new SubagentError('subagent_run arguments must be an object', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      rejectUnknownKeys(args, RUN_PARAM_KEYS, 'subagent_run');
      const name = args['name'];
      const prompt = args['prompt'];
      if (typeof name !== 'string' || name.trim().length === 0)
        throw new SubagentError('subagent_run requires a non-empty name', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      if (typeof prompt !== 'string' || prompt.trim().length === 0)
        throw new SubagentError('subagent_run requires a non-blank prompt', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      const prepared: SubagentRunParamsValue = { name, prompt };
      const route = requireRoute(args['route']);
      if (route !== undefined) prepared.route = route;
      prepared.capability = requireCapability(args['capability']);
      prepared.extensionMode = requireExtensionMode(args['extensionMode']);
      prepared.autoDeliver = requireAutoDeliver(args['autoDeliver']);
      const maxTurns = optionalPositiveInteger(args['maxTurns'], 'maxTurns');
      if (maxTurns !== undefined) prepared.maxTurns = maxTurns;
      const maxToolCalls = optionalPositiveInteger(args['maxToolCalls'], 'maxToolCalls');
      if (maxToolCalls !== undefined) prepared.maxToolCalls = maxToolCalls;
      const timeoutSeconds = optionalPositiveInteger(args['timeoutSeconds'], 'timeoutSeconds');
      if (timeoutSeconds !== undefined) prepared.timeoutSeconds = timeoutSeconds;
      const notify = args['notifyOnCompletion'];
      if (typeof notify === 'boolean') prepared.notifyOnCompletion = notify;
      const trigger = args['triggerOnCompletion'];
      if (typeof trigger === 'boolean') prepared.triggerOnCompletion = trigger;
      return prepared;
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const current = requireState();
      const capability = requireCapability(params.capability);
      const extensionMode = requireExtensionMode(params.extensionMode);
      const autoDeliver = requireAutoDeliver(params.autoDeliver);
      const hookEvidence = await loadHookEvidence();
      const [{ prepareSubagentLaunch }, { resolveSubagentRoute }, runs] = await Promise.all([
        loadRunnerModule(),
        loadLaunchModule(),
        ensureRuns(current),
      ]);
      const route = resolveSubagentRoute({
        requested: params.route,
        currentModel:
          ctx.model === undefined
            ? undefined
            : {
                provider: ctx.model.provider,
                id: ctx.model.id,
                contextWindow: ctx.model.contextWindow,
              },
        availableModels: ctx.modelRegistry.getAll().map((entry) => ({
          provider: entry.provider,
          id: entry.id,
          contextWindow: entry.contextWindow,
        })),
        thinkingLevel: pi.getThinkingLevel(),
      });

      const prepared = await prepareSubagentLaunch({
        ctx: {
          cwd: ctx.cwd,
          sessionManager: ctx.sessionManager,
          getSystemPrompt: () => ctx.getSystemPrompt(),
        },
        toolCallId,
        prompt: params.prompt,
        capability,
        extensionMode,
        route,
        limitOverrides: {
          maxTurns: params.maxTurns,
          maxToolCalls: params.maxToolCalls,
          timeoutSeconds: params.timeoutSeconds,
        },
        hookEvidence,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        autoDeliver,
      });

      const record = await runs.start({
        prepared,
        name: params.name,
        description: `subagent_run on ${route.qualified_id}: ${truncateChars(params.prompt.split('\n')[0] ?? '', 80)}`,
        notifyOnCompletion: params.notifyOnCompletion ?? true,
        triggerOnCompletion: params.triggerOnCompletion ?? true,
      });

      const details: SubagentLaunchDetails = {
        schema_version: SUBAGENT_LAUNCH_DETAILS_SCHEMA_VERSION,
        task_id: record.facts.taskId,
        launch_nonce: record.facts.launchNonce,
        service_task: record.serviceTask,
        route: {
          provider: route.provider,
          model: route.model,
          qualified_id: route.qualified_id,
          origin: route.origin,
        },
        child_session_id: prepared.preflight.childSessionId,
        artifact_dir: prepared.facts.artifactDir,
        seed_sha256: prepared.facts.seedSha256,
        seed_utf8_bytes: Buffer.byteLength(prepared.preflight.seed.serialized, 'utf8'),
        budget: prepared.facts.budget,
        extension_mode: extensionMode,
        auto_deliver: autoDeliver,
        notify_on_completion: params.notifyOnCompletion ?? true,
        trigger_on_completion: params.triggerOnCompletion ?? true,
      };
      return {
        content: textContent(
          [
            `Started subagent ${params.name} (${record.facts.taskId}); background registry task ${record.serviceTaskId}.`,
            `Route pinned: ${route.qualified_id} (${route.origin}); it is never substituted.`,
            `Child session: ${prepared.preflight.childSessionId} (separate from this session)`,
            `Artifacts: ${prepared.facts.artifactDir}`,
            `Seed: ${String(Buffer.byteLength(prepared.preflight.seed.serialized, 'utf8'))} bytes, sha256 ${prepared.facts.seedSha256}`,
            `Child prompt: ${String(prepared.preflight.plan.child_prompt_utf8_bytes)} bytes; launch estimate ${String(prepared.preflight.plan.launch_input_tokens_upper_bound)} / ${String(prepared.preflight.plan.route.allowed_input_tokens)} allowed input tokens; protected retained-growth runway ${String(prepared.preflight.plan.retained_growth_budget_tokens)} tokens.`,
            `Estimator: family ${prepared.facts.budget.family}, source ${prepared.facts.budget.rate_source.source}, rate ${String(prepared.facts.budget.rate_source.effective_rate_bytes_per_token_x100)}/100 B/tok + ${String(prepared.facts.budget.rate_source.affine_f_tokens)} tokens${prepared.facts.budget.rate_source.warning === null ? '' : `; warning: ${prepared.facts.budget.rate_source.warning}`}`,
            `Capability: ${capability} (read/search/list only)`,
            `Extension mode: ${extensionMode}${extensionMode === 'ambient' ? ' — WARNING: arbitrary discovered extension code executes in the child; the tool allowlist does not sandbox it, so inspect-only process isolation is weakened.' : ' (ambient extension discovery disabled)'}`,
            `Limits: ${String(prepared.preflight.limits.max_turns)} turns, ${String(prepared.preflight.limits.max_tool_calls)} tool calls, ${String(prepared.preflight.limits.timeout_seconds)}s`,
            `Auto-deliver: ${autoDeliver}`,
            (params.notifyOnCompletion ?? true)
              ? `Terminal notification: enabled.${(params.triggerOnCompletion ?? true) ? ' It will start a follow-up turn.' : ' It will not start a turn.'}`
              : 'Terminal notification: disabled.',
            `Retrieve the verified answer with ${SUBAGENT_RESULT_TOOL_NAME}({taskId:"${record.facts.taskId}"}). Do not poll.`,
          ].join('\n'),
        ),
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('subagent_run '))}${theme.fg('muted', truncateChars(args.name, 60))}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      return new Text(
        `${theme.fg('success', '✓ subagent started')} ${theme.fg('accent', details?.task_id ?? '')}\n${theme.fg('dim', `route ${details?.route.qualified_id ?? ''} · extensions ${details?.extension_mode ?? ''} · seed ${String(details?.seed_utf8_bytes ?? 0)}B · ${details?.artifact_dir ?? ''}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof SubagentResultParams, SubagentResultViewDetails>({
    name: SUBAGENT_RESULT_TOOL_NAME,
    label: 'Subagent Result',
    description:
      'Retrieve a hash-verified result from a subagent_run task. Never blocks: a running task returns a typed not-ready result. Oversized answers are never truncated.',
    promptSnippet: 'Retrieve the verified answer from a completed subagent run',
    promptGuidelines: [
      'Call subagent_result once the subagent terminal notification has arrived. It never blocks and must not be polled.',
      'A not-ready result means the subagent is still running; end the turn and wait for the notification.',
      'subagent_result serves subagent_run tasks only; attested runs are observed through the background task service (bg_status/bg_logs).',
    ],
    parameters: SubagentResultParams,
    prepareArguments(args): SubagentResultParamsValue {
      if (!isRecord(args))
        throw new SubagentError('subagent_result arguments must be an object', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      rejectUnknownKeys(args, RESULT_PARAM_KEYS, 'subagent_result');
      const taskId = args['taskId'];
      if (typeof taskId !== 'string' || taskId.trim().length === 0)
        throw new SubagentError('subagent_result requires taskId', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      const prepared: SubagentResultParamsValue = { taskId };
      const delivery = requireDelivery(args['delivery']);
      if (delivery !== undefined) prepared.delivery = delivery;
      return prepared;
    },
    async execute(_toolCallId, params) {
      const current = requireState();
      const [runs, budgetModule] = await Promise.all([ensureRuns(current), loadBudgetModule()]);
      const record = runs.resolve(params.taskId);
      const requestedDelivery = requireDelivery(params.delivery);

      if (record.state === 'running') {
        const details: SubagentResultViewDetails = {
          schema_version: SUBAGENT_RESULT_VIEW_SCHEMA_VERSION,
          task_id: record.facts.taskId,
          state: 'running',
          delivery: 'none',
          artifact_dir: record.facts.artifactDir,
          budget: record.facts.budget,
          extension_mode: record.facts.extensionMode,
        };
        return {
          content: textContent(
            `Subagent ${record.facts.taskId} is still running. This is not an error and subagent_result never blocks. End this turn; the terminal notification will wake you, then call subagent_result again.`,
          ),
          details,
        };
      }

      const evaluation = record.evaluation;
      if (evaluation === undefined || evaluation.result === undefined) {
        const failure =
          evaluation?.error ??
          new SubagentError(
            record.error ?? `subagent ${record.facts.taskId} produced no verified answer`,
            {
              code: record.state === 'cancelled' ? 'child_cancelled' : 'result_unavailable',
              childCreated: true,
              taskId: record.facts.taskId,
              artifactDir: record.facts.artifactDir,
            },
          );
        throw failure;
      }

      const verified = evaluation.result;
      const decision = budgetModule.decideSubagentDelivery(
        verified.package.answer.byte_length,
        requestedDelivery,
      );
      if (requestedDelivery === 'inline' && decision.mode === 'artifact') {
        throw budgetModule.inlineTooLarge(
          record.facts.taskId,
          record.facts.artifactDir,
          verified.package.answer.byte_length,
        );
      }

      const usageDelivered = verified.package.usage.status === 'observed' && !record.usageDelivered;

      const details: SubagentResultViewDetails = {
        schema_version: SUBAGENT_RESULT_VIEW_SCHEMA_VERSION,
        task_id: record.facts.taskId,
        state: 'committed',
        delivery: decision.mode,
        route: verified.package.route,
        budget: record.facts.budget,
        extension_mode: record.facts.extensionMode,
        answer_bytes: verified.package.answer.byte_length,
        answer_sha256: verified.package.answer.sha256,
        turns: verified.package.turns,
        tool_calls: verified.package.tool_calls,
        usage: { status: verified.package.usage.status },
        usage_delivered: usageDelivered,
        artifact_dir: record.facts.artifactDir,
      };
      const header = [
        `Subagent ${record.facts.taskId} completed on ${verified.package.route.provider}/${verified.package.route.model}.`,
        `Answer: ${String(verified.package.answer.byte_length)} bytes, sha256 ${verified.package.answer.sha256} (verified).`,
        `Turns: ${String(verified.package.turns)} · tool calls: ${String(verified.package.tool_calls)} · usage: ${verified.package.usage.status}`,
        `Artifacts: ${record.facts.artifactDir}`,
        `Estimator: family ${record.facts.budget.family}, source ${record.facts.budget.rate_source.source}, rate ${String(record.facts.budget.rate_source.effective_rate_bytes_per_token_x100)}/100 B/tok + ${String(record.facts.budget.rate_source.affine_f_tokens)} tokens${record.facts.budget.rate_source.warning === null ? '' : `; warning: ${record.facts.budget.rate_source.warning}`}`,
        usageDelivered
          ? 'Usage: attached to this retrieval exactly once.'
          : 'Usage: already attached by an earlier retrieval, or unavailable; not counted again.',
      ].join('\n');
      const result: {
        content: ReturnType<typeof textContent>;
        details: SubagentResultViewDetails;
        usage?: Usage;
      } =
        decision.mode === 'artifact'
          ? {
              content: textContent(
                `${header}\nDelivery: artifact (${decision.reason}). The complete verified answer is in ${record.facts.artifactDir}/result.json. It was not truncated.`,
              ),
              details,
            }
          : { content: textContent(`${header}\n\n${verified.answer}`), details };
      // The latch is consumed only here, where usage is actually attached to
      // the returned result, so no delivery mode can lose it silently.
      if (usageDelivered && verified.package.usage.status === 'observed') {
        record.usageDelivered = true;
        result.usage = verified.package.usage.usage;
      }
      return result;
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('subagent_result '))}${theme.fg('accent', args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, _options: ToolRenderResultOptions, theme: Theme) {
      const details = result.details;
      if (details?.state === 'running')
        return new Text(theme.fg('warning', `subagent ${details.task_id} still running`), 0, 0);
      return new Text(
        `${theme.fg('success', '✓ subagent answer')} ${theme.fg('dim', `${String(details?.answer_bytes ?? 0)}B · ${details?.delivery ?? 'none'}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof SubagentAttestedParams, SubagentAttestedLaunchDetails>({
    name: SUBAGENT_RUN_ATTESTED_TOOL_NAME,
    label: 'Attested Subagent Pi Run',
    description:
      'Opt-in evidence-oriented direct Pi spawn. Launches exactly one `pi --mode json` child, records raw Pi events/stderr, hashes prompt/report/output, observes OAuth through ModelRegistry, and emits a strict attestation sidecar only after successful completion.',
    promptSnippet: 'Start an attested direct Pi agent task and return its task ID plus output path',
    promptGuidelines: [
      'Use subagent_run_attested only when the user explicitly asks for an attested Pi evidence-producing task; ordinary delegation should use subagent_run unchanged.',
      'Provide provider/model as structured fields and a relative reportPath that the child Pi prompt will write before exit.',
      'Do not provide channel, auth, route, or hash claims; the producer observes those facts itself and fails loudly if it cannot attest them.',
    ],
    parameters: SubagentAttestedParams,
    prepareArguments(args): SubagentAttestedParamsValue {
      if (!isRecord(args))
        throw new SubagentError('subagent_run_attested arguments must be an object', {
          code: 'invalid_arguments',
          childCreated: false,
        });
      rejectUnknownKeys(args, ATTESTED_PARAM_KEYS, 'subagent_run_attested');
      const input: StructuredSubagentPiLaunchRequest = {
        name: requireAttestedString(args, 'name'),
        provider: requireAttestedString(args, 'provider'),
        model: requireAttestedString(args, 'model'),
        prompt: requireAttestedString(args, 'prompt'),
        reportPath: requireAttestedString(args, 'reportPath'),
      };
      const extraPiArgs = args['extraPiArgs'];
      if (extraPiArgs !== undefined) {
        if (
          !Array.isArray(extraPiArgs) ||
          !extraPiArgs.every((entry) => typeof entry === 'string')
        ) {
          throw new SubagentError('subagent_run_attested extraPiArgs entries must be strings', {
            code: 'invalid_arguments',
            childCreated: false,
          });
        }
        input.extraPiArgs = extraPiArgs;
      }
      const thinking = args['thinking'];
      if (typeof thinking === 'string') input.thinking = thinking;
      const timeoutSeconds = optionalPositiveInteger(args['timeoutSeconds'], 'timeoutSeconds');
      if (timeoutSeconds !== undefined) input.timeoutSeconds = timeoutSeconds;
      return input as SubagentAttestedParamsValue;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = requireState();
      const attested = await ensureAttested(current);
      const record = await attested.start({
        request: params,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
      });
      const details: SubagentAttestedLaunchDetails = {
        schema_version: SUBAGENT_ATTESTED_LAUNCH_DETAILS_SCHEMA_VERSION,
        task_id: record.id,
        service_task: {
          id: record.serviceTaskId,
          name: record.name,
          status: record.state,
        },
        provider: params.provider,
        model: params.model,
        output_path: record.paths.outputPath,
        attestation_path: record.paths.attestationPath,
        report_path: params.reportPath,
      };
      return {
        content: textContent(
          `Started attested Pi task ${record.name} (${record.id})\nStatus: ${record.state}\nPID: ${String(record.pid ?? 'unknown')}\nOutput: ${record.paths.outputPath}\nAttestation: ${record.paths.attestationPath} (pending until completion)\nObserve it through the background task service (bg_status/bg_logs); the attestation sidecar is written only after a fully verified success.`,
        ),
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('subagent_run_attested '))}${theme.fg('muted', truncateChars(args.name, 90))}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      return new Text(
        `${theme.fg('success', '✓ started')} ${theme.fg('accent', details?.task_id ?? '')}\n${theme.fg('dim', `Output: ${details?.output_path ?? ''}`)}\n${theme.fg('dim', `Attestation: ${details?.attestation_path ?? 'pending'}`)}`,
        0,
        0,
      );
    },
  });
}

function requireAttestedString(args: Record<PropertyKey, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new SubagentError(`subagent_run_attested requires ${key}`, {
      code: 'invalid_arguments',
      childCreated: false,
    });
  }
  return value;
}

/** The pi.extensions entry point. */
export default createSubagentExtension();
