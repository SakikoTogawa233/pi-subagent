/**
 * The removed background-tasks agent surface and the child exclusion list.
 *
 * This is the ONLY module in the package where removed names may appear. Old
 * tool names and schema ids are not compatibility aliases: they are recorded
 * here so the child guard can exclude them explicitly, and so the surface test
 * can assert every other shipped file is free of them.
 */

/**
 * Strings from the removed background-tasks agent surface that must never
 * reappear as an active tool name, schema id, environment variable, or
 * artifact marker anywhere outside this module.
 */
export const DELEGATE_REMOVED = [
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
] as const;

/**
 * Tool names that must never appear in a subagent child, whichever capability
 * is selected in v1. Shell, write, background, Fusion, and self-recursive
 * delegation tools are all excluded by name as a second barrier behind the
 * `--tools` allowlist.
 */
export const SUBAGENT_FORBIDDEN_TOOLS: readonly string[] = [
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
  'fusion_brainstorm',
  'fusion_reason',
  'fusion_investigate',
  'fusion_research',
  'fusion_validate',
];
