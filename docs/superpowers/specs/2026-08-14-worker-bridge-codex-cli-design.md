# Worker Bridge Codex CLI Explicit-Only Target

**Date:** 2026-08-14
**Status:** Approved by the owner
**Project root:** `C:\Users\Xharv\Projects\worker-bridge`
**Initial implementation baseline:** `b0c79a69def5d47c40b3162d18d0e28776265efa`

## Goal

Add OpenAI Codex CLI as a first-class Worker Bridge platform while preserving the current role-based policy, automatic target rankings, owner-approval law, effect-aware recovery law, and generic adapter/orchestration boundaries.

Codex is an explicit-only worker target. Doc must explicitly select the Codex platform and an exact Codex model/target. Codex MUST NOT enter automatic role selection, automatic fallback, cooldown reranking, reviewer diversification, or fresh automatic selection.

The implementation is fixture-only. It MUST NOT run a real Codex inference or consume Codex quota.

## Locked invariants

The existing automatic role policy remains unchanged. Codex is absent from every automatic ranking:

| Role | Existing automatic order |
| --- | --- |
| `PLANNER` | Cursor/Grok XHigh, AGY/Gemini Flash 3.7 High, OpenCode/DeepSeek V4 Flash Max, HY3 High, Laguna S 2.1 High, Nemotron 3 Ultra, Nemotron 3.5 Lightning |
| `INVESTIGATOR` | Cursor/Grok XHigh, OpenCode/Nemotron 3.5 Lightning, AGY/Gemini Flash 3.7 High, DeepSeek, HY3, Laguna, Nemotron 3 Ultra |
| `WORKER` | AGY/Gemini Flash 3.7 High, Cursor/Grok Medium, OpenCode/Nemotron 3.5 Lightning, DeepSeek, HY3, Laguna, Nemotron 3 Ultra |
| `REVIEWER` | OpenCode/Nemotron 3.5 Lightning, AGY/Gemini Flash 3.7 High, Cursor/Grok XHigh, HY3, DeepSeek, Nemotron 3 Ultra, Laguna |

Automatic selection MUST skip Codex even when the Codex executable is installed, its catalog is available, a model is catalog-valid, or a prior Codex round succeeded. Automatic reviewer diversification MUST NOT choose Codex.

An explicit Codex target overrides automatic rankings and reviewer diversification, including an explicit Codex reviewer selected after a producer from the same producer/platform.

`PLANNER`, `INVESTIGATOR`, `WORKER`, `REVIEWER`, and `RECOVERY` remain generic workflow concepts. `RECOVERY` remains a workflow mode, not an automatic ranking role.

The implementation MUST NOT change job-state fundamentals, semantic authority, owner approval requirements, automatic rankings, or source-effect recovery law. A missing generic abstraction MUST be added generically rather than through a Codex-specific orchestration branch.

## Verified local Codex CLI evidence

The installed Windows App execution alias was inspected but was not runnable from the current shell:

```text
C:\Program Files\WindowsApps\OpenAI.Codex_26.810.4967.0_x64__2p2nqsd0c76g0\app\resources\codex.exe
```

Attempts to run its version/help commands returned `Access is denied`. The package manifest entry point is `ChatGPT.exe`, not a usable standalone CLI entry point.

The runnable per-user standalone CLI is:

```text
C:\Users\Xharv\.codex\packages\standalone\releases\0.147.0-x86_64-pc-windows-msvc\bin\codex.exe
```

Verified output:

```text
codex-cli 0.147.0
```

The installed help evidence establishes these capabilities:

- `codex exec` runs non-interactively.
- `codex exec resume <session-id>` resumes by an exact session ID or thread name.
- `-m` / `--model` selects the model.
- `-C` / `--cd` selects the working directory.
- `--add-dir` adds an additional directory.
- `-s` / `--sandbox` accepts `read-only`, `workspace-write`, or `danger-full-access`.
- `-a` / `--ask-for-approval` accepts `untrusted`, `on-request`, or `never`.
- `--json` emits JSONL event output.
- `--output-schema` and `--output-last-message` are available for structured/result capture.
- `--ephemeral` is available for non-persistent operation.
- A prompt may be supplied as an argument or through stdin using `-`.
- `codex debug models --bundled` renders the bundled model catalog as JSON.

The local bundled catalog was read without running inference. It contained model metadata for `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`, and `codex-auto-review`. Supported native reasoning values varied by model. The implementation MUST discover this data at runtime and MUST NOT encode this current catalog as permanent policy.

The local Codex configuration also provided the native reasoning key:

```text
model_reasoning_effort = "max"
```

The adapter will use the observed native configuration mechanism, `-c model_reasoning_effort="<value>"`, and will test the exact argument construction with fixtures. It MUST NOT invent a universal reasoning flag or silently substitute a different profile.

## Policy and target binding

The policy adds a Codex platform capability and an explicit-only target binding. The target is declared with the equivalent of:

```json
{
  "targetId": "codex_explicit",
  "platformId": "codex",
  "displayName": "OpenAI Codex CLI (explicit model)",
  "aliases": ["codex", "openai_codex"],
  "modelBinding": "EXPLICIT_DISCOVERED",
  "reasoning": { "strategy": "HIGHEST_SUPPORTED" },
  "explicitOnly": true
}
```

`EXPLICIT_DISCOVERED` means that policy authorizes the Codex platform capability but does not hardcode a current model ID. The explicit request supplies the model ID. The selector resolves the requested model against the current machine-readable catalog and preserves the exact resolved model ID. Discovery never adds a model to automatic policy.

The generic target contract therefore supports a target without a fixed `modelId` when its `modelBinding` requires an explicit discovered model. Fixed targets continue to require exact policy `modelId` values. Alias resolution remains policy-defined and exact; model-family fuzzy matching is prohibited.

An explicit Codex request MUST identify Codex through the policy target, platform, or Codex alias and MUST provide a model. An explicit model that is not present in the discovered catalog fails closed with `MODEL_NOT_FOUND`. If the catalog cannot be obtained or parsed, the request fails closed with `MODEL_DISCOVERY_UNAVAILABLE`. No alternate model is selected.

The selector remains generic. It resolves explicit targets through the same target-resolution path as every other platform. Codex-specific behavior belongs in the adapter, catalog parser, and policy binding.

## Model discovery and runtime availability

Codex model discovery has two separate meanings:

1. `codex debug models --bundled` establishes installed CLI catalog metadata.
2. Invocation evidence establishes whether the current account/configuration can run the selected model now.

Catalog membership MUST NOT be treated as authentication, access, quota, or current runtime availability.

The platform state model keeps these facts distinct:

- catalog-valid / discovered;
- configured and authenticated;
- currently runnable;
- quota available;
- temporarily unavailable;
- unknown.

The adapter may report catalog-valid explicit targets while runtime availability remains `UNKNOWN`. It MUST NOT fabricate access or quota state. Authoritative Codex errors are normalized through the existing operational failure taxonomy and target-keyed availability/cooldown ledger. Bounded sanitized stdout/stderr and structured event evidence are retained with the failure.

The adapter discovery path MUST resolve the configured executable first. When the default executable is used, it may locate and verify a runnable per-user standalone release. It MUST NOT silently replace an explicitly configured executable with another binary. The inaccessible Windows App path is not a valid fallback executable.

## Reasoning resolution

Codex is explicit-only at the platform/model target level. Explicit reasoning is optional.

When Doc selects Codex and an exact model but omits reasoning, the adapter resolves the highest native reasoning level supported by that selected model. “Highest” is derived from discovered model metadata, not from a hardcoded universal ordering or a fabricated value. The native model representation is preserved in the invocation.

When Doc explicitly selects a reasoning level, the adapter validates it against the selected model’s discovered supported values and uses that exact native value. Unknown or unsupported explicit reasoning fails closed with `REASONING_PROFILE_UNSUPPORTED`.

The adapter MUST NOT downgrade, upgrade, or substitute a reasoning profile to make a request runnable. An explicit model remains valid independently from runtime access; runtime failure is reported separately through availability/failure normalization.

## Invocation and authority restrictions

`CodexAdapter` invokes the noninteractive `codex exec` command through the existing safe process layer. The prompt is passed through stdin using the documented `-` form so Recovery Capsules and bounded prompts do not depend on Windows command-line length limits.

Invocation requirements:

- bind `--cd` to the isolated Worker Bridge worktree;
- use `--sandbox read-only` for `READ_ONLY`;
- use `--sandbox workspace-write` for `WORKTREE_WRITE`;
- use `--ask-for-approval never` so the bridge remains the approval boundary;
- use `--model` with the exact resolved model ID;
- use native `model_reasoning_effort` configuration when a resolved profile exists;
- use `--json` and capture bounded JSONL evidence;
- retain the last-message/structured output when available;
- never use `danger-full-access`, dangerous bypass flags, merge, deploy, push, or main/master mutation paths.

The generic process manager remains responsible for `shell: false`, safe Windows `.cmd`/`.bat` invocation, timeout, cancellation, bounded stdout/stderr, and incremental capture. CodexAdapter supplies only platform-specific arguments and parsing.

## Session and continuation behavior

An initial invocation captures the exact Codex session identifier from unambiguous machine-readable JSONL evidence when the CLI provides it. The adapter MUST retain the platform, logical model, exact resolved model ID, native reasoning profile, session ID, worktree, and authority mode in the round result and Recovery Capsule.

`codex exec resume <session-id>` is used only when the exact session ID is present and all continuation identity fields match. A `CONTINUE` round MUST remain bound to:

- platform `codex`;
- the exact Codex session ID;
- the logical model selected for the session;
- the exact resolved model ID;
- the native reasoning profile;
- the approved `READ_ONLY` or `WORKTREE_WRITE` authority mode;
- the existing worktree/session context required by the bridge.

If Doc requests another model or a materially different reasoning profile, the round is `FRESH`, not `CONTINUE`. If the session ID cannot be recovered unambiguously, `CONTINUE` fails closed and the bridge uses a fresh/recovery path. The adapter MUST NOT infer a session ID from prose, use `resume --last`, or silently migrate a session to another model.

Because the observed `exec resume --help` output does not expose the same working-directory and sandbox flags as initial `exec`, the implementation will claim continuation only when the stored session context proves the required authority and worktree binding. Otherwise it reports that exact continuation is unsupported and requires a fresh/recovery round with the capsule.

## Explicit fallbackSelection and source-effect recovery

The generic worker selection contract may carry a bounded, nonrecursive `fallbackSelection` authorization. It identifies a specific fallback target/platform/model and optional reasoning profile for the current round. For Codex, this authorization MUST include the explicit Codex platform and exact model. It does not add Codex to automatic rankings.

`fallbackSelection` is still subject to normal fallback limits, exact model resolution, availability evidence, execution mode, and source-effect recovery law:

- `READ_ONLY`: an explicitly authorized Codex fallback MAY be attempted under the existing bounded fallback rules.
- `WORKTREE_WRITE` with no source effects: an explicitly authorized Codex fallback MAY be attempted under the existing bounded fallback rules.
- `WORKTREE_WRITE` after source effects: the bridge MUST NOT automatically start Codex or any other worker. It preserves the worktree, branch, diff, logs, session/result evidence, and Recovery Capsule; performs bridge-owned status/verification capture; publishes interrupted-with-source-state; and requires explicit recovery/handoff authorization before another worker continues.

An authorized fallback target is not authorization to overwrite an interrupted source state. No Codex-specific branch may bypass the generic effect-aware boundary.

## Recovery Capsule integration

The existing platform-neutral Recovery Capsule is extended only through generic fields required to carry Codex evidence. It includes:

- job, round, role, goal, approved contract, base SHA, and execution mode;
- source platform, target ID, logical model, exact model ID, native reasoning, and exact session ID;
- request prompt, bounded stdout/stderr, partial response, JSONL event/tool summaries, last meaningful action, and structured output where available;
- failure class, authoritative retry time, and bounded sanitized source evidence;
- worktree, branch, current HEAD, Git status, diff/diff stat, diff check, changed files, and unknown operations;
- recovery directive describing proven completion, incomplete work, prohibited blind repeats, and the explicit need to continue the existing state rather than start over.

The capsule is bridge-constructed and persisted as bounded JSON. It does not rely on a model-generated summary and does not grant semantic authority to Codex.

## Generic extensibility check

The implementation is complete only if a future Cursor addition would require approximately:

- `CursorAdapter`;
- Cursor executable/model discovery;
- target and alias configuration;
- policy update;
- focused adapter/selector tests.

It MUST NOT require changes to generic orchestration meaning, owner approval, automatic fallback law, source-effect recovery law, or session identity semantics.

## Focused verification

Tests use fixtures and mocks only. They cover:

- unchanged automatic role rankings with Codex absent;
- no Codex from automatic selection, automatic fallback, cooldown reranking, or reviewer diversification;
- explicit Codex target/platform/model resolution;
- dynamic catalog parsing and exact model membership;
- catalog-valid versus runtime-unknown availability;
- highest-supported native reasoning by default;
- exact explicit reasoning acceptance and closed failure for unsupported values;
- exact `exec` and `exec resume` argument construction;
- unambiguous session-ID capture and closed failure for unsafe continuation;
- explicit same-producer Codex reviewer override;
- bounded `fallbackSelection` behavior;
- source-effect interruption law and Recovery Capsule fields;
- normalized quota/rate-limit failures and authoritative retry evidence;
- normal `npm test` making no real Codex/provider calls.

The real Codex smoke path remains separate and is not run in this task.

## Verification and handoff

The implementation will run:

```text
npm run build
npm test
git diff --check
```

The final report will include the exact initial SHA, discovered executable/version/capabilities, changed files, automatic-selection proof, explicit flow, discovery/reasoning/session behavior, fallback and source-effect interaction, availability/quota behavior, exact test/build counts, commit SHAs, clean worktree state, and the remaining limitation that no real Codex inference was run.

No push, merge, deploy, startup registration, or Project Ashley modification is authorized.
