/**
 * Pi extension-hook contract required by the `subagent_run` child-side guard.
 *
 * The guard installed inside a subagent child depends on runtime behaviour of
 * Pi's `context` and `tool_result` hooks. That behaviour is proved by a
 * characterisation gate which drives a real Pi agent loop and records the
 * observed guarantees; the shipped copy of that observation lives next to this
 * module. Nothing here infers behaviour from type declarations: a guarantee is
 * either observed by that gate or the subagent launch refuses to spawn a child.
 *
 * The evidence bytes are carried over unchanged from the recorded observation in
 * the source repository (same Pi 0.84.x line, same contract id); only the
 * schema envelope was renamed to `pi-subagent.hook-contract.v1`.
 */

import { SubagentError } from './types.js';

export const SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION = 'pi-subagent.hook-contract.v1' as const;

/**
 * Identifier for the exact guard mechanism the child installs.
 *
 * `context-measure-abort-v1`: measure the outgoing message set inside the
 * `context` hook and, when it would exceed the pinned route window, call
 * `ctx.abort()` so the request is never issued, then report a typed failure over
 * the child result channel.
 *
 * Empirically established across the supported Pi lines by the characterisation
 * and exact-version compatibility gates: Pi 0.81.1-0.83.0 invoke the provider
 * entry point with an already-aborted `AbortSignal`, while Pi 0.84.0 propagates
 * that signal through auth resolution and skips the entry point. No network
 * request is issued in either mode, and the run terminates. Throwing from a
 * `context` handler is NOT a barrier at all: Pi catches the exception, reports
 * it as an extension error, and continues dispatch. The guard therefore uses
 * abort, never a throw, and additionally suppresses the oversized content itself
 * so a non-conforming provider cannot transmit it.
 *
 * `tool-result-spill-v1`: replace an oversized `tool_result` payload with an
 * explicit hash-accounted receipt before it enters the transcript.
 */
export const SUBAGENT_HOOK_CONTRACT_ID = 'context-measure-abort-v1+tool-result-spill-v1' as const;

export const SUBAGENT_HOOK_GUARANTEE_NAMES = [
  'context_fires_before_every_model_call',
  'context_result_messages_reach_provider',
  'context_abort_blocks_provider_call',
  'context_abort_skips_stream_invocation',
  'context_abort_terminates_run',
  'context_throw_blocks_provider_call',
  'context_throw_isolated_to_throwing_handler',
  'tool_result_fires_before_transcript_entry',
  'tool_result_replacement_reaches_provider',
  'tool_result_replacement_preserves_identity',
  'tool_result_chains_in_load_order',
  'handlers_run_in_extension_load_order',
] as const;

export type SubagentHookGuaranteeName = (typeof SUBAGENT_HOOK_GUARANTEE_NAMES)[number];

export type SubagentHookGuarantees = Readonly<Record<SubagentHookGuaranteeName, boolean>>;

export interface SubagentHookContractEvidence {
  schema_version: typeof SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION;
  contract_id: typeof SUBAGENT_HOOK_CONTRACT_ID;
  guarantees: SubagentHookGuarantees;
}

/**
 * Guarantees the child guard actually depends on.
 *
 * `context_throw_blocks_provider_call` and
 * `context_abort_skips_stream_invocation` are deliberately absent. Throws do
 * not block dispatch, and skipping the stream entry point is not shared by every
 * supported Pi line. The guard needs neither behavior: it aborts the run AND
 * removes the oversized content from the outgoing message set, so the request
 * cannot be issued and could not carry the content even if it were.
 */
export const SUBAGENT_REQUIRED_HOOK_GUARANTEES: readonly SubagentHookGuaranteeName[] = [
  'context_fires_before_every_model_call',
  'context_result_messages_reach_provider',
  'context_abort_blocks_provider_call',
  'context_abort_terminates_run',
  'context_throw_isolated_to_throwing_handler',
  'tool_result_fires_before_transcript_entry',
  'tool_result_replacement_reaches_provider',
  'tool_result_replacement_preserves_identity',
  'tool_result_chains_in_load_order',
  'handlers_run_in_extension_load_order',
];

export interface SubagentHookContractVerdict {
  supported: boolean;
  missing: readonly SubagentHookGuaranteeName[];
}

export function evaluateSubagentHookContract(
  evidence: SubagentHookContractEvidence,
): SubagentHookContractVerdict {
  const missing = SUBAGENT_REQUIRED_HOOK_GUARANTEES.filter(
    (guarantee) => evidence.guarantees[guarantee] !== true,
  );
  return { supported: missing.length === 0, missing };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict parse. A malformed or partial evidence file is a loud failure, never a default-allow. */
export function parseSubagentHookContractEvidence(value: unknown): SubagentHookContractEvidence {
  if (!isRecord(value)) throw new Error('subagent hook-contract evidence must be an object');
  if (value['schema_version'] !== SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION) {
    throw new Error(
      `subagent hook-contract evidence schema_version must be ${SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION}`,
    );
  }
  if (value['contract_id'] !== SUBAGENT_HOOK_CONTRACT_ID) {
    throw new Error(
      `subagent hook-contract evidence contract_id must be ${SUBAGENT_HOOK_CONTRACT_ID}`,
    );
  }
  const raw = value['guarantees'];
  if (!isRecord(raw))
    throw new Error('subagent hook-contract evidence guarantees must be an object');
  const keys = Object.keys(raw).sort();
  const expected = [...SUBAGENT_HOOK_GUARANTEE_NAMES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(
      `subagent hook-contract evidence guarantees keys mismatch: expected ${expected.join(', ')}`,
    );
  }
  const flag = (name: SubagentHookGuaranteeName): boolean => {
    const observed = raw[name];
    if (typeof observed !== 'boolean') {
      throw new Error(`subagent hook-contract evidence guarantee ${name} must be a boolean`);
    }
    return observed;
  };
  const guarantees: SubagentHookGuarantees = {
    context_fires_before_every_model_call: flag('context_fires_before_every_model_call'),
    context_result_messages_reach_provider: flag('context_result_messages_reach_provider'),
    context_abort_blocks_provider_call: flag('context_abort_blocks_provider_call'),
    context_abort_skips_stream_invocation: flag('context_abort_skips_stream_invocation'),
    context_abort_terminates_run: flag('context_abort_terminates_run'),
    context_throw_blocks_provider_call: flag('context_throw_blocks_provider_call'),
    context_throw_isolated_to_throwing_handler: flag('context_throw_isolated_to_throwing_handler'),
    tool_result_fires_before_transcript_entry: flag('tool_result_fires_before_transcript_entry'),
    tool_result_replacement_reaches_provider: flag('tool_result_replacement_reaches_provider'),
    tool_result_replacement_preserves_identity: flag('tool_result_replacement_preserves_identity'),
    tool_result_chains_in_load_order: flag('tool_result_chains_in_load_order'),
    handlers_run_in_extension_load_order: flag('handlers_run_in_extension_load_order'),
  };
  return {
    schema_version: SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION,
    contract_id: SUBAGENT_HOOK_CONTRACT_ID,
    guarantees,
  };
}

export function loadSubagentHookContractEvidence(raw: string): SubagentHookContractEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SubagentError(
      `subagent hook-contract evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'subagent_hook_contract_unsupported', childCreated: false },
    );
  }
  try {
    return parseSubagentHookContractEvidence(parsed);
  } catch (error) {
    throw new SubagentError(
      `subagent hook-contract evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'subagent_hook_contract_unsupported', childCreated: false },
    );
  }
}
