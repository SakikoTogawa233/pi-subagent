import { describe, expect, it } from 'vitest';
import {
  assertSubagentAdmission,
  decideSubagentDelivery,
  evaluateSubagentRuntimeBudget,
  inlineTooLarge,
  planSubagentAdmission,
  resolveSubagentLimits,
  SUBAGENT_BUDGET_POLICY_ID,
  SUBAGENT_DEFAULT_MAX_TOOL_CALLS,
  SUBAGENT_DEFAULT_MAX_TURNS,
  SUBAGENT_DEFAULT_TIMEOUT_SECONDS,
  SUBAGENT_FINALIZATION_INPUT_RESERVE_TOKENS,
  SUBAGENT_INLINE_ANSWER_BYTES,
  SUBAGENT_MAX_ANSWER_BYTES,
  SUBAGENT_MAX_TOOL_RESULT_BYTES,
  subagentAllowedInputTokens,
} from '../extensions/budget.js';
import type { SubagentPinnedRoute } from '../extensions/types.js';
import { SubagentError } from '../extensions/types.js';

const route: SubagentPinnedRoute = {
  provider: 'test-provider',
  model: 'test-model',
  qualified_id: 'test-provider/test-model',
  context_window_tokens: 200_000,
  thinking_level: 'medium',
  origin: 'parent_current',
};

describe('subagent limits', () => {
  it('applies the documented defaults', () => {
    const limits = resolveSubagentLimits(route);
    expect(limits.max_turns).toBe(SUBAGENT_DEFAULT_MAX_TURNS);
    expect(limits.max_turns).toBe(24);
    expect(limits.max_tool_calls).toBe(SUBAGENT_DEFAULT_MAX_TOOL_CALLS);
    expect(limits.max_tool_calls).toBe(120);
    expect(limits.timeout_seconds).toBe(SUBAGENT_DEFAULT_TIMEOUT_SECONDS);
    expect(limits.timeout_seconds).toBe(1200);
    expect(limits.max_tool_result_bytes).toBe(SUBAGENT_MAX_TOOL_RESULT_BYTES);
    expect(limits.max_answer_bytes).toBe(SUBAGENT_MAX_ANSWER_BYTES);
    expect(limits.allowed_input_tokens).toBeGreaterThan(0);
  });

  it('accepts positive integer overrides and refuses everything else', () => {
    expect(resolveSubagentLimits(route, { maxTurns: 3 }).max_turns).toBe(3);
    expect(resolveSubagentLimits(route, { maxToolCalls: 7 }).max_tool_calls).toBe(7);
    expect(resolveSubagentLimits(route, { timeoutSeconds: 90 }).timeout_seconds).toBe(90);
    for (const bad of [0, -1, 2.5, Number.POSITIVE_INFINITY]) {
      const failure = (() => {
        try {
          resolveSubagentLimits(route, { maxTurns: bad });
        } catch (error) {
          return error;
        }
        throw new Error('expected resolveSubagentLimits to throw');
      })();
      expect(failure).toBeInstanceOf(SubagentError);
      expect((failure as SubagentError).code).toBe('invalid_arguments');
    }
  });

  it('refuses routes without usable context capacity instead of assuming one', () => {
    for (const window of [0, -5, 8_192, 16_384, 20_000]) {
      const tiny: SubagentPinnedRoute = { ...route, context_window_tokens: window };
      const failure = (() => {
        try {
          subagentAllowedInputTokens(tiny);
        } catch (error) {
          return error;
        }
        throw new Error('expected subagentAllowedInputTokens to throw');
      })();
      expect(failure).toBeInstanceOf(SubagentError);
      expect((failure as SubagentError).code).toBe('route_capacity_unknown');
    }
    expect(subagentAllowedInputTokens(route)).toBe(
      resolveSubagentLimits(route).allowed_input_tokens,
    );
  });
});

describe('subagent launch admission', () => {
  it('plans and admits a prompt that fits, under the strict-launch profile', () => {
    const limits = resolveSubagentLimits(route);
    const plan = planSubagentAdmission({
      route,
      childPrompt: 'investigate the failing build and report the root cause',
      childSystemPrompt: 'you are a subagent child',
      limits,
    });
    expect(plan.schema_version).toBe('pi-subagent.budget-plan.v3');
    expect(plan.policy.id).toBe(SUBAGENT_BUDGET_POLICY_ID);
    expect(plan.fits).toBe(true);
    expect(plan.limits).toEqual(limits);
    expect(plan.route.qualified_id).toBe('test-provider/test-model');
    expect(plan.route.family).toBe('unknown');
    expect(plan.route.backed).toBe(false);
    expect(plan.estimate.rateSource.profile).toBe('strict-launch');
    expect(plan.conservative_estimate.rateSource.profile).toBe('provable');
    expect(plan.retained_growth_budget_tokens).toBeGreaterThan(0);
    expect(plan.finalization_input_reserve_tokens).toBe(SUBAGENT_FINALIZATION_INPUT_RESERVE_TOKENS);
    expect(() => assertSubagentAdmission(plan)).not.toThrow();
  });

  it('refuses a prompt that cannot fit, with a typed budget failure and no clipping hint', () => {
    const limits = resolveSubagentLimits(route);
    const huge = 'x'.repeat(1024 * 1024);
    const plan = planSubagentAdmission({
      route,
      childPrompt: huge,
      childSystemPrompt: 'sys',
      limits,
    });
    expect(plan.fits).toBe(false);
    let failure: unknown;
    try {
      assertSubagentAdmission(plan);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SubagentError);
    const typed = failure as SubagentError;
    expect(typed.code).toBe('seed_budget_exceeded');
    expect(typed.childCreated).toBe(false);
    expect(typed.budget?.measurement_kind).toBe('launch_admission');
    expect(typed.budget?.allowed_input_tokens).toBe(plan.route.allowed_input_tokens);
    expect(typed.budget?.measured_utf8_bytes).toBe(plan.launch_utf8_bytes);
    expect(typed.message).toContain('Nothing was clipped, dropped, or substituted');
  });
});

describe('subagent runtime governor', () => {
  it('measures advisory retained input without refusing transport', () => {
    const verdict = evaluateSubagentRuntimeBudget(
      {
        retainedInputBytes: 10_000,
        retainedInputMultibyteBytes: 500,
        retainedInputDenseBytes: 0,
        retainedInputAsciiWhitespaceBytes: 2_000,
      },
      resolveSubagentLimits(route).allowed_input_tokens,
      { provider: route.provider, model: route.model },
    );
    expect(verdict.allowedTokens).toBe(resolveSubagentLimits(route).allowed_input_tokens);
    expect(verdict.withinBudget).toBe(true);
    expect(verdict.measuredTokens).toBeGreaterThan(0);
    expect(verdict.rateSource.profile).toBe('strict-runtime');
  });

  it('reports overage when the retained input exceeds the allowance', () => {
    const allowed = resolveSubagentLimits(route).allowed_input_tokens;
    const verdict = evaluateSubagentRuntimeBudget(
      {
        retainedInputBytes: allowed * 4,
        retainedInputMultibyteBytes: 0,
        retainedInputDenseBytes: 0,
        retainedInputAsciiWhitespaceBytes: 0,
      },
      allowed,
      { provider: route.provider, model: route.model },
    );
    expect(verdict.withinBudget).toBe(false);
    expect(verdict.overageTokens).toBeGreaterThan(0);
  });
});

describe('subagent delivery decision', () => {
  it('degrades oversized answers to artifact delivery instead of truncating', () => {
    expect(decideSubagentDelivery(10, undefined).mode).toBe('inline');
    expect(decideSubagentDelivery(SUBAGENT_INLINE_ANSWER_BYTES, undefined).mode).toBe('inline');
    expect(decideSubagentDelivery(SUBAGENT_INLINE_ANSWER_BYTES + 1, undefined).mode).toBe(
      'artifact',
    );
    expect(decideSubagentDelivery(10, 'artifact').mode).toBe('artifact');
    expect(decideSubagentDelivery(SUBAGENT_INLINE_ANSWER_BYTES + 1, undefined).reason).toContain(
      'over the 49152-byte inline cap',
    );
  });

  it('raises a typed refusal when inline was requested for an oversized answer', () => {
    const failure = inlineTooLarge(
      `s${'0'.repeat(32)}`,
      '.pi/subagent/x',
      SUBAGENT_INLINE_ANSWER_BYTES + 5,
    );
    expect(failure).toBeInstanceOf(SubagentError);
    expect(failure.code).toBe('result_too_large_for_inline');
    expect(failure.message).toContain('It is not truncated to fit');
    expect(failure.preserved?.[0]).toContain('result.json');
  });
});
