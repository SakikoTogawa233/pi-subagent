import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type ParentContextSource,
  type ParentSnapshotOptions,
  type ProjectedConversationV2,
  projectVisibleConversation,
  snapshotParentConversation,
  UnsupportedConversationBlockError,
} from '@sakiko233/pi-agent-runtime';
import {
  SUBAGENT_BRANCH_FILTER_ID,
  SUBAGENT_CONTEXT_POLICY_ID,
  SUBAGENT_LEDGER_SCHEMA_VERSION,
  SUBAGENT_RUN_TOOL_NAME,
  SUBAGENT_SEED_SCHEMA_VERSION,
  type SubagentBranchFilterDescriptor,
  type SubagentContextPolicyDescriptor,
  type SubagentConversationProjection,
  SubagentError,
  type SubagentExtensionMode,
  type SubagentLedgerV1,
  type SubagentLimits,
  type SubagentPinnedRoute,
  type SubagentSeedV3,
  type SubagentTaskDirective,
} from './types.js';

/**
 * The frozen subagent seed.
 *
 * The projection is built with the shared runtime transform and sealed under
 * subagent's own envelope. A subagent artifact can never be mistaken for
 * another child-agent consumer's artifact: the policy id, ledger schema, and
 * branch filter all carry subagent ownership.
 */

function sha256Text(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

export interface BuildSubagentSeedOptions {
  taskId: string;
  launchNonce: string;
  toolCallId: string | undefined;
  directive: string;
  extensionMode: SubagentExtensionMode;
  route: SubagentPinnedRoute;
  limits: SubagentLimits;
}

export interface BuiltSubagentSeed {
  seed: SubagentSeedV3;
  /** Exact bytes persisted and written to the child. Nothing re-serializes them. */
  serialized: string;
  sha256: string;
  ledger: SubagentLedgerV1;
}

function policyDescriptor(): SubagentContextPolicyDescriptor {
  return {
    id: SUBAGENT_CONTEXT_POLICY_ID,
    transform: 'visible-conversation-ledger-v2',
    version: 1,
    receipt_format: 'omitted_activity.v2',
    user_text: 'verbatim',
    assistant_text: 'verbatim',
    assistant_thinking: 'ledger_only',
    tool_call_arguments: 'ledger_only',
    tool_results: 'ledger_only',
    tool_payload_preview_bytes: 0,
    images: 'marker_or_ledger_only',
    unknown_block_behavior: 'error',
  };
}

/**
 * Seal the shared transform under subagent's own envelope.
 *
 * Subagent never imports another consumer's canonical-input builder and never
 * emits another consumer's input schema. The ledger root commits only to ledger
 * rows, so consumers can seal identical bodies without either affecting the
 * other.
 */
function sealSubagentProjection(
  projected: ProjectedConversationV2,
  branchFilter: SubagentBranchFilterDescriptor,
): { projection: SubagentConversationProjection; ledger: SubagentLedgerV1 } {
  return {
    projection: {
      policy: policyDescriptor(),
      branch_filter: branchFilter,
      entries: projected.entries,
      accounting: projected.accounting,
    },
    ledger: {
      schema_version: SUBAGENT_LEDGER_SCHEMA_VERSION,
      policy_id: SUBAGENT_CONTEXT_POLICY_ID,
      transform: 'visible-conversation-ledger-v2',
      entries: projected.ledger.entries,
      projection_map: projected.ledger.projection_map,
      root_sha256: projected.ledger.root_sha256,
    },
  };
}

/**
 * Build the frozen subagent seed.
 *
 * The projection excludes the assistant message carrying the in-flight
 * `subagent_run` call. That message is excluded as a whole, so when several
 * `subagent_run` calls share one assistant message every sibling call is
 * excluded for every child: two subagents launched together receive identical
 * projected history, and neither can observe the other's arguments.
 *
 * The directive is authoritative; projected history is supporting, untrusted
 * context. That relationship is stated to the child explicitly in its system
 * prompt, and recorded structurally here as `authority: 'explicit_text'`.
 */
export function buildSubagentSeed(
  ctx: ParentContextSource,
  options: BuildSubagentSeedOptions,
): BuiltSubagentSeed {
  const directiveText = options.directive;
  if (directiveText.trim().length === 0) {
    throw new SubagentError('subagent_run prompt must not be blank', {
      code: 'invalid_arguments',
      childCreated: false,
      remediation: ['Provide a non-blank prompt describing what the subagent should investigate.'],
    });
  }
  const snapshotOptions: ParentSnapshotOptions = {
    toolCallId: options.toolCallId ?? '',
    excludeActiveToolCallLeaf: true,
  };

  let snapshot: ReturnType<typeof snapshotParentConversation>;
  let projected: ProjectedConversationV2;
  try {
    snapshot = snapshotParentConversation(ctx, snapshotOptions);
    projected = projectVisibleConversation(snapshot.messages);
  } catch (error) {
    if (error instanceof UnsupportedConversationBlockError) {
      throw new SubagentError(
        `subagent_run could not project the parent conversation: ${error.message}`,
        {
          code: 'seed_projection_failed',
          childCreated: false,
          remediation: [
            'The parent conversation contains a block type this package version does not know how to project.',
            'Nothing was dropped or guessed and no child was created. Report the block type so the transform can be versioned.',
          ],
        },
      );
    }
    throw error;
  }

  const branchFilter: SubagentBranchFilterDescriptor = {
    id: SUBAGENT_BRANCH_FILTER_ID,
    tool_name: SUBAGENT_RUN_TOOL_NAME,
    tool_call_id: options.toolCallId ?? null,
    active_tool_call_leaf_excluded: snapshot.activeToolCallLeafExcluded,
  };
  const sealed = sealSubagentProjection(projected, branchFilter);
  const directive: SubagentTaskDirective = {
    text: directiveText,
    sha256: sha256Text(directiveText),
    authority: 'explicit_text',
  };
  const seed: SubagentSeedV3 = {
    schema_version: SUBAGENT_SEED_SCHEMA_VERSION,
    task_id: options.taskId,
    launch_nonce: options.launchNonce,
    cwd: ctx.cwd,
    extension_mode: options.extensionMode,
    route: options.route,
    parent_system_prompt: ctx.getSystemPrompt(),
    parent_leaf_id: snapshot.leafId,
    directive,
    conversation_projection: sealed.projection,
    limits: options.limits,
  };
  const serialized = canonicalJson(seed);
  return { seed, serialized, sha256: sha256Text(serialized), ledger: sealed.ledger };
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Receive-side seed validation performed inside the child before its first
 * model call. A seed that does not match its declared length, hash, schema,
 * task id, and launch nonce is a loud refusal, never a best-effort continue.
 */
export function verifySubagentSeedBytes(
  raw: string,
  expected: { sha256: string; taskId: string; launchNonce: string },
): SubagentSeedV3 {
  const actual = sha256Text(raw);
  if (actual !== expected.sha256) {
    throw new SubagentError(
      `subagent seed hash mismatch: expected ${expected.sha256}, received ${actual}`,
      {
        code: 'seed_hash_mismatch',
        childCreated: true,
        taskId: expected.taskId,
        remediation: ['The seed bytes delivered to the child differ from the persisted seed.'],
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SubagentError(
      `subagent seed is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'seed_hash_mismatch', childCreated: true, taskId: expected.taskId },
    );
  }
  if (!isRecord(parsed)) {
    throw new SubagentError('subagent seed must be a JSON object', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId: expected.taskId,
    });
  }
  if (parsed['schema_version'] !== SUBAGENT_SEED_SCHEMA_VERSION) {
    throw new SubagentError(
      `subagent seed schema_version must be ${SUBAGENT_SEED_SCHEMA_VERSION}`,
      {
        code: 'seed_hash_mismatch',
        childCreated: true,
        taskId: expected.taskId,
      },
    );
  }
  if (parsed['task_id'] !== expected.taskId || parsed['launch_nonce'] !== expected.launchNonce) {
    throw new SubagentError('subagent seed task identity does not match this child', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId: expected.taskId,
    });
  }
  // The hash pins the exact bytes; this rebuild pins the shape the child is
  // allowed to act on. Every field the child reads is validated and copied
  // explicitly, so a structurally malformed seed cannot reach the agent loop by
  // way of an unchecked assertion.
  return rebuildSeed(parsed, expected.taskId);
}

function requireString(record: Record<PropertyKey, unknown>, key: string, taskId: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new SubagentError(`subagent seed field ${key} must be a string`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  return value;
}

function requireRecord(
  record: Record<PropertyKey, unknown>,
  key: string,
  taskId: string,
): Record<PropertyKey, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new SubagentError(`subagent seed field ${key} must be an object`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  return value;
}

function requireNonNegativeInteger(
  record: Record<PropertyKey, unknown>,
  key: string,
  taskId: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SubagentError(`subagent seed field ${key} must be a non-negative safe integer`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  return value;
}

/** Explicit, field-by-field reconstruction of the seed fields the child consumes. */
function rebuildSeed(record: Record<PropertyKey, unknown>, taskId: string): SubagentSeedV3 {
  const extensionMode = requireString(record, 'extension_mode', taskId);
  if (extensionMode !== 'isolated' && extensionMode !== 'ambient') {
    throw new SubagentError(`subagent seed extension mode ${extensionMode} is not recognised`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const routeRecord = requireRecord(record, 'route', taskId);
  const routeOrigin = requireString(routeRecord, 'origin', taskId);
  if (routeOrigin !== 'parent_current' && routeOrigin !== 'explicit') {
    throw new SubagentError(`subagent seed route origin ${routeOrigin} is not recognised`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const route: SubagentPinnedRoute = {
    provider: requireString(routeRecord, 'provider', taskId),
    model: requireString(routeRecord, 'model', taskId),
    qualified_id: requireString(routeRecord, 'qualified_id', taskId),
    context_window_tokens: requireNonNegativeInteger(routeRecord, 'context_window_tokens', taskId),
    thinking_level: requireString(routeRecord, 'thinking_level', taskId),
    origin: routeOrigin,
  };
  const limitsRecord = requireRecord(record, 'limits', taskId);
  const limits: SubagentLimits = {
    max_turns: requireNonNegativeInteger(limitsRecord, 'max_turns', taskId),
    max_tool_calls: requireNonNegativeInteger(limitsRecord, 'max_tool_calls', taskId),
    timeout_seconds: requireNonNegativeInteger(limitsRecord, 'timeout_seconds', taskId),
    max_tool_result_bytes: requireNonNegativeInteger(limitsRecord, 'max_tool_result_bytes', taskId),
    max_total_tool_output_bytes: requireNonNegativeInteger(
      limitsRecord,
      'max_total_tool_output_bytes',
      taskId,
    ),
    max_answer_bytes: requireNonNegativeInteger(limitsRecord, 'max_answer_bytes', taskId),
    allowed_input_tokens: requireNonNegativeInteger(limitsRecord, 'allowed_input_tokens', taskId),
  };
  const directiveRecord = requireRecord(record, 'directive', taskId);
  const authority = requireString(directiveRecord, 'authority', taskId);
  if (authority !== 'explicit_text') {
    throw new SubagentError(`subagent seed directive authority ${authority} is not recognised`, {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const directive: SubagentTaskDirective = {
    text: requireString(directiveRecord, 'text', taskId),
    sha256: requireString(directiveRecord, 'sha256', taskId),
    authority,
  };
  if (sha256Text(directive.text) !== directive.sha256) {
    throw new SubagentError('subagent seed directive hash does not match its text', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const parentLeafId = record['parent_leaf_id'];
  if (parentLeafId !== null && typeof parentLeafId !== 'string') {
    throw new SubagentError('subagent seed parent_leaf_id must be a string or null', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  const projection = requireRecord(record, 'conversation_projection', taskId);
  const projectionPolicy = requireRecord(projection, 'policy', taskId);
  if (requireString(projectionPolicy, 'id', taskId) !== SUBAGENT_CONTEXT_POLICY_ID) {
    throw new SubagentError('subagent seed projection policy id is not the subagent policy', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  if (!Array.isArray(projection['entries'])) {
    throw new SubagentError('subagent seed projection entries must be an array', {
      code: 'seed_hash_mismatch',
      childCreated: true,
      taskId,
    });
  }
  return {
    schema_version: SUBAGENT_SEED_SCHEMA_VERSION,
    task_id: requireString(record, 'task_id', taskId),
    launch_nonce: requireString(record, 'launch_nonce', taskId),
    cwd: requireString(record, 'cwd', taskId),
    extension_mode: extensionMode,
    route,
    parent_system_prompt: requireString(record, 'parent_system_prompt', taskId),
    parent_leaf_id: parentLeafId,
    directive,
    conversation_projection: readSubagentProjection(projection),
    limits,
  };
}

/**
 * The projection body is already hash-pinned by the seed digest verified above,
 * so it is carried through without re-deriving values that would only duplicate
 * the parent's computation.
 */
function readSubagentProjection(
  record: Record<PropertyKey, unknown>,
): SubagentConversationProjection {
  const projection: unknown = record;
  if (!isSubagentProjection(projection)) {
    throw new SubagentError('subagent seed conversation_projection is malformed', {
      code: 'seed_hash_mismatch',
      childCreated: true,
    });
  }
  return projection;
}

function isSubagentProjection(value: unknown): value is SubagentConversationProjection {
  if (!isRecord(value)) return false;
  if (!isRecord(value['policy']) || !isRecord(value['branch_filter'])) return false;
  if (!isRecord(value['accounting'])) return false;
  return Array.isArray(value['entries']);
}
