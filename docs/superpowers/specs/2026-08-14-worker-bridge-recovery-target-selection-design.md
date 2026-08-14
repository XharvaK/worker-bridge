# Worker Bridge Recovery and Target-Selection Corrections

**Date:** 2026-08-14
**Status:** Approved by the owner
**Project root:** `C:\Users\Xharv\Projects\worker-bridge`

## Goal

Recover Gemini's interrupted Worker Bridge generalization in place and make the smallest coherent corrections needed for data-driven platform/model selection, quota-aware fallback, recovery handoff, session continuity, bounded evidence capture, and safe test execution.

The existing dirty source state is preserved. The implementation is not restarted from the last clean commit.

## Current recovery evidence

- `HEAD` before correction: `165b55b16bfadc71860edd3f39974965dbefc8ce`.
- The worktree contains Gemini's uncommitted generalization: 17 modified tracked files and 7 untracked source/test files.
- `npm run build` passed before correction.
- The prior `npm test` attempt exposed a multi-round test timeout and then entered a real OpenCode smoke test without a normal-suite gate. That process was stopped to avoid an unbounded provider call.
- Missing evidence MUST remain unknown. No Gemini transcript details are invented.
- Every invalid `Gemini Flash 3.5` reference MUST resolve to the Antigravity `Gemini Flash 3.7 High` target. Valid OpenCode `Nemotron 3.5 Lightning` references are unchanged.

## Roles and selection model

The bridge has four model-selection roles:

1. `PLANNER`: plans, designs, and planning-oriented analysis.
2. `INVESTIGATOR`: reproduces, traces, inspects, gathers evidence, identifies root cause, and reports confidence. It is normally `READ_ONLY` and MUST NOT become an automatic fix.
3. `WORKER`: performs approved source-writing execution for `implement`, `fix`, and explicit recovery rounds.
4. `REVIEWER`: challenges assumptions, reviews plans/diffs, searches for mocked-away properties and authority/evidence errors, and attempts to falsify producer claims.

Deterministic build, test, diff, and repository checks remain bridge-owned verification. They are not an LLM role.

The selector operates on explicit `WorkerTarget` records, never on abstract model families:

```ts
interface WorkerTarget {
  targetId: string;
  platformId: string;
  modelId: string;
  reasoning: {
    strategy: 'highest-supported' | 'explicit';
    value?: string;
  };
  explicitOnly?: boolean;
}
```

The discovered platform catalog answers which models a CLI exposes. Local policy answers which exact platform/model combinations the owner authorizes automatically. Discovery MUST NOT add a target to policy.

## Policy data

Role rankings live in local policy/configuration data. Selector code contains only generic resolution, validation, availability, cooldown, fallback, and capability logic. It MUST NOT contain fixed planner, investigator, worker, or reviewer priority arrays.

The current policy references these role orderings:

| Role | Ordered target references |
| --- | --- |
| `PLANNER` | Cursor/Grok 4.6 XHigh (future reference), Antigravity/Gemini Flash 3.7 High, OpenCode/DeepSeek V4 Flash Max, OpenCode/HY3 High, OpenCode/Laguna S 2.1 High, OpenCode/Nemotron 3 Ultra, OpenCode/Nemotron 3.5 Lightning |
| `INVESTIGATOR` | Cursor/Grok 4.6 XHigh (future reference), OpenCode/Nemotron 3.5 Lightning, Antigravity/Gemini Flash 3.7 High, OpenCode/DeepSeek V4 Flash Max, OpenCode/HY3 High, OpenCode/Laguna S 2.1 High, OpenCode/Nemotron 3 Ultra |
| `WORKER` | Antigravity/Gemini Flash 3.7 High, Cursor/Grok 4.6 Medium (future reference), OpenCode/Nemotron 3.5 Lightning, OpenCode/DeepSeek V4 Flash Max, OpenCode/HY3 High, OpenCode/Laguna S 2.1 High, OpenCode/Nemotron 3 Ultra |
| `REVIEWER` | OpenCode/Nemotron 3.5 Lightning, Antigravity/Gemini Flash 3.7 High, Cursor/Grok 4.6 XHigh (future reference), OpenCode/HY3 High, OpenCode/DeepSeek V4 Flash Max, OpenCode/Nemotron 3 Ultra, OpenCode/Laguna S 2.1 High |

Cursor references remain opaque policy identifiers until a `CursorAdapter`, Cursor discovery, and an exact discovered model ID are available. No Cursor executable or model identifier is invented or implemented in this correction.

Current platform bindings are owner policy:

- Automatic Gemini use is Antigravity-only.
- OpenCode automatic targets are the configured free OpenCode catalog models.
- Antigravity Claude Opus is `EXPLICIT_ONLY` and is excluded from all automatic ranking and fallback.

An explicit valid target wins. It MUST NOT be silently rerouted to another platform/model unless the owner explicitly enables fallback.

Reviewer diversification is a policy behavior. When a reviewer request is automatic and another eligible configured target exists, the selector prefers a target different from the producer target. An explicit reviewer target overrides diversification.

## Availability, quota, and retry policy

Persistent operational availability is keyed by `targetId`, not by abstract model name. The ledger stores the target state, failure class, observation time, authoritative retry time when supplied, and bounded raw provider evidence. Supported states include `AVAILABLE`, `LOW`, `EXHAUSTED`, `COOLDOWN`, `ELIGIBLE_TO_RETRY`, `UNKNOWN`, and `ERROR`.

Only provider-authoritative retry information is stored:

- `retry-after` seconds are converted from the observation time.
- Provider reset timestamps are stored directly.
- Text such as “try again in N seconds” is accepted only through tested provider-pattern parsing.
- No retry time is estimated from prior usage.

Before `retryAt`, a target is ineligible for automatic fresh selection. When `now >= retryAt`, the target becomes `ELIGIBLE_TO_RETRY` or `UNKNOWN`; the bridge MUST NOT claim that quota is restored. The next fresh automatic selection starts at the top of the role policy again.

`CONTINUE` requests preserve the current compatible target. A higher-priority target recovering from cooldown MUST NOT silently replace an active continued session.

## Recovery Capsule

Every interrupted round with useful evidence produces a bounded Recovery Capsule associated with the round. The capsule is bridge-constructed from continuously captured evidence and does not depend on a final model-generated summary.

The capsule contains:

- authoritative contract: job ID, round, revision, role, goal, accepted plan, Sol review/corrections, owner approval, base SHA, and execution constraints;
- source worker: platform, exact model, reasoning profile, native session/conversation ID, request prompt, timestamps, failure class, and authoritative `retryAt`;
- captured history: bounded stdout/stderr/events, partial response, tool/event counts, platform-exported sanitized context where available, and the last observed meaningful action;
- authoritative current state: worktree, branch, base SHA, current HEAD, Git status, diff/diff stat, changed files, bridge build/test results, and incomplete or unknown operations;
- recovery directive: proven complete work, incomplete work, known failures, remaining work, prohibited blind repeats, and an instruction to continue the existing state rather than start over.

The artifact is persisted as bounded JSON under the job's round mailbox directory. Secrets are sanitized before persistence.

## Effect-aware fallback and recovery

For `READ_ONLY` quota failure, the bridge captures the capsule and MAY run bounded automatic fallback when authorized.

For `WORKTREE_WRITE` quota failure with no source changes, the bridge captures the capsule and MAY run bounded automatic fallback when authorized.

For `WORKTREE_WRITE` quota failure after source changes, the bridge MUST:

1. stop automatic fallback;
2. preserve the existing worktree and branch;
3. re-observe `git status`, `git diff`, `git diff --check`, and configured build/tests where safe;
4. persist the Recovery Capsule;
5. publish an explicit `INTERRUPTED_WITH_SOURCE_STATE` or equivalent bounded state; and
6. wait for an explicit recovery round before another worker edits that worktree.

A recovery round uses the `WORKER` policy, excludes targets in cooldown, and receives the Recovery Capsule, the preserved worktree, and the original approved contract. Its prompt MUST say to continue the existing implementation, verify state before editing, avoid repeating proven work, resolve remaining failures, and run required verification.

Cross-platform recovery always starts a fresh destination-platform session with the capsule. Same-platform cross-model continuation is allowed only when the adapter explicitly proves `supportsCrossModelSessionContinuation`. Native continuation is otherwise restricted to a compatible existing target. OpenCode session export/continuation and Antigravity conversation IDs are retained when available, but portable cross-platform transcript translation is not required.

## Continuous capture

The process layer captures bounded stdout/stderr incrementally. Adapters retain partial response text, event/tool summaries, session identifiers, and last meaningful action as data arrives. Abnormal exit, quota failure, timeout, cancellation, and bridge interruption all retain the captured evidence needed to build a capsule.

## Test boundary

Normal `npm test` runs only mock/unit/integration tests. Real Antigravity/OpenCode/Cursor calls are explicitly opt-in and MUST NOT run from the default test script. Real smoke remains separately reportable and is not required for this recovery unless explicitly authorized.

Focused tests cover policy loading, role rankings, target/platform binding, reviewer diversification, explicit override, cooldown/retry-after persistence, fresh priority recovery, continuation rules, cross-platform handoff, capability-gated native continuation, effect-aware fallback, capsule contents, incremental capture, secret sanitization, interrupted worktree preservation, and the absence of real provider calls from normal `npm test`.

## Non-goals

- Implementing Cursor CLI support or inventing Cursor/Grok CLI model IDs.
- Treating a discovered model as automatically authorized.
- Treating the model or worker platform as semantic authority.
- Automatically restarting a source-writing worker after source effects exist.
- Claiming quota restoration solely because a cooldown timer expired.
- Consuming Antigravity quota during recovery.
- Deploying or modifying Project Ashley.

## Verification and handoff

The final verification sequence is:

```text
npm run build
npm test
git diff --check
```

The final report includes exact build/test results and counts, the recovered Gemini state, policy/config locations, target bindings, cooldown and capsule behavior, exact changed files, final commit SHA if committed, and any explicitly opt-in real smoke remaining.
