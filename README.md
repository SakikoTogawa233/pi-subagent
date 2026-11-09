# pi-subagent

One background subagent with normal Pi tool access for [Pi](https://github.com/earendil-works/pi):
a frozen conversation seed, a route pinned at launch that is never substituted, a
hash-verified result data plane, and an opt-in attested single-child Pi run mode.

The task registry, footer dock, logs, cancellation, and terminal notifications are
owned by the shared task service; this package is an owner client of it.

## Requirements

- Pi `>= 0.84.2` (peer packages `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`).
- **`@sakiko233/pi-background-tasks` v3 or newer, installed and enabled.** pi-subagent
  cannot run without it.

## Install

```bash
pi install npm:@sakiko233/pi-background-tasks
pi install npm:@sakiko233/pi-subagent
```

Those are the only two Pi packages to install and enable. `pi-agent-runtime` is an ordinary
transitive npm dependency of pi-subagent; do not add it to Pi package settings. Order does not
matter, and the background-service handshake happens at session start.

## Tools

Exactly three tools are registered, and only after a successful startup handshake
with the background-task service.

### `subagent_run`

Launch one background Pi subagent seeded with a frozen projection of the current
conversation, then return a launch receipt immediately.

Children use normal Pi tools, including `bash`, `edit`, and `write`, without a
subagent-specific tool allowlist or denylist. Ambient extensions are loaded by
default, so their tools (including further delegation) are available as usual.
The former `capability: "inspect"` parameter has been removed; omit it in callers.
New runs use seed schema `pi-subagent.seed.v3` without the capability field.
Run limits, context budgeting, and result verification still apply.

Parameters (closed schema):

| key | type | default | notes |
| --- | --- | --- | --- |
| `name` | string | required | 2-6 words, shown in the bg footer dock |
| `prompt` | string | required | authoritative instruction; the projected conversation is background only |
| `route` | `{provider, model}` | current model | pinned at launch, never substituted |
| `extensionMode` | string | `"ambient"` | normal Pi extension discovery; `isolated` disables discovery without restricting built-in tools |
| `maxTurns` | number | 24 | |
| `maxToolCalls` | number | 120 | |
| `timeoutSeconds` | number | 1200 | wall-clock; the child is killed when exceeded |
| `autoDeliver` | string | `"never"` | `never` \| `when_small` \| `always`; appends the verified answer as a final task log frame |
| `notifyOnCompletion` | boolean | true | durable terminal notification |
| `triggerOnCompletion` | boolean | true | the notification starts a follow-up turn |

The receipt carries the subagent task id (`s…`), the service-allocated registry id,
the pinned route, the artifact directory, and the seed hash. Retrieve the answer
with `subagent_result`; do not poll.

### `subagent_result`

Non-blocking, hash-verified retrieval for `subagent_run` tasks only.

| key | type | default | notes |
| --- | --- | --- | --- |
| `taskId` | string | required | subagent task id (`s…`) from the receipt; unambiguous prefixes work |
| `delivery` | string | auto | `inline` returns the verified answer text; `artifact` returns metadata plus the artifact reference |

Behavior:

- running → a typed not-ready view (`state: "running"`, `delivery: "none"`); it never blocks;
- terminal → the committed result package is verified (seed hash, route attestations,
  per-block and aggregate SHA-256, strict UTF-8) before a single byte is returned;
- answers at or under 48 KiB deliver inline; larger answers degrade to an artifact
  reference explicitly and are never truncated;
- `delivery: "inline"` on an oversized answer fails loudly (`result_too_large_for_inline`);
- observed child usage is attached to exactly one retrieval; later retrievals say so.

### `subagent_run_attested`

Opt-in, evidence-oriented direct Pi spawn. Launches exactly one `pi --mode json`
child, records raw Pi events/stderr, hashes prompt/report/output, observes OAuth
through the ModelRegistry, and writes a strict attestation sidecar
(`pi-subagent.pi-task-attestation.v1`) **only after successful completion**.

| key | type | default | notes |
| --- | --- | --- | --- |
| `name` | string | required | |
| `provider` | string | required | `openai-codex` or `anthropic` (subscription OAuth only) |
| `model` | string | required | exact provider-local model id |
| `prompt` | string | required | passed as the single user prompt |
| `reportPath` | string | required | relative, inside the task cwd, never `.git` or `.pi/tasks` |
| `extraPiArgs` | string[] | none | mode/provider/model/api-key/auth-file args are rejected |
| `thinking` | string | none | |
| `timeoutSeconds` | number | none | task is failed and killed when exceeded |

The task cwd must be a clean Git worktree at start and finish; the attestation
refuses a changed or dirty tree. Evidence lives under `.pi/subagent/attested/` and
terminal state is published through the background task service (observe with
`bg_status` / `bg_logs`).

## Failure behavior

- **No service / two services / incompatible service at session start**: a loud
  dependency error (UI notification, console, and a session message) and **none of
  the three tools is registered**.
- **Admission refusals** (unresolvable or under-capacity route, oversized seed,
  unsupported hook contract) create no child and no artifacts.
- **Cancellation** (dock kill, `/kill`, or service shutdown) aborts the child
  process group, acknowledges the cancellation, and settles the task `killed`.
- **Failures settle `failed`** with a bounded, typed error; preserved evidence
  (seed, budget plan, child terminal record, runtime budget) is listed in the
  error and never silently discarded.
- A child that exits 0 without committing a result is `child_exited_without_commit`,
  never a silent empty success.
- Tampered or foreign result packages fail verification (`seed_hash_mismatch`,
  `route_mismatch`, `answer_hash_mismatch`, …); their bytes are never returned.

## Artifacts

Each run writes a durable store under `.pi/subagent/<session>/<taskId>/`:
`seed.json`, `context-omission-ledger.json`, `budget-plan.json`, `child-prompt.txt`,
`manifest.json`, `outcome.json`, spill payloads under `spill/`, and the
child-committed `result.json` (the single answer commit point). All control writes
are temp-write + fsync + rename.

## License

MIT. See `THIRD_PARTY_NOTICES.md` for the extracted upstream ISC notice and the
attribution-implementation ownership split.
