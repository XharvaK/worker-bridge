# Worker Bridge Recovery and Target-Selection Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover Gemini's interrupted Worker Bridge generalization in place and add generic, policy-driven target selection with persistent quota state, bounded recovery capsules, effect-aware fallback, capability-gated session continuation, and an opt-in-only real smoke suite.

**Architecture:** Keep `WorkJob`, mailbox flow, owner approval, worktree isolation, and the orchestrator as generic workflow mechanisms. Move all target identities and role rankings into a policy document. Add a target availability ledger beside the job ledger, a bridge-built Recovery Capsule artifact, and adapter/process evidence fields so fallback and recovery decisions are based on observed effects rather than model claims.

**Tech Stack:** TypeScript 5.7, Node.js ESM, Vitest 3, Git worktrees, JSON policy/configuration, Windows CLI adapters.

## Global Constraints

- Preserve Gemini's existing dirty source state; do not reset, discard, or regenerate it.
- Legacy incorrect Gemini Flash input resolves to Antigravity `Gemini Flash 3.7 High`; OpenCode `Nemotron 3.5 Lightning` remains valid.
- `WORKTREE_WRITE` requires explicit owner approval, including recovery rounds.
- Automatic Gemini use is Antigravity-only; automatic OpenCode targets are the configured free OpenCode catalog.
- Antigravity Claude Opus is `EXPLICIT_ONLY` and never enters automatic ranking or fallback.
- Cursor policy references remain unresolved future target references; do not invent a Cursor executable or model ID.
- Discovery and target authorization remain separate.
- `CONTINUE` preserves the current compatible target; fresh automatic rounds re-run the role ranking from the top.
- Cross-platform recovery is always a fresh destination session plus a Recovery Capsule.
- Automatic fallback stops after source effects exist in a source-writing worktree.
- Normal `npm test` MUST perform no real provider model calls; real smoke is opt-in.
- Do not modify Project Ashley, deploy, register startup, push, or discard unrelated work.

## Files and responsibilities

- Modify `src/types.ts` for roles, target records, availability records, recovery capsule fields, session capabilities, and interruption states.
- Modify `src/config.ts` and `config.example.json` for policy loading, target/platform validation, and current role rankings.
- Create `src/policy/default-selection-policy.json` as the fallback policy data document. It contains current Antigravity/OpenCode targets and opaque future Cursor ranking references only.
- Create `src/engine/job-role.ts` for generic intent-to-role mapping.
- Create `src/engine/target-availability-ledger.ts` for persistent per-target state and cooldown transitions.
- Modify `src/engine/model-selector.ts` so it resolves only policy target IDs and contains no role priority arrays or model-family fuzzy matching.
- Modify `src/worker/worker-adapter.ts`, `src/worker/agy-adapter.ts`, and `src/worker/opencode-adapter.ts` for capability declarations, failure analysis, retry-after parsing, and bounded evidence.
- Modify `src/engine/process-manager.ts` for incremental bounded stdout/stderr capture.
- Create `src/engine/recovery-capsule.ts` for bridge-owned capsule construction, worktree observation, and bounded serialization.
- Modify `src/worker/plan-worker.ts` and `src/worker/implement-worker.ts` for capsule-aware prompts, source-effect detection, and preservation of interrupted implementation worktrees.
- Modify `src/engine/ledger.ts`, `src/engine/orchestrator.ts`, `src/mailbox/parser.ts`, and `src/mailbox/syncer.ts` for recovery rounds, target identity, capsule persistence, status publication, fallback, and continuation rules.
- Modify `package.json` and `test/integration/real-smoke.test.ts` so real smoke is explicit opt-in.
- Modify affected tests and create `test/fixtures/mock-opencode.js` plus `test/fixtures/mock-opencode.cmd` so normal tests do not invoke a real OpenCode CLI.
- Modify `README.md` and Antigravity fallback discovery data to remove invalid legacy Gemini Flash references without changing valid Nemotron 3.5 references.

### Task 1: Add policy-backed role and target contracts

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Create: `src/policy/default-selection-policy.json`
- Modify: `config.example.json`
- Create: `src/engine/job-role.ts`
- Test: `test/unit/config.test.ts`
- Test: `test/unit/schema.test.ts`

**Interfaces:**
- `WorkerRole = 'PLANNER' | 'INVESTIGATOR' | 'WORKER' | 'REVIEWER'`.
- `WorkerTargetConfig` contains `targetId`, `platformId`, `modelId`, `displayName`, `aliases`, `reasoning`, and `explicitOnly`.
- `SelectionPolicyConfig` contains `targets`, `roleRankings`, `allowFallbackByDefault`, `maxFallbackAttempts`, and `reviewerPreferDifferentTarget`.
- `roleForJob(intent, explicitRole?)` maps `plan/design` to `PLANNER`, `investigate` to `INVESTIGATOR`, `implement/fix` to `WORKER`, and `review/audit` to `REVIEWER`.

- [ ] **Step 1: Write failing policy/config tests.** Assert that a config with an explicit policy returns all four role rankings from configuration, that the planner ranking begins with `cursor_grok_46_xhigh` and then `agy_gemini_flash_37_high`, and that no legacy incorrect Gemini Flash target exists. Assert that `roleForJob` maps all seven intents correctly.
- [ ] **Step 2: Run the focused tests and verify the expected failure.**

Run: `npx vitest run test/unit/config.test.ts test/unit/schema.test.ts`

Expected: FAIL because the role/target policy fields and role mapper do not yet exist.
- [ ] **Step 3: Add the policy data and type contracts.** Put the current target records in `src/policy/default-selection-policy.json`. Include `agy_gemini_flash_37_high`, the five OpenCode free targets, and explicit-only `agy_claude_opus_46_thinking`. Put Cursor IDs only in role ranking arrays with no target record or invented model ID. Add policy merging in `validateConfig` so legacy configs receive the default policy data while explicit policy data remains authoritative.
- [ ] **Step 4: Implement `roleForJob` and parser fields.** Add optional `role`, `producerTargetId`, `recovery`, and `workerSelection.targetId` fields without breaking schema v1 compatibility. Reject invalid role values and preserve the existing owner approval checks.
- [ ] **Step 5: Run the focused tests and verify they pass.**

Run: `npx vitest run test/unit/config.test.ts test/unit/schema.test.ts`

Expected: PASS with the policy loaded from data and no invalid legacy Gemini Flash target.

### Task 2: Replace hardcoded selection with generic target resolution and availability persistence

**Files:**
- Create: `src/engine/target-availability-ledger.ts`
- Modify: `src/engine/model-selector.ts`
- Modify: `src/worker/worker-adapter.ts`
- Modify: `src/engine/orchestrator.ts`
- Test: `test/unit/model-selector.test.ts`
- Create: `test/unit/target-availability-ledger.test.ts`

**Interfaces:**
- `TargetAvailabilityLedger.get(targetId, now?)` returns the persisted target record and transitions expired `COOLDOWN` to `ELIGIBLE_TO_RETRY` without claiming restoration.
- `TargetAvailabilityLedger.recordFailure(target, failureClass, observedAt, retryAt?, rawEvidence?)` persists target-keyed failure state.
- `TargetAvailabilityLedger.recordSuccess(targetId)` marks the exact target `AVAILABLE`.
- `ModelSelector.resolveSelection(requested, role, excludedTargetIds, avoidTargetId?)` returns `ResolvedWorkerSelection` with `targetId`, exact platform, exact model, and resolved native reasoning profile.
- `WorkerAdapter.supportsCrossModelSessionContinuation?: boolean` is false unless a platform-specific test proves it.

- [ ] **Step 1: Write failing selector and availability tests.** Cover configuration-defined ordering for all roles, missing future Cursor targets being skipped, exact Antigravity Gemini binding, explicit Opus selection, explicit target overriding reviewer avoidance, reviewer diversification, and target-keyed cooldown skip/expiry.
- [ ] **Step 2: Run the focused tests and verify they fail for the missing behavior.**

Run: `npx vitest run test/unit/model-selector.test.ts test/unit/target-availability-ledger.test.ts`

Expected: FAIL because the selector still uses `CANONICAL_ALIASES` and fixed ranking arrays and no availability ledger exists.
- [ ] **Step 3: Implement the persistent target availability ledger.** Use an atomic JSON write under `~/.worker-bridge/target-availability.json`, bound raw evidence before persistence, retain `retryAt` exactly when supplied, and expose `UNKNOWN`/`ELIGIBLE_TO_RETRY` after expiry.
- [ ] **Step 4: Rewrite `ModelSelector` around policy target IDs.** Remove hardcoded role ranking arrays and fuzzy family matching. Resolve display aliases only from policy data. Require platform/model discovery for automatic targets, honor `platforms[platformId].enabled`, skip explicit-only targets automatically, consult the availability ledger, and resolve highest native reasoning through the selected adapter.
- [ ] **Step 5: Add reviewer diversification and explicit override.** For automatic reviewer selection, first scan eligible targets excluding `avoidTargetId`; if none remain, allow the avoided target. Explicit `targetId`/platform/model requests bypass this preference but still validate the exact configured binding.
- [ ] **Step 6: Run focused selector/ledger tests and verify they pass.**

Run: `npx vitest run test/unit/model-selector.test.ts test/unit/target-availability-ledger.test.ts`

Expected: PASS with all role orderings sourced from policy data.

### Task 3: Add authoritative failure classification, retry-after extraction, and bounded process evidence

**Files:**
- Modify: `src/types.ts`
- Modify: `src/worker/worker-adapter.ts`
- Modify: `src/engine/process-manager.ts`
- Modify: `src/worker/agy-adapter.ts`
- Modify: `src/worker/opencode-adapter.ts`
- Test: `test/unit/worker-adapter.test.ts`
- Test: `test/unit/process-manager.test.ts`
- Modify: `test/unit/agy-adapter.test.ts`
- Modify: `test/unit/opencode-adapter.test.ts`

**Interfaces:**
- `analyzeOperationalError(exitCode, stdout, stderr, timedOut, observedAt)` returns `failureClass`, optional authoritative `retryAt`, and bounded sanitized `rawEvidence`.
- `WorkerEvidence` contains bounded stdout/stderr/partial response, truncation flags, event/tool counts, session ID, and last meaningful action.
- `ProcessRunResult` includes bounded output and truncation metadata.
- `WorkerRoundResult` carries `requestPrompt`, `evidence`, `retryAt`, and `rawFailureEvidence`.

- [ ] **Step 1: Write failing tests for classification and bounded capture.** Test quota/rate-limit strings, `retry-after: 812`, ISO reset timestamps, “try again in N seconds”, no invented timer when absent, secret redaction, and preservation of first/last bounded output chunks.
- [ ] **Step 2: Run the focused tests and verify the expected failures.**

Run: `npx vitest run test/unit/worker-adapter.test.ts test/unit/process-manager.test.ts`

Expected: FAIL because classification returns only a class and process results are unbounded.
- [ ] **Step 3: Implement analysis and bounded capture.** Keep `classifyOperationalError` as a compatibility wrapper, add the richer analysis function, parse only authoritative timer forms, sanitize evidence, and cap process output while retaining useful beginning/end context.
- [ ] **Step 4: Wire both adapters to return evidence.** Preserve platform/session IDs when emitted, parse OpenCode JSON events into tool counts/last action, capture Antigravity output and artifact references, and expose `supportsCrossModelSessionContinuation` as false until demonstrated.
- [ ] **Step 5: Replace normal adapter tests’ real CLI calls with disposable fixtures.** Add mock OpenCode version/catalog behavior and use it for discovery tests; keep provider execution tests in the gated real-smoke file.
- [ ] **Step 6: Run focused adapter/process tests and verify they pass.**

Run: `npx vitest run test/unit/worker-adapter.test.ts test/unit/process-manager.test.ts test/unit/agy-adapter.test.ts test/unit/opencode-adapter.test.ts`

Expected: PASS without invoking a real provider model.

### Task 4: Build and persist Recovery Capsules and preserve source-effect worktrees

**Files:**
- Create: `src/engine/recovery-capsule.ts`
- Modify: `src/types.ts`
- Modify: `src/mailbox/syncer.ts`
- Modify: `src/worker/plan-worker.ts`
- Modify: `src/worker/implement-worker.ts`
- Test: `test/unit/recovery-capsule.test.ts`
- Modify: `test/unit/evidence.test.ts`

**Interfaces:**
- `RecoveryCapsule` contains `contract`, `sourceWorker`, `capturedHistory`, `currentState`, and `recoveryDirective` sections.
- `captureWorktreeState(worktreePath, baseSha)` returns bounded status, diff, diff stat, diff check, HEAD, branch, and changed-file evidence.
- `buildRecoveryCapsule(input)` sanitizes and bounds all persisted fields.
- `ImplementResult` reports `sourceEffectsPresent`, `worktreePath`, `currentHeadSha`, `recoveryEvidence`, `retryAt`, and `rawFailureEvidence`.

- [ ] **Step 1: Write failing capsule/effect tests.** Assert capsule contract and worker fields, bounded secret-free evidence, interrupted worktree preservation, and that a quota result after a source edit returns source effects without committing or cleaning the worktree.
- [ ] **Step 2: Run the focused tests and verify they fail.**

Run: `npx vitest run test/unit/recovery-capsule.test.ts test/unit/evidence.test.ts`

Expected: FAIL because no capsule schema exists and `ImplementWorker` always cleans the worktree.
- [ ] **Step 3: Implement bounded capsule construction.** Add the bridge-owned worktree observer and serialize capsules with fixed size limits. Include exact request prompt, partial output, timestamps, failure class, retry time, current Git state, and unknown operations.
- [ ] **Step 4: Modify `PlanWorker` and `ImplementWorker` to retain evidence.** Pass optional capsule context into worker prompts. On source-writing failure, observe source effects before verification/commit. Preserve the worktree and branch when source effects exist; clean up only when no preservation is required.
- [ ] **Step 5: Add round artifact persistence.** Use `MailboxSyncer.writeRoundFile(jobId, round, 'recovery-capsule.json', ...)` and expose the artifact path in status/result types.
- [ ] **Step 6: Run capsule/evidence tests and verify they pass.**

Run: `npx vitest run test/unit/recovery-capsule.test.ts test/unit/evidence.test.ts`

Expected: PASS with source worktrees retained after interrupted source effects and no secrets in the capsule.

### Task 5: Correct orchestrator fallback, recovery rounds, cooldown recording, and session continuity

**Files:**
- Modify: `src/engine/ledger.ts`
- Modify: `src/engine/orchestrator.ts`
- Modify: `src/mailbox/parser.ts`
- Modify: `src/types.ts`
- Modify: `test/integration/multi-round.test.ts`
- Create: `test/integration/recovery-fallback.test.ts`
- Modify: `test/unit/session-policy.test.ts`

**Interfaces:**
- `JobState` includes `INTERRUPTED_WITH_SOURCE_STATE`.
- Ledger records include `targetId`, `role`, source-effect status, worktree/branch state, and recovery capsule path.
- Recovery job specs set `recovery.enabled` and identify the prior round; recovery uses `WORKER` selection but remains a normal approved `WORKTREE_WRITE` round.
- Orchestrator passes `avoidTargetId` for reviewers, records target failures/successes, builds capsules after failed attempts, and uses configured fallback limits.

- [ ] **Step 1: Write failing orchestration tests.** Cover read-only quota fallback, write quota fallback with zero effects, write quota failure after source effects stopping fallback, interrupted status/capsule publication, recovery continuing an existing worktree, fresh automatic retry after cooldown, `CONTINUE` staying on the same target, cross-platform recovery starting fresh, and capability-gated same-platform cross-model continuation.
- [ ] **Step 2: Run the focused integration tests and verify failures.**

Run: `npx vitest run test/integration/multi-round.test.ts test/integration/recovery-fallback.test.ts test/unit/session-policy.test.ts`

Expected: FAIL because the orchestrator has only read-only fallback, checks only platform for continuation, and has no interrupted-source state.
- [ ] **Step 3: Add target identity and role to ledger/status flow.** Record exact `targetId`, role, platform/model/session, worktree path, branch, and recovery artifact. Treat `INTERRUPTED_WITH_SOURCE_STATE` as terminal for automatic polling until an explicit higher round/recovery request arrives.
- [ ] **Step 4: Implement quota-aware read-only fallback.** After every quota/rate-limit result, record target failure and retry evidence, build/persist the capsule, and select the next eligible target from the same role policy up to configured maximum. Pass the capsule to the fallback and start a fresh session unless the adapter capability explicitly permits continuation.
- [ ] **Step 5: Implement source-writing fallback and interruption.** Permit bounded fallback only when the failed attempt reports no source effects. When effects exist, preserve the worktree, capture bridge-owned state, publish `INTERRUPTED_WITH_SOURCE_STATE`, and stop before another worker starts.
- [ ] **Step 6: Implement explicit recovery rounds.** Resolve recovery with the `WORKER` role, exclude cooldown targets, pass the capsule and preserved worktree into `ImplementWorker`, and include the directive `CONTINUE EXISTING IMPLEMENTATION. DO NOT START OVER.` The default is a fresh destination session; `CONTINUE` is accepted only for a compatible proven session.
- [ ] **Step 7: Fix session continuity.** Continue only when the prior target is compatible. Same target may continue; same-platform model switching requires `supportsCrossModelSessionContinuation`; cross-platform switching always starts fresh with capsule context.
- [ ] **Step 8: Run focused orchestration/session tests and verify they pass.**

Run: `npx vitest run test/integration/multi-round.test.ts test/integration/recovery-fallback.test.ts test/unit/session-policy.test.ts`

Expected: PASS with no automatic fallback after source effects and no silent target migration on `CONTINUE`.

### Task 6: Gate real smoke tests and remove invalid legacy Gemini Flash references

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `src/index.ts`
- Modify: `register-worker.ps1`
- Modify: `unregister-worker.ps1`
- Modify: `src/worker/agy-adapter.ts`
- Modify: `test/integration/real-smoke.test.ts`
- Create: `test/unit/test-boundary.test.ts`
- Modify: `test/integration/multi-round.test.ts`

- [ ] **Step 1: Write the failing test-boundary assertion.** Assert that `npm test` excludes `test/integration/real-smoke.test.ts`, that `npm run test:real-smoke` is the explicit opt-in command, and that normal test configuration contains no provider smoke invocation.
- [ ] **Step 2: Run the boundary test and verify it fails.**

Run: `npx vitest run test/unit/test-boundary.test.ts`

Expected: FAIL because the current `test` script runs every Vitest file and real smoke has no opt-in boundary.
- [ ] **Step 3: Add the explicit smoke script and exclusion.** Set `test` to exclude `test/integration/real-smoke.test.ts`; add `test:real-smoke` for deliberate execution. Keep real smoke timeouts and provider calls out of the normal path.
- [ ] **Step 4: Remove invalid legacy Gemini Flash entries.** Remove the invalid Antigravity fallback model and README catalog mention. Keep `Nemotron 3.5 Lightning` unchanged. Update any role/policy wording to `Gemini Flash 3.7 High`.
- [ ] **Step 5: Increase only the demonstrated mock multi-round timeout.** Give `test/integration/multi-round.test.ts` an explicit bounded timeout appropriate for Git worktree setup, without allowing real provider calls.
- [ ] **Step 6: Run the boundary and focused integration tests.**

Run: `npx vitest run test/unit/test-boundary.test.ts test/integration/multi-round.test.ts`

Expected: PASS, and the test output contains no real AGY/OpenCode smoke execution.

### Task 7: Full verification, scope audit, and final commit

**Files:**
- All implementation/test/documentation files listed above; no unrelated paths.

- [ ] **Step 1: Run the build.**

Run: `npm run build`

Expected: TypeScript exits 0.
- [ ] **Step 2: Run the normal test suite.**

Run: `npm test`

Expected: All normal tests pass with exact file/test counts and no real provider model calls.
- [ ] **Step 3: Search for invalid legacy Gemini Flash references.**

Run: a case-insensitive repository search for legacy Gemini Flash identifiers, excluding `node_modules` and `dist`.

Expected: no output. Valid `nemotron-3.5` references are not included in this search.
- [ ] **Step 4: Run the final whitespace check.**

Run: `git diff --check`

Expected: no whitespace errors.
- [ ] **Step 5: Audit Git scope before commit.**

Run: `git status --short`, `git diff --stat`, and `git diff --name-only`.

Expected: only the approved Worker Bridge recovery, policy, test, and documentation paths are changed; Gemini's existing source changes are included intentionally and unrelated user work is not staged.
- [ ] **Step 6: Stage explicit paths and verify the staged scope.**

Run:

```text
git add -- README.md config.example.json package.json register-worker.ps1 unregister-worker.ps1 src/config.ts src/engine/job-role.ts src/engine/ledger.ts src/engine/model-selector.ts src/engine/orchestrator.ts src/engine/process-manager.ts src/engine/recovery-capsule.ts src/engine/target-availability-ledger.ts src/index.ts src/mailbox/parser.ts src/mailbox/syncer.ts src/policy/default-selection-policy.json src/types.ts src/worker/adapter-registry.ts src/worker/agy-adapter.ts src/worker/implement-worker.ts src/worker/opencode-adapter.ts src/worker/plan-worker.ts src/worker/worker-adapter.ts test/fixtures/mock-opencode.js test/fixtures/mock-opencode.cmd test/integration/multi-round.test.ts test/integration/real-smoke.test.ts test/integration/recovery-fallback.test.ts test/unit/approval-gate.test.ts test/unit/agy-adapter.test.ts test/unit/config.test.ts test/unit/evidence.test.ts test/unit/ledger.test.ts test/unit/model-selector.test.ts test/unit/opencode-adapter.test.ts test/unit/process-manager.test.ts test/unit/recovery-capsule.test.ts test/unit/schema.test.ts test/unit/session-policy.test.ts test/unit/test-boundary.test.ts test/unit/worker-adapter.test.ts docs/superpowers/plans/2026-08-14-worker-bridge-recovery-target-selection-plan.md
git diff --cached --name-only
git diff --cached --check
```

Expected: the staged list contains only the approved paths and has no whitespace errors.
- [ ] **Step 7: Commit the corrected Worker Bridge implementation.**

Run: `git commit -m "feat: recover worker bridge target selection"`

Expected: a new local commit is created without pushing or deploying.
- [ ] **Step 8: Verify the final SHA and clean staged state.**

Run: `git rev-parse HEAD` and `git status --short --branch`.

Expected: the final full SHA is reported; no approved changes remain unstaged, and any unrelated pre-existing changes are explicitly reported.
