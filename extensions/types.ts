import type { Usage } from '@earendil-works/pi-ai';
import type {
  ContextProjectionMapEntry,
  OmittedEventRecord,
  ProjectionAccounting,
  ProjectionEntry,
  TokenBudgetByteClassBreakdown,
  TokenBudgetDominantByteClass,
  TokenBudgetFamily,
  TokenBudgetRateSource,
} from '@sakiko233/pi-agent-runtime';

/**
 * Subagent domain types, schema ids, and the typed failure surface.
 *
 * Extracted from pi-background-tasks and renamed to subagent ownership: every
 * persisted schema id lives under the `pi-subagent` namespace and no historical
 * compatibility surface survives. The structural contracts (frozen seed,
 * ledger, result package, receipts, budget plan) are preserved as they were
 * observed and tested in the source repository.
 */

export const SUBAGENT_SEED_SCHEMA_VERSION = 'pi-subagent.seed.v2' as const;
export const SUBAGENT_LEDGER_SCHEMA_VERSION = 'pi-subagent.ledger.v1' as const;
export const SUBAGENT_RESULT_PACKAGE_SCHEMA_VERSION = 'pi-subagent.result.v1' as const;
export const SUBAGENT_RECEIPT_SCHEMA_VERSION = 'pi-subagent.receipt.v1' as const;
export const SUBAGENT_BUDGET_PLAN_SCHEMA_VERSION = 'pi-subagent.budget-plan.v3' as const;
export const SUBAGENT_MANIFEST_SCHEMA_VERSION = 'pi-subagent.manifest.v2' as const;
export const SUBAGENT_OUTCOME_SCHEMA_VERSION = 'pi-subagent.outcome.v1' as const;
export const SUBAGENT_LAUNCH_DETAILS_SCHEMA_VERSION = 'pi-subagent.launch.v1' as const;
export const SUBAGENT_RESULT_VIEW_SCHEMA_VERSION = 'pi-subagent.result-view.v1' as const;
export const SUBAGENT_CHILD_TERMINAL_SCHEMA_VERSION = 'pi-subagent.child-terminal.v1' as const;
export const SUBAGENT_RUNTIME_BUDGET_SCHEMA_VERSION = 'pi-subagent.runtime-budget.v1' as const;
export const SUBAGENT_TOOL_RESULT_CONTENT_SCHEMA_VERSION =
  'pi-subagent.tool-result-content.v1' as const;
export const SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION = 'pi-subagent.hook-contract.v1' as const;
export const SUBAGENT_ATTESTATION_SCHEMA_VERSION = 'pi-subagent.pi-task-attestation.v1' as const;

/** Single registry of every persisted subagent schema id. */
export const SUBAGENT_SCHEMAS = {
  seed: SUBAGENT_SEED_SCHEMA_VERSION,
  ledger: SUBAGENT_LEDGER_SCHEMA_VERSION,
  result: SUBAGENT_RESULT_PACKAGE_SCHEMA_VERSION,
  receipt: SUBAGENT_RECEIPT_SCHEMA_VERSION,
  budgetPlan: SUBAGENT_BUDGET_PLAN_SCHEMA_VERSION,
  manifest: SUBAGENT_MANIFEST_SCHEMA_VERSION,
  outcome: SUBAGENT_OUTCOME_SCHEMA_VERSION,
  launch: SUBAGENT_LAUNCH_DETAILS_SCHEMA_VERSION,
  resultView: SUBAGENT_RESULT_VIEW_SCHEMA_VERSION,
  childTerminal: SUBAGENT_CHILD_TERMINAL_SCHEMA_VERSION,
  runtimeBudget: SUBAGENT_RUNTIME_BUDGET_SCHEMA_VERSION,
  toolResultContent: SUBAGENT_TOOL_RESULT_CONTENT_SCHEMA_VERSION,
  hookContract: SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION,
  attestation: SUBAGENT_ATTESTATION_SCHEMA_VERSION,
} as const;

/**
 * Subagent's own context policy id. It shares the frozen
 * `visible-conversation-ledger-v2` transform with the other child-agent
 * consumers but is a distinct consumer identity, so a subagent artifact can
 * never be mistaken for another consumer's artifact and neither can claim the
 * other's provenance.
 */
export const SUBAGENT_CONTEXT_POLICY_ID = 'subagent-inspect-v1';
export const SUBAGENT_BRANCH_FILTER_ID = 'exclude-active-subagent-batch-v1';
export const SUBAGENT_RUN_TOOL_NAME = 'subagent_run';
export const SUBAGENT_RESULT_TOOL_NAME = 'subagent_result';
export const SUBAGENT_RUN_ATTESTED_TOOL_NAME = 'subagent_run_attested';
export const SUBAGENT_CHILD_ARTIFACT_READER_TOOL = 'subagent_read_artifact';

export const SUBAGENT_CAPABILITIES = ['inspect'] as const;
export type SubagentCapability = (typeof SUBAGENT_CAPABILITIES)[number];

/**
 * Controls only Pi's ambient extension discovery for subagent children.
 * Tool and project-resource restrictions remain independently enforced.
 */
export const SUBAGENT_EXTENSION_MODES = ['isolated', 'ambient'] as const;
export type SubagentExtensionMode = (typeof SUBAGENT_EXTENSION_MODES)[number];

export const SUBAGENT_AUTO_DELIVER_MODES = ['never', 'when_small', 'always'] as const;
export type SubagentAutoDeliverMode = (typeof SUBAGENT_AUTO_DELIVER_MODES)[number];

export const SUBAGENT_DELIVERY_MODES = ['inline', 'artifact'] as const;
export type SubagentDeliveryMode = (typeof SUBAGENT_DELIVERY_MODES)[number];

export interface SubagentRoute {
  provider: string;
  model: string;
}

export interface SubagentPinnedRoute extends SubagentRoute {
  qualified_id: string;
  context_window_tokens: number;
  thinking_level: string;
  /** Whether the route came from the parent's current model or an explicit argument. */
  origin: 'parent_current' | 'explicit';
}

export interface SubagentBudgetRouteSource {
  family: TokenBudgetFamily;
  rate_source: TokenBudgetRateSource;
  conservative_rate_source?: TokenBudgetRateSource | undefined;
}

export interface SubagentContextPolicyDescriptor {
  id: typeof SUBAGENT_CONTEXT_POLICY_ID;
  transform: 'visible-conversation-ledger-v2';
  version: 1;
  receipt_format: 'omitted_activity.v2';
  user_text: 'verbatim';
  assistant_text: 'verbatim';
  assistant_thinking: 'ledger_only';
  tool_call_arguments: 'ledger_only';
  tool_results: 'ledger_only';
  tool_payload_preview_bytes: 0;
  images: 'marker_or_ledger_only';
  unknown_block_behavior: 'error';
}

export interface SubagentBranchFilterDescriptor {
  id: typeof SUBAGENT_BRANCH_FILTER_ID;
  tool_name: typeof SUBAGENT_RUN_TOOL_NAME;
  tool_call_id: string | null;
  active_tool_call_leaf_excluded: boolean;
}

export interface SubagentConversationProjection {
  policy: SubagentContextPolicyDescriptor;
  branch_filter: SubagentBranchFilterDescriptor;
  entries: readonly ProjectionEntry[];
  accounting: ProjectionAccounting;
}

export interface SubagentLedgerV1 {
  schema_version: typeof SUBAGENT_LEDGER_SCHEMA_VERSION;
  policy_id: typeof SUBAGENT_CONTEXT_POLICY_ID;
  transform: 'visible-conversation-ledger-v2';
  entries: readonly OmittedEventRecord[];
  projection_map: readonly ContextProjectionMapEntry[];
  root_sha256: string;
}

export interface SubagentTaskDirective {
  /** Verbatim operator/agent prompt. Always authoritative over projected history. */
  text: string;
  sha256: string;
  authority: 'explicit_text';
}

export interface SubagentSeedV2 {
  schema_version: typeof SUBAGENT_SEED_SCHEMA_VERSION;
  task_id: string;
  launch_nonce: string;
  cwd: string;
  capability: SubagentCapability;
  extension_mode: SubagentExtensionMode;
  route: SubagentPinnedRoute;
  parent_system_prompt: string;
  parent_leaf_id: string | null;
  directive: SubagentTaskDirective;
  conversation_projection: SubagentConversationProjection;
  limits: SubagentLimits;
}

export interface SubagentLimits {
  max_turns: number;
  max_tool_calls: number;
  timeout_seconds: number;
  /** Per-tool-result transcript cap; larger results spill to hashed artifacts. */
  max_tool_result_bytes: number;
  /** Cumulative spilled+inline tool output across the whole run. */
  max_total_tool_output_bytes: number;
  /** Cap on the child's captured final answer. */
  max_answer_bytes: number;
  /** Usable input tokens for the pinned route after reserves. */
  allowed_input_tokens: number;
}

export interface SubagentAnswerBlock {
  kind: 'text';
  byte_length: number;
  sha256: string;
  data_base64: string;
}

export interface SubagentRouteAttestation {
  provider: string;
  model: string;
  stop_reason: string;
}

/**
 * Usage that is explicitly absent is reported as absent.
 *
 * A child that never produced a usable usage record must not be reported as
 * having cost zero, so the status is carried alongside the value.
 */
export type SubagentUsageReport =
  | { status: 'observed'; usage: Usage }
  | { status: 'unavailable'; reason: string };

/**
 * The single atomically-committed answer data plane.
 *
 * The child writes exactly this document to a temporary file, fsyncs it, and
 * renames it into place. The rename is the commit point: a package that exists
 * under its final name is complete, and one that does not exist means the child
 * produced no accepted answer. There is no second channel to reconcile.
 */
export interface SubagentResultPackageV1 {
  schema_version: typeof SUBAGENT_RESULT_PACKAGE_SCHEMA_VERSION;
  task_id: string;
  launch_nonce: string;
  seed_sha256: string;
  directive_sha256: string;
  route: SubagentRoute;
  route_attestations: readonly SubagentRouteAttestation[];
  stop_reason: string;
  turns: number;
  tool_calls: number;
  usage: SubagentUsageReport;
  answer: {
    encoding: 'utf-8';
    byte_length: number;
    sha256: string;
    blocks: readonly SubagentAnswerBlock[];
  };
  spilled_artifacts: readonly SubagentSpillReceipt[];
}

export type SubagentSpillContentFormat =
  | 'single_text_utf8'
  | 'tool_result_content_json_v1'
  | 'opaque_bytes';

export interface SubagentSpillReceipt {
  schema_version: typeof SUBAGENT_RECEIPT_SCHEMA_VERSION;
  artifact: string;
  tool_name: string;
  tool_call_id: string;
  turn_sequence: number;
  source_call_index: number;
  byte_length: number;
  sha256: string;
  /**
   * Encoding of the hashed artifact bytes. Optional only for compatibility
   * with v1 receipts written before content formats were recorded.
   */
  content_format?: SubagentSpillContentFormat | undefined;
}

export const SUBAGENT_ERROR_CODES = [
  // Admission failures. No child process exists in these states.
  'subagent_hook_contract_unsupported',
  'subagent_isolation_unsupported',
  'route_unresolved',
  'route_capacity_unknown',
  'seed_projection_failed',
  'seed_budget_exceeded',
  'seed_persist_failed',
  'invalid_arguments',
  // Background service dependency.
  'background_service_unavailable',
  // Launch and execution.
  'child_spawn_failed',
  'child_startup_failed',
  'child_timeout',
  'child_cancelled',
  'child_turn_limit',
  'child_tool_call_limit',
  'child_exited_without_commit',
  // Budget, split by which budget was exhausted.
  'provider_context_budget_exhausted',
  'aggregate_tool_output_cap',
  'child_model_output_limit',
  'child_capture_limit',
  // Integrity.
  'child_result_invalid',
  'child_result_encoding_invalid',
  'route_attestation_missing',
  'route_mismatch',
  'seed_hash_mismatch',
  'answer_hash_mismatch',
  'artifact_spill_failed',
  'artifact_read_failed',
  'artifact_error',
  // Retrieval states and outcomes.
  'result_not_ready',
  'result_unavailable',
  'result_too_large_for_inline',
  'task_unknown',
] as const;

export type SubagentErrorCode = (typeof SUBAGENT_ERROR_CODES)[number];

export interface SubagentBudgetErrorDetail {
  measurement_kind: 'launch_admission' | 'runtime_context';
  measured_utf8_bytes: number;
  measured_input_tokens_upper_bound: number;
  allowed_input_tokens: number;
  rate_source: TokenBudgetRateSource;
  backed: boolean;
  dominant_byte_class: TokenBudgetDominantByteClass;
  byte_class_breakdown: TokenBudgetByteClassBreakdown;
}

export interface SubagentErrorDetails {
  code: SubagentErrorCode;
  /** True only when an OS process was actually created. Admission failures are false. */
  childCreated?: boolean;
  taskId?: string;
  artifactDir?: string;
  budget?: SubagentBudgetErrorDetail;
  /** What is preserved on disk despite the failure. */
  preserved?: readonly string[];
  /** Concrete operator actions. */
  remediation?: readonly string[];
}

/**
 * Typed subagent failure.
 *
 * Every instance states what happened, what was preserved, and what the operator
 * can do. There is no untyped subagent failure path.
 */
export class SubagentError extends Error {
  readonly code: SubagentErrorCode;
  readonly childCreated: boolean;
  readonly taskId: string | undefined;
  readonly artifactDir: string | undefined;
  readonly budget: SubagentBudgetErrorDetail | undefined;
  readonly preserved: readonly string[];
  readonly remediation: readonly string[];

  constructor(message: string, details: SubagentErrorDetails) {
    super(message);
    this.name = 'SubagentError';
    this.code = details.code;
    this.childCreated = details.childCreated ?? false;
    this.taskId = details.taskId;
    this.artifactDir = details.artifactDir;
    this.budget = details.budget;
    this.preserved = details.preserved ?? [];
    this.remediation = details.remediation ?? [];
  }

  /** Operator-facing rendering: cause, preserved evidence, and next action. */
  describe(): string {
    const lines = [`[${this.code}] ${this.message}`];
    lines.push(`Child process created: ${this.childCreated ? 'yes' : 'no'}`);
    if (this.artifactDir !== undefined) lines.push(`Artifacts: ${this.artifactDir}`);
    lines.push(
      this.preserved.length > 0
        ? `Preserved: ${this.preserved.join(', ')}`
        : 'Preserved: nothing was written for this failure',
    );
    if (this.remediation.length > 0) lines.push(`Remediation: ${this.remediation.join(' ')}`);
    return lines.join('\n');
  }
}

/**
 * Tools the inspect capability permits.
 *
 * v1 is read-only by construction: no shell, no network, no edit/write, no
 * recursive delegation, no Fusion. The list is passed to `--tools`, so it is
 * enforced by the child's tool registry rather than by prompt text.
 */
export const SUBAGENT_INSPECT_TOOLS: readonly string[] = [
  'read',
  'grep',
  'find',
  'ls',
  SUBAGENT_CHILD_ARTIFACT_READER_TOOL,
];

/** Registry task ids for subagent-owned work are opaque service-allocated ids. */
export const SUBAGENT_TASK_ID_PATTERN = /^s[0-9a-f]{32}$/;
