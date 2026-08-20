import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertSubagentHookContract,
  buildSubagentChildArgv,
  buildSubagentChildPrompt,
  buildSubagentChildSystemPrompt,
  delegateToolsFor,
  ensureSubagentChildSessionDir,
  makeSubagentChildSessionId,
  makeSubagentLaunchNonce,
  makeSubagentTaskId,
  preflightSubagentLaunch,
  resolveSubagentAttributionExtensionPath,
  resolveSubagentChildExtensionPath,
  resolveSubagentRoute,
  subagentChildEnv,
  SUBAGENT_REMOVED_ENV_KEYS,
} from '../extensions/launch.js';
import {
  loadSubagentHookContractEvidence,
  type SubagentHookContractEvidence,
} from '../extensions/hook-contract.js';
import {
  SUBAGENT_INSPECT_TOOLS,
  SubagentError,
  type SubagentPinnedRoute,
} from '../extensions/types.js';
import { SUBAGENT_FORBIDDEN_TOOLS } from '../extensions/removed-surface.js';
import type { ParentContextSource } from '@sakiko233/pi-agent-runtime';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { resolveSubagentLimits } from '../extensions/budget.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const model = { provider: 'test-provider', id: 'test-model', contextWindow: 200_000 };
const otherModel = { provider: 'other-provider', id: 'other-model', contextWindow: 128_000 };

const route: SubagentPinnedRoute = {
  provider: 'test-provider',
  model: 'test-model',
  qualified_id: 'test-provider/test-model',
  context_window_tokens: 200_000,
  thinking_level: 'medium',
  origin: 'parent_current',
};

function parentContext(): ParentContextSource {
  const entries: SessionEntry[] = [
    {
      id: 'e1',
      parentId: null,
      type: 'message',
      message: { role: 'user', content: 'parent context' },
    } as unknown as SessionEntry,
  ];
  return {
    cwd: '/tmp/project',
    getSystemPrompt: () => 'parent system prompt',
    sessionManager: {
      getLeafId: () => 'e1',
      getLeafEntry: () => entries[0],
      getEntries: () => entries,
    },
  };
}

const hookEvidence = loadSubagentHookContractEvidence(
  await readFile(
    fileURLToPath(new URL('../extensions/hook-contract-evidence.json', import.meta.url)),
    'utf8',
  ),
);

describe('subagent route resolution', () => {
  it('pins the parent current model when no route is given', () => {
    const pinned = resolveSubagentRoute({
      currentModel: model,
      availableModels: [model, otherModel],
      thinkingLevel: 'low',
    });
    expect(pinned.origin).toBe('parent_current');
    expect(pinned.qualified_id).toBe('test-provider/test-model');
    expect(pinned.context_window_tokens).toBe(200_000);
    expect(pinned.thinking_level).toBe('low');
  });

  it('pins an explicit route and never substitutes an unavailable one', () => {
    const pinned = resolveSubagentRoute({
      requested: { provider: 'other-provider', model: 'other-model' },
      availableModels: [model, otherModel],
      thinkingLevel: 'low',
    });
    expect(pinned.origin).toBe('explicit');
    expect(pinned.model).toBe('other-model');
    const failure = (() => {
      try {
        resolveSubagentRoute({
          requested: { provider: 'ghost', model: 'missing' },
          availableModels: [model],
          thinkingLevel: 'low',
        });
      } catch (error) {
        return error;
      }
      throw new Error('expected route resolution to throw');
    })();
    expect(failure).toBeInstanceOf(SubagentError);
    expect((failure as SubagentError).code).toBe('route_unresolved');
    expect((failure as SubagentError).childCreated).toBe(false);
    expect((failure as SubagentError).message).toContain('No substitute route was selected');
  });

  it('refuses a route without a context window and a parent without a model', () => {
    const noWindow = (() => {
      try {
        resolveSubagentRoute({
          requested: { provider: 'test-provider', model: 'test-model' },
          availableModels: [{ provider: 'test-provider', id: 'test-model' }],
          thinkingLevel: 'low',
        });
      } catch (error) {
        return error;
      }
      throw new Error('expected capacity refusal');
    })();
    expect((noWindow as SubagentError).code).toBe('route_capacity_unknown');

    const noModel = (() => {
      try {
        resolveSubagentRoute({ availableModels: [model], thinkingLevel: 'low' });
      } catch (error) {
        return error;
      }
      throw new Error('expected missing-model refusal');
    })();
    expect((noModel as SubagentError).code).toBe('route_unresolved');
  });
});

describe('subagent child isolation surface', () => {
  it('resolves the child guard and attribution loader paths from this package', () => {
    const childExtension = resolveSubagentChildExtensionPath();
    expect(
      childExtension.endsWith('subagent-child.ts') || childExtension.endsWith('subagent-child.js'),
    ).toBe(true);
    const attribution = resolveSubagentAttributionExtensionPath();
    expect(
      attribution.endsWith('subagent-attribution.ts') ||
        attribution.endsWith('subagent-attribution.js'),
    ).toBe(true);
  });

  it('admits only inspect and refuses any capability that would enable forbidden tools', () => {
    expect(delegateToolsFor('inspect')).toEqual(SUBAGENT_INSPECT_TOOLS);
    const failure = (() => {
      try {
        delegateToolsFor('write' as never);
      } catch (error) {
        return error;
      }
      throw new Error('expected capability refusal');
    })();
    expect(failure).toBeInstanceOf(SubagentError);
    expect((failure as SubagentError).code).toBe('subagent_isolation_unsupported');
  });

  it('builds an argv that allowlists read-only tools and pins the route', () => {
    const argv = buildSubagentChildArgv({
      route,
      capability: 'inspect',
      extensionMode: 'isolated',
      childSessionId: 'subagent-child-1',
      childSessionDir: '/tmp/child-session',
      childExtensionPath: '/pkg/extensions/subagent-child.ts',
      systemPrompt: 'child system prompt',
    });
    const toolsIndex = argv.indexOf('--tools');
    expect(argv[toolsIndex + 1]?.split(',')).toEqual([...SUBAGENT_INSPECT_TOOLS]);
    expect(argv).toContain('--no-builtin-tools');
    expect(argv).toContain('--no-extensions');
    expect(argv).toContain('--no-skills');
    expect(argv).toContain('--no-prompt-templates');
    expect(argv).toContain('--no-themes');
    expect(argv).toContain('--no-context-files');
    const excludeIndex = argv.indexOf('--exclude-tools');
    expect(argv[excludeIndex + 1]?.split(',')).toEqual([...SUBAGENT_FORBIDDEN_TOOLS]);
    expect(argv).toContain('subagent-child-1');
    expect(argv).toContain('test-provider');
    expect(argv).toContain('test-model');
    expect(argv.filter((arg) => arg === '--extension')).toEqual(['--extension']);
    expect(argv.filter((arg) => arg === '--provider')).toEqual(['--provider']);
  });

  it('enables ambient extension discovery only when explicitly requested', () => {
    const argv = buildSubagentChildArgv({
      route,
      capability: 'inspect',
      extensionMode: 'ambient',
      childSessionId: 'subagent-child-1',
      childSessionDir: '/tmp/child-session',
      childExtensionPath: '/pkg/extensions/subagent-child.ts',
      systemPrompt: 'child system prompt',
    });
    expect(argv).not.toContain('--no-extensions');
  });

  it('prepends the attribution extension only for anthropic routes', () => {
    const anthropicRoute: SubagentPinnedRoute = {
      ...route,
      provider: 'anthropic',
      qualified_id: 'anthropic/claude-x',
    };
    const argv = buildSubagentChildArgv({
      route: anthropicRoute,
      capability: 'inspect',
      extensionMode: 'isolated',
      childSessionId: 'subagent-child-1',
      childSessionDir: '/tmp/child-session',
      childExtensionPath: '/pkg/extensions/subagent-child.ts',
      attributionExtensionPath: '/pkg/extensions/subagent-attribution.ts',
      systemPrompt: 'child system prompt',
    });
    const extensionPaths = argv.filter((_arg, index) => argv[index - 1] === '--extension');
    expect(extensionPaths).toHaveLength(2);
    expect(extensionPaths[0]).toContain('subagent-attribution');
    expect(extensionPaths[1]).toContain('subagent-child');
    const nonAnthropic = buildSubagentChildArgv({
      route,
      capability: 'inspect',
      extensionMode: 'isolated',
      childSessionId: 'subagent-child-1',
      childSessionDir: '/tmp/child-session',
      childExtensionPath: '/pkg/extensions/subagent-child.ts',
      systemPrompt: 'child system prompt',
    });
    expect(nonAnthropic.filter((_arg, index) => nonAnthropic[index - 1] === '--extension')).toEqual([
      '/pkg/extensions/subagent-child.ts',
    ]);
  });

  it('strips parent session identity and installs subagent contract env vars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-subagent-launch-'));
    roots.push(root);
    const env = subagentChildEnv(
      {
        artifactDirAbs: `${root}/artifacts`,
        seedPathAbs: `${root}/artifacts/seed.json`,
        seedSha256: `sha256:${'f'.repeat(64)}`,
        taskId: `s${'a'.repeat(32)}`,
        launchNonce: 'n'.repeat(32),
      },
      {
        ...process.env,
        PI_SESSION_ID: 'parent-session',
        PI_SESSION_FILE: '/parent/session.jsonl',
        PI_PROVIDER: 'parent-provider',
        PI_MODEL: 'parent-model',
        PI_REASONING_LEVEL: 'high',
      } as NodeJS.ProcessEnv,
    );
    for (const key of SUBAGENT_REMOVED_ENV_KEYS) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env['PI_SKIP_VERSION_CHECK']).toBe('1');
    for (const [key, expected] of Object.entries({
      PI_SUBAGENT_ARTIFACT_DIR: `${root}/artifacts`,
      PI_SUBAGENT_SEED_PATH: `${root}/artifacts/seed.json`,
      PI_SUBAGENT_TASK_ID: `s${'a'.repeat(32)}`,
      PI_SUBAGENT_LAUNCH_NONCE: 'n'.repeat(32),
    })) {
      expect(env[key]).toBe(expected);
    }
  });
});

describe('subagent launch preflight', () => {
  it('completes preflight without creating any process or artifact', () => {
    const taskId = makeSubagentTaskId();
    expect(taskId).toMatch(/^s[0-9a-f]{32}$/);
    expect(makeSubagentLaunchNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(makeSubagentChildSessionId()).toMatch(/^subagent-[0-9a-f]{32}$/);
    const result = preflightSubagentLaunch({
      ctx: parentContext(),
      toolCallId: 'call-1',
      prompt: 'investigate the flaky test',
      capability: 'inspect',
      extensionMode: 'isolated',
      route,
      limitOverrides: {},
      hookEvidence,
    });
    expect(result.taskId).toMatch(/^s[0-9a-f]{32}$/);
    expect(result.childPrompt).toContain('TASK SEED (JSON)');
    expect(result.childPrompt).toContain('investigate the flaky test');
    expect(result.childPrompt).toContain('YOUR DIRECTIVE (authoritative');
    expect(result.childSystemPrompt).toContain('inspect-only');
    expect(result.seed.seed.task_id).toBe(result.taskId);
    expect(result.plan.fits).toBe(true);
  });

  it('refuses to launch when the hook contract is unsupported', () => {
    assertSubagentHookContract(hookEvidence);
    const broken: SubagentHookContractEvidence = {
      schema_version: hookEvidence.schema_version,
      contract_id: hookEvidence.contract_id,
      guarantees: { ...hookEvidence.guarantees, context_abort_blocks_provider_call: false },
    };
    const failure = (() => {
      try {
        assertSubagentHookContract(broken);
      } catch (error) {
        return error;
      }
      throw new Error('expected hook contract refusal');
    })();
    expect(failure).toBeInstanceOf(SubagentError);
    expect((failure as SubagentError).code).toBe('subagent_hook_contract_unsupported');
    expect((failure as SubagentError).message).toContain('No child was created');
  });

  it('creates a task-owned child session directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-subagent-launch-'));
    roots.push(root);
    const dir = await ensureSubagentChildSessionDir(root);
    expect(dir).toBe(join(root, 'child-session'));
  });

  it('builds a self-contained child prompt that carries the seed', () => {
    const prompt = buildSubagentChildPrompt('{"seed":1}', 'do the thing');
    expect(prompt).toContain('{"seed":1}');
    expect(prompt).toContain('do the thing');
    expect(buildSubagentChildSystemPrompt('hint')).toContain('hint');
  });
});
