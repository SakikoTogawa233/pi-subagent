export { anthropicAttributionExtension as default } from '@sakiko233/pi-agent-runtime/anthropic-attribution';

/**
 * Attribution loader for subagent-owned child Pi runs.
 *
 * The implementation lives entirely in `@sakiko233/pi-agent-runtime`; this file
 * is only the Pi extension entry point that Pi can load inside a child process
 * via `--extension`. It is passed to Anthropic children by `subagent_run` and
 * `subagent_run_attested` and is never registered in the parent session.
 */
