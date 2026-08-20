import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateSubagentHookContract,
  loadSubagentHookContractEvidence,
  parseSubagentHookContractEvidence,
  SUBAGENT_HOOK_CONTRACT_ID,
  SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION,
  SUBAGENT_HOOK_GUARANTEE_NAMES,
  type SubagentHookContractEvidence,
} from '../extensions/hook-contract.js';

const EVIDENCE_PATH = fileURLToPath(
  new URL('../extensions/hook-contract-evidence.json', import.meta.url),
);

describe('shipped hook-contract evidence', () => {
  it('parses and satisfies every required guarantee', async () => {
    const evidence = loadSubagentHookContractEvidence(await readFile(EVIDENCE_PATH, 'utf8'));
    expect(evidence.schema_version).toBe(SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION);
    expect(evidence.contract_id).toBe(SUBAGENT_HOOK_CONTRACT_ID);
    const verdict = evaluateSubagentHookContract(evidence);
    expect(verdict.supported).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it('declares every observed guarantee name', () => {
    expect(SUBAGENT_HOOK_GUARANTEE_NAMES.length).toBe(12);
    expect(SUBAGENT_HOOK_GUARANTEE_NAMES).toContain('context_abort_blocks_provider_call');
    expect(SUBAGENT_HOOK_GUARANTEE_NAMES).toContain('tool_result_replacement_reaches_provider');
  });

  it('refuses evidence that is malformed, mismatched, or incomplete', () => {
    expect(() => parseSubagentHookContractEvidence('not-an-object')).toThrow();
    expect(() => parseSubagentHookContractEvidence(null)).toThrow();
    expect(() => parseSubagentHookContractEvidence({})).toThrow();
    expect(() =>
      parseSubagentHookContractEvidence({
        schema_version: 'pi-background-tasks.delegate-hook-contract.v1',
        contract_id: SUBAGENT_HOOK_CONTRACT_ID,
        guarantees: {},
      }),
    ).toThrow(/schema_version/);
    expect(() =>
      parseSubagentHookContractEvidence({
        schema_version: SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION,
        contract_id: 'wrong-contract',
        guarantees: {},
      }),
    ).toThrow(/contract_id/);
    const allTrue = Object.fromEntries(
      SUBAGENT_HOOK_GUARANTEE_NAMES.map((name) => [name, true]),
    ) as Record<string, boolean>;
    expect(() =>
      parseSubagentHookContractEvidence({
        schema_version: SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION,
        contract_id: SUBAGENT_HOOK_CONTRACT_ID,
        guarantees: allTrue,
      }),
    ).not.toThrow();
    const missingOne = { ...allTrue };
    delete missingOne['context_abort_terminates_run'];
    expect(() =>
      parseSubagentHookContractEvidence({
        schema_version: SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION,
        contract_id: SUBAGENT_HOOK_CONTRACT_ID,
        guarantees: missingOne,
      }),
    ).toThrow(/keys mismatch/);
  });

  it('reports missing required guarantees instead of defaulting to allow', () => {
    const guarantees = Object.fromEntries(
      SUBAGENT_HOOK_GUARANTEE_NAMES.map((name) => [name, true]),
    ) as Record<string, boolean>;
    guarantees['tool_result_replacement_preserves_identity'] = false;
    const evidence: SubagentHookContractEvidence = {
      schema_version: SUBAGENT_HOOK_CONTRACT_SCHEMA_VERSION,
      contract_id: SUBAGENT_HOOK_CONTRACT_ID,
      guarantees: guarantees as SubagentHookContractEvidence['guarantees'],
    };
    const verdict = evaluateSubagentHookContract(evidence);
    expect(verdict.supported).toBe(false);
    expect(verdict.missing).toEqual(['tool_result_replacement_preserves_identity']);
  });
});
