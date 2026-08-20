import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ParentContextSource } from '@sakiko233/pi-agent-runtime';
import { describe, expect, it } from 'vitest';
import { resolveSubagentLimits } from '../extensions/budget.js';
import { buildSubagentSeed, verifySubagentSeedBytes } from '../extensions/seed.js';
import type { SubagentPinnedRoute } from '../extensions/types.js';
import { SubagentError } from '../extensions/types.js';

function taskIdHex(char: string): string {
  return `s${char.repeat(32)}`;
}

function nonceHex(char: string): string {
  return `${char.repeat(32)}`;
}

const route: SubagentPinnedRoute = {
  provider: 'test-provider',
  model: 'test-model',
  qualified_id: 'test-provider/test-model',
  context_window_tokens: 200_000,
  thinking_level: 'medium',
  origin: 'parent_current',
};

function messageEntry(
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
): SessionEntry {
  return { id, parentId, type: 'message', message } as unknown as SessionEntry;
}

function assistantEntryWithToolCalls(
  id: string,
  parentId: string | null,
  toolCallIds: readonly string[],
): SessionEntry {
  return messageEntry(id, parentId, {
    role: 'assistant',
    content: [
      { type: 'text', text: 'launching the subagents now' },
      ...toolCallIds.map((toolCallId) => ({
        type: 'toolCall',
        id: toolCallId,
        name: 'subagent_run',
        arguments: {},
      })),
    ],
  });
}

function parentContext(entries: readonly SessionEntry[]): ParentContextSource {
  return {
    cwd: '/tmp/project',
    getSystemPrompt: () => 'parent system prompt',
    sessionManager: {
      getLeafId: () => (entries.length > 0 ? (entries.at(-1)?.id ?? null) : null),
      getLeafEntry: () => entries.at(-1),
      getEntries: () => [...entries],
    },
  };
}

const baseEntries: readonly SessionEntry[] = [
  messageEntry('e1', null, {
    role: 'user',
    content: 'PARENT_VISIBLE_CONTEXT about the incident',
  }),
  messageEntry('e2', 'e1', {
    role: 'assistant',
    content: [{ type: 'text', text: 'assistant reply summarising findings' }],
  }),
  messageEntry('e3', 'e2', { role: 'user', content: 'follow-up question' }),
];

describe('subagent seed construction', () => {
  it('freezes the projected conversation and the authoritative directive', () => {
    const built = buildSubagentSeed(parentContext(baseEntries), {
      taskId: taskIdHex('a'),
      launchNonce: nonceHex('n'),
      toolCallId: 'call-1',
      directive: 'find the root cause of the incident',
      capability: 'inspect',
      extensionMode: 'isolated',
      route,
      limits: resolveSubagentLimits(route),
    });
    expect(built.seed.schema_version).toBe('pi-subagent.seed.v2');
    expect(built.seed.directive.text).toBe('find the root cause of the incident');
    expect(built.seed.directive.authority).toBe('explicit_text');
    expect(built.seed.parent_system_prompt).toBe('parent system prompt');
    expect(built.seed.conversation_projection.policy.id).toBe('subagent-inspect-v1');
    expect(built.seed.conversation_projection.branch_filter.tool_name).toBe('subagent_run');
    expect(built.serialized).toContain('PARENT_VISIBLE_CONTEXT about the incident');
    expect(built.serialized).not.toContain('"toolCall"');
    expect(built.ledger.schema_version).toBe('pi-subagent.ledger.v1');
    expect(built.ledger.root_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);
    const parsed = JSON.parse(built.serialized);
    expect(Object.keys(parsed).sort()).toEqual([
      'capability',
      'conversation_projection',
      'cwd',
      'directive',
      'extension_mode',
      'launch_nonce',
      'limits',
      'parent_leaf_id',
      'parent_system_prompt',
      'route',
      'schema_version',
      'task_id',
    ]);
  });

  it('excludes the in-flight subagent call leaf so sibling launches share one projection', () => {
    const withCall = [
      ...baseEntries,
      assistantEntryWithToolCalls('e4', 'e3', ['call-1', 'call-2']),
    ];
    const built = buildSubagentSeed(parentContext(withCall), {
      taskId: taskIdHex('a'),
      launchNonce: nonceHex('n'),
      toolCallId: 'call-1',
      directive: 'directive',
      capability: 'inspect',
      extensionMode: 'isolated',
      route,
      limits: resolveSubagentLimits(route),
    });
    expect(built.seed.parent_leaf_id).toBe('e3');
    expect(built.seed.conversation_projection.branch_filter.active_tool_call_leaf_excluded).toBe(
      true,
    );
    expect(built.seed.conversation_projection.branch_filter.tool_call_id).toBe('call-1');
    expect(built.serialized).not.toContain('launching the subagents now');
    const sibling = buildSubagentSeed(parentContext(withCall), {
      taskId: taskIdHex('b'),
      launchNonce: nonceHex('m'),
      toolCallId: 'call-2',
      directive: 'sibling directive',
      capability: 'inspect',
      extensionMode: 'isolated',
      route,
      limits: resolveSubagentLimits(route),
    });
    expect(
      JSON.stringify(sibling.seed.conversation_projection.entries) ===
        JSON.stringify(built.seed.conversation_projection.entries),
    ).toBe(true);
  });

  it('refuses a blank directive loudly', () => {
    let failure: unknown;
    try {
      buildSubagentSeed(parentContext(baseEntries), {
        taskId: taskIdHex('a'),
        launchNonce: nonceHex('n'),
        toolCallId: 'call-1',
        directive: '   ',
        capability: 'inspect',
        extensionMode: 'isolated',
        route,
        limits: resolveSubagentLimits(route),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SubagentError);
    expect((failure as SubagentError).code).toBe('invalid_arguments');
  });
});

describe('subagent seed verification (child side)', () => {
  const built = buildSubagentSeed(parentContext(baseEntries), {
    taskId: taskIdHex('a'),
    launchNonce: nonceHex('n'),
    toolCallId: 'call-1',
    directive: 'the directive',
    capability: 'inspect',
    extensionMode: 'isolated',
    route,
    limits: resolveSubagentLimits(route),
  });

  it('accepts the exact frozen bytes and rebuilds every consumed field', () => {
    const seed = verifySubagentSeedBytes(built.serialized, {
      sha256: built.sha256,
      taskId: built.seed.task_id,
      launchNonce: built.seed.launch_nonce,
    });
    expect(seed.capability).toBe('inspect');
    expect(seed.extension_mode).toBe('isolated');
    expect(seed.route.provider).toBe('test-provider');
    expect(seed.route.thinking_level).toBe('medium');
    expect(seed.limits.max_turns).toBe(24);
    expect(seed.directive.text).toBe('the directive');
    expect(seed.conversation_projection.policy.id).toBe('subagent-inspect-v1');
  });

  it('refuses tampered bytes, wrong identity, and stale schemas', () => {
    const cases: Array<{ raw: string; label: string }> = [
      { raw: `${built.serialized}\n`, label: 'appended whitespace' },
      {
        raw: built.serialized.replace('the directive', 'tampered directive'),
        label: 'edited text',
      },
    ];
    for (const item of cases) {
      let failure: unknown;
      try {
        verifySubagentSeedBytes(item.raw, {
          sha256: built.sha256,
          taskId: built.seed.task_id,
          launchNonce: built.seed.launch_nonce,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure, item.label).toBeInstanceOf(SubagentError);
      expect((failure as SubagentError).code, item.label).toBe('seed_hash_mismatch');
    }

    const wrongTask = (() => {
      try {
        verifySubagentSeedBytes(built.serialized, {
          sha256: built.sha256,
          taskId: taskIdHex('z'),
          launchNonce: built.seed.launch_nonce,
        });
      } catch (error) {
        return error;
      }
      throw new Error('expected identity mismatch to throw');
    })();
    expect((wrongTask as SubagentError).code).toBe('seed_hash_mismatch');

    const foreign = JSON.stringify({
      ...JSON.parse(built.serialized),
      schema_version: 'pi-background-tasks.delegate-seed.v2',
    });
    const foreignRehash = (() => {
      try {
        verifySubagentSeedBytes(foreign, {
          sha256: built.sha256,
          taskId: built.seed.task_id,
          launchNonce: built.seed.launch_nonce,
        });
      } catch (error) {
        return error;
      }
      throw new Error('expected schema mismatch to throw');
    })();
    expect((foreignRehash as SubagentError).code).toBe('seed_hash_mismatch');
  });
});
