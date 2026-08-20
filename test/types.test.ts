import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DELEGATE_REMOVED, SUBAGENT_FORBIDDEN_TOOLS } from '../extensions/removed-surface.js';
import {
  SUBAGENT_BRANCH_FILTER_ID,
  SUBAGENT_CHILD_ARTIFACT_READER_TOOL,
  SUBAGENT_CONTEXT_POLICY_ID,
  SUBAGENT_EXTENSION_MODES,
  SUBAGENT_INSPECT_TOOLS,
  SUBAGENT_RESULT_TOOL_NAME,
  SUBAGENT_RUN_ATTESTED_TOOL_NAME,
  SUBAGENT_RUN_TOOL_NAME,
  SUBAGENT_SCHEMAS,
  SUBAGENT_TASK_ID_PATTERN,
} from '../extensions/types.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('subagent domain naming', () => {
  it('publishes exactly the three subagent tools', () => {
    expect(SUBAGENT_RUN_TOOL_NAME).toBe('subagent_run');
    expect(SUBAGENT_RESULT_TOOL_NAME).toBe('subagent_result');
    expect(SUBAGENT_RUN_ATTESTED_TOOL_NAME).toBe('subagent_run_attested');
  });

  it('owns every domain schema id under the pi-subagent namespace', () => {
    for (const schemaId of Object.values(SUBAGENT_SCHEMAS)) {
      expect(schemaId.startsWith('pi-subagent.'), schemaId).toBe(true);
    }
    expect(Object.keys(SUBAGENT_SCHEMAS).length).toBeGreaterThan(10);
  });

  it('renames policy ids and tool identities to subagent ownership', () => {
    expect(SUBAGENT_CONTEXT_POLICY_ID).toBe('subagent-inspect-v1');
    expect(SUBAGENT_BRANCH_FILTER_ID).toBe('exclude-active-subagent-batch-v1');
    expect(SUBAGENT_CHILD_ARTIFACT_READER_TOOL).toBe('subagent_read_artifact');
    expect(SUBAGENT_EXTENSION_MODES).toEqual(['isolated', 'ambient']);
  });

  it('admits only domain task ids and inspect tools', () => {
    expect(SUBAGENT_TASK_ID_PATTERN.test('s0123456789abcdef0123456789abcdef')).toBe(true);
    expect(SUBAGENT_TASK_ID_PATTERN.test('d0123456789abcdef0123456789abcdef')).toBe(false);
    expect(SUBAGENT_INSPECT_TOOLS).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'subagent_read_artifact',
    ]);
  });

  it('forbids shell, write, network, background, fusion, and self-recursive tools', () => {
    for (const forbidden of [
      'bash',
      'edit',
      'write',
      'bg_run',
      'bg_delegate',
      'bg_result',
      'bg_kill',
      'bg_status',
      'bg_logs',
      'bg_run_pi_attested',
      'subagent_run',
      'subagent_result',
      'subagent_run_attested',
      'fusion_reason',
      'fusion_investigate',
      'fusion_research',
      'fusion_validate',
    ]) {
      expect(SUBAGENT_FORBIDDEN_TOOLS, forbidden).toContain(forbidden);
      expect(SUBAGENT_INSPECT_TOOLS, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps no removed background-tasks agent surface as an active string', async () => {
    const extensionsDir = join(repoRoot, 'extensions');
    const entries = await readdir(extensionsDir);
    const sourceFiles = entries.filter(
      (name) => (name.endsWith('.ts') || name.endsWith('.json')) && name !== 'removed-surface.ts',
    );
    expect(sourceFiles.length).toBeGreaterThanOrEqual(3);
    for (const name of sourceFiles) {
      const raw = await readFile(join(extensionsDir, name), 'utf8');
      for (const removed of DELEGATE_REMOVED) {
        expect(raw.includes(removed), `${name} must not contain ${removed}`).toBe(false);
      }
    }
  });

  it('confines removed names to the exclusion registry module', async () => {
    const raw = await readFile(join(repoRoot, 'extensions', 'removed-surface.ts'), 'utf8');
    const exported = [...raw.matchAll(/^export const ([A-Z_]+)/gm)].map((match) => match[1]);
    expect(exported).toEqual(['DELEGATE_REMOVED', 'SUBAGENT_FORBIDDEN_TOOLS']);
  });

  it('declares the removed surface it must not regress to', () => {
    expect(DELEGATE_REMOVED).toEqual([
      'bg_delegate',
      'bg_result',
      'bg_run_pi_attested',
      'pi-background-tasks.delegate-seed.v2',
      'pi-background-tasks.delegate-ledger.v1',
      'pi-background-tasks.delegate-result.v1',
      'pi-background-tasks.delegate-receipt.v1',
      'pi-background-tasks.delegate-budget-plan.v3',
      'pi-background-tasks.delegate-manifest.v2',
      'pi-background-tasks.delegate-launch.v1',
      'pi-background-tasks.delegate-result-view.v1',
      'pi-background-tasks.delegate-hook-contract.v1',
      'pi-background-tasks.delegate-outcome.v1',
      'pi-background-tasks.delegate-child-terminal.v1',
      'pi-background-tasks.delegate-runtime-budget.v1',
      'pi-background-tasks.delegate-tool-result-content.v1',
      'PI_BG_DELEGATE_ARTIFACT_DIR',
      'PI_BG_DELEGATE_SEED_PATH',
      'PI_BG_DELEGATE_SEED_SHA256',
      'PI_BG_DELEGATE_TASK_ID',
      'PI_BG_DELEGATE_LAUNCH_NONCE',
      'delegate_read_artifact',
      'phase2.pi_task_attestation.v1',
    ]);
  });
});
