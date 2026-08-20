import { join } from 'node:path';
import {
  allowedInputTokens,
  type EstimateInputTokensResult,
  estimateInputTokens,
  isUsableContextWindow,
  knownTextSegment,
  resolveTokenBudgetFamily,
  TOKEN_BUDGET_CALIBRATION_VERSION,
  TOKEN_BUDGET_FAMILY_CALIBRATIONS,
  TOKEN_BUDGET_RATE_SCALE,
  type TokenBudgetByteClassBreakdown,
  type TokenBudgetFamily,
  type TokenBudgetFamilyCalibration,
  type TokenBudgetRateSource,
  utf8ByteClassBreakdown,
} from '@sakiko233/pi-agent-runtime';
import {
  SUBAGENT_BUDGET_PLAN_SCHEMA_VERSION,
  SubagentError,
  type SubagentLimits,
  type SubagentPinnedRoute,
} from './types.js';

/**
 * Subagent budgeting.
 *
 * A subagent child is a multi-turn, tool-using agent, so its budget has two
 * distinct phases rather than a single-shot stage forecast:
 *
 * 1. Launch admission checks the frozen seed, framing, and child system prompt
 *    with the runtime's strict-launch profile.
 * 2. A separate provable 1 B/token forecast sizes the transcript-growth runway
 *    used for explicit tool-result spilling.
 * 3. Runtime measurements are advisory. Package-owned growth is controlled
 *    before transcript entry; Pi and the provider own live context handling.
 *
 * Nothing here clips, substitutes, or silently reduces content. Tool bytes that
 * do not fit the retained-growth runway are preserved as hashed spill artifacts.
 */

/** Output tokens reserved so the child can always finish an answer. */
export const SUBAGENT_RESERVED_OUTPUT_TOKENS = 16_384;
/** Provider/tool-schema framing the package does not directly control. */
export const SUBAGENT_FRAMING_RESERVE_TOKENS = 8_192;
export const SUBAGENT_SAFETY_RESERVE_TOKENS = 4_096;
/** Below this, a route cannot hold a useful seed plus real investigation. */
export const SUBAGENT_MIN_USABLE_INPUT_TOKENS = 8_192;
export const SUBAGENT_MIN_CONTEXT_WINDOW_TOKENS =
  SUBAGENT_MIN_USABLE_INPUT_TOKENS +
  SUBAGENT_RESERVED_OUTPUT_TOKENS +
  SUBAGENT_FRAMING_RESERVE_TOKENS +
  SUBAGENT_SAFETY_RESERVE_TOKENS;

export const SUBAGENT_DEFAULT_MAX_TURNS = 24;
export const SUBAGENT_DEFAULT_MAX_TOOL_CALLS = 120;
export const SUBAGENT_DEFAULT_TIMEOUT_SECONDS = 1200;
export const SUBAGENT_MAX_TOOL_RESULT_BYTES = 64 * 1024;
export const SUBAGENT_MAX_TOTAL_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;
export const SUBAGENT_MAX_ANSWER_BYTES = 4 * 1024 * 1024;
/** Input runway held back for a final no-tool answer after investigation. */
export const SUBAGENT_FINALIZATION_INPUT_RESERVE_TOKENS = 32 * 1024;
/** Remaining retained-growth runway at which the child disables tools. */
export const SUBAGENT_FINALIZATION_TRIGGER_TOKENS = 8 * 1024;
/** Answers at or under this serialize inline; larger ones degrade explicitly. */
export const SUBAGENT_INLINE_ANSWER_BYTES = 48 * 1024;

export const SUBAGENT_BUDGET_POLICY_ID = 'subagent-budget-policy-v3';

export interface SubagentBudgetPolicyDescriptor {
  id: typeof SUBAGENT_BUDGET_POLICY_ID;
  calibration_version: string;
  calibration_table: Readonly<Record<TokenBudgetFamily, TokenBudgetFamilyCalibration>>;
  reserved_output_tokens: number;
  framing_reserve_tokens: number;
  safety_reserve_tokens: number;
  min_usable_input_tokens: number;
  inline_answer_bytes: number;
  finalization_input_reserve_tokens: number;
  finalization_trigger_tokens: number;
  launch_estimator_scope: 'strict_child_launch';
  retained_growth_estimator_scope: 'provable_1_byte_per_token';
  live_provider_context_owner: 'pi_and_provider';
}

export const SUBAGENT_BUDGET_POLICY: SubagentBudgetPolicyDescriptor = {
  id: SUBAGENT_BUDGET_POLICY_ID,
  calibration_version: TOKEN_BUDGET_CALIBRATION_VERSION,
  calibration_table: TOKEN_BUDGET_FAMILY_CALIBRATIONS,
  reserved_output_tokens: SUBAGENT_RESERVED_OUTPUT_TOKENS,
  framing_reserve_tokens: SUBAGENT_FRAMING_RESERVE_TOKENS,
  safety_reserve_tokens: SUBAGENT_SAFETY_RESERVE_TOKENS,
  min_usable_input_tokens: SUBAGENT_MIN_USABLE_INPUT_TOKENS,
  inline_answer_bytes: SUBAGENT_INLINE_ANSWER_BYTES,
  finalization_input_reserve_tokens: SUBAGENT_FINALIZATION_INPUT_RESERVE_TOKENS,
  finalization_trigger_tokens: SUBAGENT_FINALIZATION_TRIGGER_TOKENS,
  launch_estimator_scope: 'strict_child_launch',
  retained_growth_estimator_scope: 'provable_1_byte_per_token',
  live_provider_context_owner: 'pi_and_provider',
};

export interface SubagentAdmissionPlanV1 {
  schema_version: typeof SUBAGENT_BUDGET_PLAN_SCHEMA_VERSION;
  policy: SubagentBudgetPolicyDescriptor;
  route: {
    provider: string;
    model: string;
    qualified_id: string;
    context_window_tokens: number;
    allowed_input_tokens: number;
    family: TokenBudgetFamily;
    backed: boolean;
    rate_source: TokenBudgetRateSource;
    byte_capacity_utf8_bytes: number;
  };
  child_prompt_utf8_bytes: number;
  child_prompt_multibyte_utf8_bytes: number;
  system_prompt_utf8_bytes: number;
  system_prompt_multibyte_utf8_bytes: number;
  launch_utf8_bytes: number;
  launch_input_tokens_upper_bound: number;
  conservative_launch_input_tokens: number;
  conservative_launch_fits: boolean;
  signed_headroom_tokens: number;
  utilization_basis_points: number;
  retained_growth_budget_tokens: number;
  finalization_input_reserve_tokens: number;
  byte_class_breakdown: TokenBudgetByteClassBreakdown;
  dominant_byte_class: EstimateInputTokensResult['rateSource']['dominant_byte_class'];
  estimate: EstimateInputTokensResult;
  conservative_estimate: EstimateInputTokensResult;
  fits: boolean;
  limits: SubagentLimits;
}

function utilizationBasisPoints(tokens: number, allowed: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new TypeError('tokens must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(allowed) || allowed <= 0) {
    throw new TypeError('allowed must be a positive safe integer');
  }
  return Math.floor((tokens * 10_000 + allowed - 1) / allowed);
}

export interface SubagentRouteFamilyResolution {
  family: TokenBudgetFamily;
  backed: boolean;
  resolution: 'model_override' | 'family_direct';
}

/**
 * Route family policy for subagent estimation.
 *
 * The runtime resolves only its frozen calibrated model set and throws for
 * every other route; that throw is its documented strict contract, not an
 * error condition here. Routes outside the calibrated set are estimated under
 * the explicitly selected `unknown` family (unbacked 1.00 B/tok floor), which
 * the runtime requires callers to state via `family_direct`.
 */
export function subagentRouteFamily(route: {
  provider: string;
  model: string;
}): SubagentRouteFamilyResolution {
  try {
    const resolved = resolveTokenBudgetFamily(route);
    return { family: resolved.family, backed: resolved.backed, resolution: 'model_override' };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No calibrated token family')) {
      throw error;
    }
    return { family: 'unknown', backed: false, resolution: 'family_direct' };
  }
}

function routeFamily(route: SubagentPinnedRoute): SubagentRouteFamilyResolution {
  return subagentRouteFamily(route);
}

/**
 * Usable input tokens for a pinned route.
 *
 * A route with an unknown, non-integral, or non-positive context window is a
 * loud `route_capacity_unknown` refusal. The subagent never assumes a default
 * window, because assuming one is how oversized prompts reach a provider.
 */
export function subagentAllowedInputTokens(route: SubagentPinnedRoute): number {
  if (!isUsableContextWindow(route.context_window_tokens)) {
    throw new SubagentError(
      `subagent_run route ${route.qualified_id} reports no usable context-window capacity`,
      {
        code: 'route_capacity_unknown',
        childCreated: false,
        remediation: [
          'Pin an explicit route whose model catalogue entry declares a context window.',
          'No child was created and no capacity was assumed.',
        ],
      },
    );
  }
  const allowed = allowedInputTokens(route.context_window_tokens, {
    reservedOutputTokens: SUBAGENT_RESERVED_OUTPUT_TOKENS,
    framingReserveTokens: SUBAGENT_FRAMING_RESERVE_TOKENS,
    safetyReserveTokens: SUBAGENT_SAFETY_RESERVE_TOKENS,
  });
  if (allowed < SUBAGENT_MIN_USABLE_INPUT_TOKENS) {
    throw new SubagentError(
      `subagent_run route ${route.qualified_id} has a ${String(route.context_window_tokens)}-token context window, but a subagent child requires at least ${String(SUBAGENT_MIN_CONTEXT_WINDOW_TOKENS)} tokens: ${String(SUBAGENT_RESERVED_OUTPUT_TOKENS)} output + ${String(SUBAGENT_FRAMING_RESERVE_TOKENS)} framing + ${String(SUBAGENT_SAFETY_RESERVE_TOKENS)} safety + ${String(SUBAGENT_MIN_USABLE_INPUT_TOKENS)} usable input`,
      {
        code: 'route_capacity_unknown',
        childCreated: false,
        remediation: ['Pin a larger-context route for this subagent.'],
      },
    );
  }
  return allowed;
}

export interface SubagentAdmissionInput {
  route: SubagentPinnedRoute;
  childPrompt: string;
  childSystemPrompt: string;
  limits: SubagentLimits;
}

/** Deterministic launch-admission forecast. Pure; creates nothing. */
export function planSubagentAdmission(input: SubagentAdmissionInput): SubagentAdmissionPlanV1 {
  const allowed = subagentAllowedInputTokens(input.route);
  const family = routeFamily(input.route);
  const childPrompt = utf8ByteClassBreakdown(input.childPrompt);
  const system = utf8ByteClassBreakdown(input.childSystemPrompt);
  const segments = [knownTextSegment(input.childPrompt), knownTextSegment(input.childSystemPrompt)];
  const estimate = estimateInputTokens({
    family: family.family,
    calibrationBacked: family.backed,
    familyResolution: family.resolution,
    allowedInputTokens: allowed,
    profile: 'strict-launch',
    segments,
  });
  const conservativeEstimate = estimateInputTokens({
    family: family.family,
    calibrationBacked: family.backed,
    familyResolution: family.resolution,
    allowedInputTokens: allowed,
    profile: 'provable',
    segments,
  });
  // `conservativeEstimate.tokens` intentionally uses the shared estimator's
  // calibrated multibyte diagnostic rate. The counter-forecast published as
  // "provable" must instead use that estimator's explicit 1 B/token ceiling
  // for multibyte bytes as well as normal/dense bytes.
  const provableConservativeLaunchTokens =
    conservativeEstimate.advisory.input_tokens_if_multibyte_used_provable_ceiling;
  const byteCapacity = Math.floor(
    (allowed * estimate.rateSource.effective_rate_bytes_per_token_x100) / TOKEN_BUDGET_RATE_SCALE,
  );
  const launchBytes = childPrompt.bytes + system.bytes;
  const retainedGrowthBudget = Math.max(
    0,
    allowed - estimate.tokens - SUBAGENT_FINALIZATION_INPUT_RESERVE_TOKENS,
  );
  return {
    schema_version: SUBAGENT_BUDGET_PLAN_SCHEMA_VERSION,
    policy: SUBAGENT_BUDGET_POLICY,
    route: {
      provider: input.route.provider,
      model: input.route.model,
      qualified_id: input.route.qualified_id,
      context_window_tokens: input.route.context_window_tokens,
      allowed_input_tokens: allowed,
      family: family.family,
      backed: estimate.rateSource.backed,
      rate_source: estimate.rateSource,
      byte_capacity_utf8_bytes: byteCapacity,
    },
    child_prompt_utf8_bytes: childPrompt.bytes,
    child_prompt_multibyte_utf8_bytes: childPrompt.multibyteBytes,
    system_prompt_utf8_bytes: system.bytes,
    system_prompt_multibyte_utf8_bytes: system.multibyteBytes,
    launch_utf8_bytes: launchBytes,
    launch_input_tokens_upper_bound: estimate.tokens,
    conservative_launch_input_tokens: provableConservativeLaunchTokens,
    conservative_launch_fits: provableConservativeLaunchTokens <= allowed,
    signed_headroom_tokens: allowed - estimate.tokens,
    utilization_basis_points: utilizationBasisPoints(estimate.tokens, allowed),
    retained_growth_budget_tokens: retainedGrowthBudget,
    finalization_input_reserve_tokens: SUBAGENT_FINALIZATION_INPUT_RESERVE_TOKENS,
    byte_class_breakdown: estimate.byte_class_breakdown,
    dominant_byte_class: estimate.rateSource.dominant_byte_class,
    estimate,
    conservative_estimate: conservativeEstimate,
    fits: estimate.tokens <= allowed,
    limits: input.limits,
  };
}

function rateWarningText(rateSource: TokenBudgetRateSource, qualifiedId: string): string {
  if (rateSource.warning === null) return '';
  return ` Estimator warning for ${qualifiedId}: ${rateSource.warning}.`;
}

function requiredByteReduction(plan: SubagentAdmissionPlanV1): number {
  const variableTokens = plan.route.allowed_input_tokens - plan.route.rate_source.affine_f_tokens;
  const maximumBytes =
    variableTokens <= 0
      ? 0
      : Math.floor(
          (variableTokens * plan.route.rate_source.effective_rate_bytes_per_token_x100) /
            TOKEN_BUDGET_RATE_SCALE,
        );
  return Math.max(0, plan.launch_utf8_bytes - maximumBytes);
}

/**
 * Enforce the admission plan.
 *
 * Called before the child process, the child session, and the artifact
 * directory exist, so a refusal leaves zero children and zero artifacts.
 */
export function assertSubagentAdmission(plan: SubagentAdmissionPlanV1): void {
  if (plan.fits) return;
  const overage = plan.launch_input_tokens_upper_bound - plan.route.allowed_input_tokens;
  throw new SubagentError(
    `subagent_run child prompt does not fit the pinned route before launch. Route ${plan.route.qualified_id} allows ${String(plan.route.allowed_input_tokens)} input tokens; the exact child prompt plus child system prompt measure ${String(plan.launch_utf8_bytes)} UTF-8 bytes (<= ${String(plan.launch_input_tokens_upper_bound)} input tokens), over by ${String(overage)} tokens. Estimator family ${plan.route.family}, source ${plan.route.rate_source.source}, backed=${String(plan.route.rate_source.backed)}, dominant_byte_class=${plan.dominant_byte_class}, rate ${String(plan.route.rate_source.effective_rate_bytes_per_token_x100)}/100 B/tok + ${String(plan.route.rate_source.affine_f_tokens)} tokens.${rateWarningText(plan.route.rate_source, plan.route.qualified_id)} Required reduction is at least ${String(requiredByteReduction(plan))} UTF-8 bytes. No child process, child session, or artifact was created. Nothing was clipped, dropped, or substituted.`,
    {
      code: 'seed_budget_exceeded',
      childCreated: false,
      budget: {
        measurement_kind: 'launch_admission',
        measured_utf8_bytes: plan.launch_utf8_bytes,
        measured_input_tokens_upper_bound: plan.launch_input_tokens_upper_bound,
        allowed_input_tokens: plan.route.allowed_input_tokens,
        rate_source: plan.route.rate_source,
        backed: plan.route.rate_source.backed,
        dominant_byte_class: plan.dominant_byte_class,
        byte_class_breakdown: plan.byte_class_breakdown,
      },
      remediation: [
        'Pin a larger-context route with the route argument.',
        'Delegate earlier in the session, or start a fresh conversation, so less history is projected.',
        'Restate only the required findings as visible conversation text; omitted tool payloads are not what is large here.',
      ],
    },
  );
}

export interface SubagentRuntimeMeasurement {
  /** Complete retained input for the next model call, in UTF-8 bytes. */
  retainedInputBytes: number;
  retainedInputMultibyteBytes: number;
  retainedInputDenseBytes: number;
  retainedInputAsciiWhitespaceBytes: number;
}

export interface SubagentGovernorVerdict {
  withinBudget: boolean;
  measuredTokens: number;
  allowedTokens: number;
  overageTokens: number;
  byteClassBreakdown: TokenBudgetByteClassBreakdown;
  dominantByteClass: EstimateInputTokensResult['rateSource']['dominant_byte_class'];
  backed: boolean;
  rateSource: TokenBudgetRateSource;
}

/**
 * Advisory runtime measurement for one prospective model call.
 *
 * This deliberately uses the strict-runtime profile and never decides whether
 * transport may occur. A package-local estimator must not reject a live
 * provider payload by subtracting hypothetical output. The subagent child uses
 * this result for evidence and graceful finalization while proactive spilling
 * controls package-owned growth.
 */
export function evaluateSubagentRuntimeBudget(
  measurement: SubagentRuntimeMeasurement,
  allowedTokens: number,
  route: { provider: string; model: string },
): SubagentGovernorVerdict {
  const family = subagentRouteFamily(route);
  const estimate = estimateInputTokens({
    family: family.family,
    calibrationBacked: family.backed,
    familyResolution: family.resolution,
    allowedInputTokens: allowedTokens,
    profile: 'strict-runtime',
    segments: [
      {
        kind: 'known_text',
        bytes: measurement.retainedInputBytes,
        multibyteBytes: measurement.retainedInputMultibyteBytes,
        denseBytes: measurement.retainedInputDenseBytes,
        asciiWhitespaceBytes: measurement.retainedInputAsciiWhitespaceBytes,
      },
    ],
  });
  return {
    withinBudget: estimate.tokens <= allowedTokens,
    measuredTokens: estimate.tokens,
    allowedTokens,
    overageTokens: Math.max(0, estimate.tokens - allowedTokens),
    byteClassBreakdown: estimate.byte_class_breakdown,
    dominantByteClass: estimate.rateSource.dominant_byte_class,
    backed: estimate.rateSource.backed,
    rateSource: estimate.rateSource,
  };
}

export interface SubagentLimitOverrides {
  maxTurns?: number | undefined;
  maxToolCalls?: number | undefined;
  timeoutSeconds?: number | undefined;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new SubagentError(`subagent_run ${label} must be a positive integer`, {
      code: 'invalid_arguments',
      childCreated: false,
    });
  }
  return value;
}

export function resolveSubagentLimits(
  route: SubagentPinnedRoute,
  overrides: SubagentLimitOverrides = {},
): SubagentLimits {
  return {
    max_turns: positiveInteger(overrides.maxTurns, SUBAGENT_DEFAULT_MAX_TURNS, 'maxTurns'),
    max_tool_calls: positiveInteger(
      overrides.maxToolCalls,
      SUBAGENT_DEFAULT_MAX_TOOL_CALLS,
      'maxToolCalls',
    ),
    timeout_seconds: positiveInteger(
      overrides.timeoutSeconds,
      SUBAGENT_DEFAULT_TIMEOUT_SECONDS,
      'timeoutSeconds',
    ),
    max_tool_result_bytes: SUBAGENT_MAX_TOOL_RESULT_BYTES,
    max_total_tool_output_bytes: SUBAGENT_MAX_TOTAL_TOOL_OUTPUT_BYTES,
    max_answer_bytes: SUBAGENT_MAX_ANSWER_BYTES,
    allowed_input_tokens: subagentAllowedInputTokens(route),
  };
}

export interface SubagentInlineDecision {
  mode: 'inline' | 'artifact';
  reason: string;
}

/**
 * Decide inline versus artifact delivery.
 *
 * The cap is applied to the exact serialized answer bytes. An answer over the
 * cap degrades to an artifact reference explicitly and is never shortened to
 * fit.
 */
export function decideSubagentDelivery(
  answerBytes: number,
  requested: 'inline' | 'artifact' | undefined,
  cap = SUBAGENT_INLINE_ANSWER_BYTES,
): SubagentInlineDecision {
  if (requested === 'artifact') {
    return { mode: 'artifact', reason: 'artifact delivery was requested explicitly' };
  }
  if (answerBytes <= cap) {
    return {
      mode: 'inline',
      reason: `the answer is ${String(answerBytes)} bytes, within the ${String(cap)}-byte inline cap`,
    };
  }
  return {
    mode: 'artifact',
    reason: `the answer is ${String(answerBytes)} bytes, over the ${String(cap)}-byte inline cap`,
  };
}

/** Raised when inline delivery was explicitly requested for an oversized answer. */
export function inlineTooLarge(
  taskId: string,
  artifactDir: string,
  answerBytes: number,
  cap = SUBAGENT_INLINE_ANSWER_BYTES,
): SubagentError {
  return new SubagentError(
    `subagent_result cannot return this answer inline: it is ${String(answerBytes)} bytes, over the ${String(cap)}-byte inline cap. The complete verified answer is preserved at ${join(artifactDir, 'result.json')}. It is not truncated to fit.`,
    {
      code: 'result_too_large_for_inline',
      childCreated: true,
      taskId,
      artifactDir,
      preserved: [join(artifactDir, 'result.json')],
      remediation: [
        'Call subagent_result with delivery:"artifact" to receive the verified metadata plus the artifact reference.',
        'Read the answer from the artifact path directly if the full text is required.',
      ],
    },
  );
}
