# Worker Bridge Codex CLI Explicit-Only Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI Codex CLI as a dynamically discovered, explicit-only Worker Bridge target without changing automatic rankings, authority semantics, source-effect recovery law, or generic orchestration meaning.

**Architecture:** Add a policy-declared `codex` platform capability backed by a `CodexAdapter`. Keep model discovery, selectability, reasoning topology, configuration containment, JSONL parsing, failure normalization, and exact session handling inside the adapter/catalog and generic worker contracts. Extend the generic selector and fallback contract so explicit Codex targets work through the same resolution path, while automatic ranking and source-effect recovery remain unchanged.

**Tech Stack:** TypeScript 5.7, Node.js ESM, Vitest 3, JSON policy/configuration, Windows `codex.exe`/`.cmd` process fixtures, isolated Git worktrees.

## Global Constraints

- Initial implementation baseline is `b0c79a69def5d47c40b3162d18d0e28776265efa`.
- `platformId` for Codex is exactly `codex`.
- The Codex policy target is `explicitOnly: true` and has no fixed current model ID.
- Codex MUST be absent from every automatic role ranking and MUST NOT be selected by automatic fallback, cooldown reranking, fresh automatic selection, or reviewer diversification.
- Automatic role ranking order remains exactly the current PLANNER, INVESTIGATOR, WORKER, and REVIEWER policy order.
- An explicit Codex target/model overrides automatic ranking and reviewer diversification, including an explicit Codex reviewer after a producer from the same producer/platform.
- A discovered model is valid only after exact model-ID match, catalog-declared user selectability, and generic Worker Bridge capability checks.
- Catalog membership, selectability, authentication, runtime availability, and quota remain separate facts.
- Current model IDs MUST be discovered at runtime; no current Codex catalog is permanently hardcoded in production policy.
- Explicit reasoning is optional. Omitted reasoning selects the highest discovered ordinary native reasoning profile. An unknown topology classification fails closed.
- A topology-changing profile requires explicit selection and proof that the Worker Bridge authority envelope remains intact.
- Worker execution and `exec resume` MUST use `--ignore-user-config`.
- `codex debug models --bundled` is the sole configuration-flag exception because the installed CLI rejects `--ignore-user-config` for that metadata-only command; it MUST be used only as the exact bundled read-only catalog command.
- Codex authentication remains Codex-owned through the normal authenticated CLI and `CODEX_HOME`; Worker Bridge MUST NOT extract, copy, persist, or refresh credentials.
- Project-scoped `.codex/config.toml` is allowed only when a bounded authority classifier proves it contains no capability-expanding or unknown configuration.
- Every invocation binds the exact model, native reasoning profile, worktree/cwd, sandbox, and approval mode.
- `READ_ONLY` uses `--sandbox read-only`; `WORKTREE_WRITE` uses `--sandbox workspace-write`; `--ask-for-approval never` remains bridge-controlled.
- `codex exec resume <session-id>` is used only with an unambiguous exact session ID and matching platform, target, model, reasoning, worktree, execution mode, and authority context.
- `resume --last` and session-ID inference from prose are prohibited.
- Explicit `fallbackSelection` is bounded and nonrecursive. It does not override source-effect recovery law.
- No automatic worker may start after `WORKTREE_WRITE` source effects. The worktree, diff, evidence, and Recovery Capsule remain preserved until explicit recovery/handoff authorization.
- Recovery Capsule remains platform-neutral and bridge-constructed.
- Normal `npm test` MUST make no real Codex/provider inference calls. Real Codex smoke is not run.
- Do not modify Project Ashley, push, merge, deploy, register startup, or change `main`/`master` authority.
- Use TDD for every production behavior change: write one failing test, run it and observe the intended failure, implement the smallest passing change, rerun focused tests, then refactor only while green.

## Current File Map

- `src/types.ts`: generic target, discovered-model, reasoning-topology, fallback-selection, failure, and session-identity contracts.
- `src/config.ts`, `src/policy/default-selection-policy.json`, `config.example.json`: policy merging, dynamic Codex target validation, platform configuration, and unchanged role rankings.
- `src/worker/worker-adapter.ts`: adapter capability contract and typed normalized adapter errors.
- `src/worker/codex-model-catalog.ts`: pure Codex catalog parsing, selectability normalization, and reasoning-topology classification.
- `src/worker/codex-config-guard.ts`: bounded project-scoped Codex configuration authority preflight.
- `src/worker/codex-adapter.ts`: executable discovery, version inspection, bundled catalog discovery, exact invocation/resume arguments, JSONL parsing, reasoning resolution, quota normalization, and cancellation.
- `src/engine/process-manager.ts`: generic bounded process execution with stdin support and existing shell-disabled Windows invocation.
- `src/engine/model-selector.ts`: generic explicit target resolution, dynamic model binding, automatic exclusion, availability checks, reviewer diversification, fallback authorization, and session identity checks.
- `src/engine/ledger.ts`, `src/engine/orchestrator.ts`: generic target/session/fallback/recovery state flow and Codex adapter registration.
- `src/worker/plan-worker.ts`, `src/worker/implement-worker.ts`, `src/engine/recovery-capsule.ts`: generic session context, evidence, preserved worktree, and capsule propagation.
- `src/mailbox/parser.ts`, `src/mailbox/syncer.ts`: validated explicit fallback selection and existing capsule persistence.
- `README.md`, `src/index.ts`: truthful supported-platform and explicit-only behavior documentation.
- `test/fixtures/mock-codex.js`, `test/fixtures/mock-codex.cmd`, `test/fixtures/mock-codex-catalog.json`: fixture-only version, catalog, exec, resume, and JSONL behavior.
- `test/unit/codex-model-catalog.test.ts`, `test/unit/codex-config-guard.test.ts`, `test/unit/codex-adapter.test.ts`: focused Codex behavior tests.
- `test/unit/model-selector.test.ts`, `test/unit/process-manager.test.ts`, `test/unit/schema.test.ts`, `test/unit/config.test.ts`, `test/unit/session-policy.test.ts`: generic contract and selector regression tests.
- `test/integration/recovery-fallback.test.ts`, `test/integration/multi-round.test.ts`, `test/unit/test-boundary.test.ts`: fallback, recovery, and no-real-provider boundaries.

---

### Task 1: Extend Generic Contracts and Policy Data

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/policy/default-selection-policy.json`
- Modify: `config.example.json`
- Modify: `src/mailbox/parser.ts`
- Test: `test/unit/config.test.ts`
- Test: `test/unit/schema.test.ts`

**Interfaces:**

```ts
export type ModelBinding = 'FIXED' | 'EXPLICIT_DISCOVERED';
export type ModelSelectability = 'SELECTABLE' | 'NOT_SELECTABLE' | 'UNKNOWN';
export type ReasoningTopology = 'ORDINARY' | 'TOPOLOGY_CHANGING' | 'UNKNOWN';

export interface DiscoveredReasoningProfile {
  value: string;
  topology: ReasoningTopology;
  description?: string;
}

export interface DiscoveredModel {
  id: string;
  displayName: string;
  family?: string;
  variants: string[];
  highestVariant?: string;
  reasoningProfiles?: DiscoveredReasoningProfile[];
  selectability?: ModelSelectability;
  contextLimit?: number;
  isExplicitOnly?: boolean;
}

export interface ExplicitFallbackSelection {
  targetId?: string;
  platform?: string;
  model?: string;
  reasoning?: ReasoningConfig;
}
```

Add `modelBinding?: ModelBinding` and `modelId?: string` to `WorkerTargetConfig`. Fixed targets require `modelBinding: 'FIXED'` or the default fixed behavior plus a model ID. `EXPLICIT_DISCOVERED` targets may omit `modelId`. Add `fallbackSelection?: ExplicitFallbackSelection` to `WorkerSelection`; this type MUST NOT contain another fallback selection or an `allowFallback` field.

Add normalized failure classes `MODEL_DISCOVERY_UNAVAILABLE`, `MODEL_NOT_SELECTABLE`, `REASONING_PROFILE_UNSUPPORTED`, and `SESSION_ID_UNAVAILABLE` to `OperationalFailureClass`. Keep unsafe project configuration under the existing generic `PERMISSION_BLOCKED` class with bounded reason evidence.

Add generic session identity fields without making Codex a special case:

```ts
export interface WorkerSessionIdentity {
  targetId?: string;
  platform: string;
  model: string;
  reasoning?: string;
  sessionId?: string;
  worktreeCwd: string;
  executionMode: ExecutionMode;
}
```

`WorkerRoundResult.sessionIdentity?: WorkerSessionIdentity` carries the exact resolved identity. `LedgerJobRecord` stores the resolved native reasoning string alongside its existing target, platform, model, session, execution mode, and worktree fields. Existing AGY/OpenCode fixtures continue to compile because new discovery/session fields are optional.

- [ ] **Step 1: Write failing contract and policy tests.** Assert that the default policy contains `codex_explicit` with platform `codex`, `explicitOnly: true`, `modelBinding: 'EXPLICIT_DISCOVERED'`, no fixed model ID, and aliases `codex`/`openai_codex`. Assert that each role ranking equals the current exact array and contains no Codex target. Assert that a fixed target without `modelId` is rejected, a dynamic target without `modelId` is accepted, an explicit model may omit `reasoning`, and nested `fallbackSelection` is rejected.

```ts
expect(policy.targets.codex_explicit).toMatchObject({
  targetId: 'codex_explicit',
  platformId: 'codex',
  modelBinding: 'EXPLICIT_DISCOVERED',
  explicitOnly: true,
});
expect(policy.targets.codex_explicit.modelId).toBeUndefined();
for (const ranking of Object.values(policy.roleRankings)) {
  expect(ranking).not.toContain('codex_explicit');
}
```

- [ ] **Step 2: Run the focused tests and verify the expected failure.**

Run: `npx vitest run test/unit/config.test.ts test/unit/schema.test.ts`

Expected: FAIL because the current target contract requires `modelId`, the Codex target is absent, and nested fallback selection is not validated.

- [ ] **Step 3: Add the generic types and normalized failure names.** Keep existing target/model fields source-compatible for fixed AGY/OpenCode targets and add only optional dynamic/session metadata.

- [ ] **Step 4: Add the Codex policy target and platform configuration.** Add `codex_explicit` to `src/policy/default-selection-policy.json` and the equivalent policy to `config.example.json`. Add an enabled `codex` platform with executable `codex` and no default model. Preserve every existing role ranking byte-for-byte apart from surrounding JSON formatting needed by the new target data.

- [ ] **Step 5: Validate fallback selection at the mailbox boundary.** Parse `workerSelection.fallbackSelection` only when it is an object with at least one target/platform/model identifier. Reject `fallbackSelection.fallbackSelection`, `fallbackSelection.allowFallback`, invalid reasoning objects, and non-string identifiers. Preserve schema v1 compatibility.

- [ ] **Step 6: Run the focused tests and verify they pass.**

Run: `npx vitest run test/unit/config.test.ts test/unit/schema.test.ts`

Expected: PASS with exact unchanged rankings, a dynamic explicit-only Codex target, optional reasoning, and nonrecursive fallback selection.

- [ ] **Step 7: Commit the generic contract/policy slice.**

```text
git add -- src/types.ts src/config.ts src/policy/default-selection-policy.json config.example.json src/mailbox/parser.ts test/unit/config.test.ts test/unit/schema.test.ts
git diff --cached --check
git commit -m "feat: add explicit codex target contracts"
```

### Task 2: Add Codex Catalog Parsing and Reasoning-Topology Resolution

**Files:**
- Create: `src/worker/codex-model-catalog.ts`
- Modify: `src/worker/worker-adapter.ts`
- Modify: `src/types.ts`
- Create: `test/fixtures/mock-codex-catalog.json`
- Create: `test/unit/codex-model-catalog.test.ts`
- Modify: `test/unit/recovery-capsule.test.ts`

**Interfaces:**

```ts
export interface CodexCatalogParseResult {
  models: DiscoveredModel[];
  source: 'bundled';
}

export function parseCodexModelCatalog(raw: unknown): CodexCatalogParseResult;
export function assertCodexModelSelectable(model: DiscoveredModel): void;
export function resolveCodexReasoningProfile(
  model: DiscoveredModel,
  strategy: 'highest-supported' | 'explicit',
  explicitValue?: string
): DiscoveredReasoningProfile;
```

The parser accepts only an object containing a `models` array. It maps `slug` to exact `id`, `display_name` to `displayName`, `supported_reasoning_levels[*].effort` to native profile values, `supported_in_api` and `visibility` to `selectability`, and provider descriptions/explicit topology metadata to `ReasoningTopology`.

For the observed catalog shape, `visibility: 'list'` plus `supported_in_api !== false` normalizes to `SELECTABLE`; `visibility: 'hide'` or `supported_in_api: false` normalizes to `NOT_SELECTABLE`; missing or unknown selectability metadata normalizes to `UNKNOWN`. The parser never compares a model ID against a rejection list.

Reasoning topology classification MUST use provider metadata, not the profile string. A provider description that explicitly says automatic delegation is `TOPOLOGY_CHANGING`; an explicit ordinary/standard reasoning marker is `ORDINARY`; unrecognized or missing semantics are `UNKNOWN`. The fixture includes ordinary `max` metadata and a topology-changing profile with a delegation description so omitted Sol/Terra reasoning resolves to `max` and explicit topology-changing reasoning can be tested without a string-specific branch.

`highest-supported` selects the last provider-ordered `ORDINARY` profile only when every profile at or above that candidate has a known topology. A known topology-changing profile above it is skipped. An `UNKNOWN` profile at or above it fails with `REASONING_PROFILE_UNSUPPORTED`. `explicit` requires exact profile membership and known topology; an explicit topology-changing profile is returned to the adapter for authority-envelope validation.

- [ ] **Step 1: Write failing catalog tests.** Cover exact IDs, `list` versus `hide` selectability, `supported_in_api`, hidden-model rejection without an ID list, absent/unknown catalog shape, highest ordinary default, explicit topology-changing selection, and unknown topology failure.

```ts
const catalog = parseCodexModelCatalog(fixture);
const hidden = catalog.models.find((model) => model.id === 'codex-auto-review');
expect(hidden?.selectability).toBe('NOT_SELECTABLE');
expect(() => assertCodexModelSelectable(hidden!)).toThrow('MODEL_NOT_SELECTABLE');
expect(resolveCodexReasoningProfile(sol, 'highest-supported').value).toBe('max');
expect(resolveCodexReasoningProfile(sol, 'explicit', 'ultra').value).toBe('ultra');
```

- [ ] **Step 2: Run the focused catalog tests and verify the expected failure.**

Run: `npx vitest run test/unit/codex-model-catalog.test.ts`

Expected: FAIL because no Codex parser, selectability normalization, or topology-aware resolver exists.

- [ ] **Step 3: Implement the pure parser and resolver.** Throw `WorkerAdapterError('MODEL_DISCOVERY_UNAVAILABLE', ...)` for invalid catalog shape, return normalized selectability for every parsed model, preserve native reasoning values, and keep all current model IDs confined to the fixture.

- [ ] **Step 4: Add typed adapter errors and capsule compatibility.** Export `WorkerAdapterError` from `src/worker/worker-adapter.ts` with `failureClass` and a sanitized message. Add the new failure classes to Recovery Capsule validation so a Codex discovery/reasoning failure can be persisted and parsed.

- [ ] **Step 5: Run the focused catalog and capsule tests and verify they pass.**

Run: `npx vitest run test/unit/codex-model-catalog.test.ts test/unit/recovery-capsule.test.ts`

Expected: PASS with no hardcoded rejected model ID and exact native reasoning preservation.

### Task 3: Add Generic Process stdin and Project Configuration Authority Containment

**Files:**
- Modify: `src/engine/process-manager.ts`
- Create: `src/worker/codex-config-guard.ts`
- Modify: `src/worker/worker-adapter.ts`
- Create: `test/unit/codex-config-guard.test.ts`
- Modify: `test/unit/process-manager.test.ts`

**Interfaces:**

```ts
export interface ProcessRunOptions {
  executable: string;
  args: string[];
  cwd: string;
  stdinText?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface ProjectConfigAuthorityResult {
  allowed: boolean;
  inspectedFiles: string[];
  reason?: string;
}

export function inspectCodexProjectConfig(worktreeCwd: string): ProjectConfigAuthorityResult;
```

`ProcessManager.run` writes `stdinText` to `child.stdin` and closes it before waiting for process completion. It keeps `shell: false`, safe `.cmd`/`.bat` invocation, bounded output, incremental callbacks, cancellation, and timeout behavior unchanged.

The project-config guard walks the bound worktree and repository-ancestor `.codex/config.toml` paths, with a bounded file-size and ancestor-depth limit. It parses only the TOML sections/keys needed for authority classification. It allows explicitly classified non-authority settings and values overridden by bridge arguments. It rejects capability-bearing sections/keys for MCP/tools, hooks/plugins, providers/endpoints, network, filesystem/elevation, sandbox, approval, or equivalent capability expansion. Unknown keys, unknown sections, invalid TOML, oversized files, and unreadable files return `allowed: false` with a bounded reason. The guard never edits, copies, or persists project configuration.

Add an optional generic adapter hook so orchestration does not branch on Codex:

```ts
validateExecutionContext?(request: WorkerInvocationRequest): Promise<void>;
```

CodexAdapter will call the guard before `exec` and `exec resume`; future adapters can use the same authority boundary.

- [ ] **Step 1: Write a failing stdin process test.** Use a disposable fixture process that echoes stdin and assert `ProcessManager.run({ stdinText: 'bounded prompt' })` delivers the exact text, closes stdin, retains `shell: false`, and reports bounded output.

- [ ] **Step 2: Run the process test and verify the expected failure.**

Run: `npx vitest run test/unit/process-manager.test.ts`

Expected: FAIL because `ProcessRunOptions` has no stdin path.

- [ ] **Step 3: Write failing authority-boundary tests.** Assert no project config is allowed with no files, a controlled non-authority config is allowed, a capability-bearing config is rejected as `PERMISSION_BLOCKED`, an unknown key is rejected, an invalid/oversized file is rejected, and the guard never changes file contents.

- [ ] **Step 4: Run the authority tests and verify the expected failure.**

Run: `npx vitest run test/unit/codex-config-guard.test.ts`

Expected: FAIL because the guard module does not exist.

- [ ] **Step 5: Implement stdin and the bounded project-config guard.** Pass stdin through the existing process abstraction. Make the guard fail closed before any Codex process starts when authority cannot be proven.

- [ ] **Step 6: Run focused process and authority tests and verify they pass.**

Run: `npx vitest run test/unit/process-manager.test.ts test/unit/codex-config-guard.test.ts`

Expected: PASS with no shell-enabled path and no configuration mutation.

### Task 4: Implement CodexAdapter with Fixture-Only CLI Behavior

**Files:**
- Create: `src/worker/codex-adapter.ts`
- Modify: `src/worker/worker-adapter.ts`
- Modify: `src/types.ts`
- Create: `test/fixtures/mock-codex.js`
- Create: `test/fixtures/mock-codex.cmd`
- Modify: `test/fixtures/mock-codex-catalog.json`
- Create: `test/unit/codex-adapter.test.ts`

**Interfaces:**

```ts
export const DEFAULT_CODEX_PATH = 'codex';

export class CodexAdapter implements WorkerAdapter {
  readonly platformId = 'codex';
  readonly supportsCrossModelSessionContinuation = false;

  constructor(executable?: string, processManager?: ProcessManager);
  getExecutablePath(): string;
  inspectEnvironment(): Promise<WorkerPlatformInfo>;
  discoverModels(refresh?: boolean): Promise<DiscoveredModel[]>;
  resolveReasoningProfile(
    modelId: string,
    requestedStrategy?: 'highest-supported' | 'explicit',
    explicitValue?: string
  ): Promise<string | undefined>;
  probeQuota(modelId?: string): Promise<QuotaProbeResult>;
  invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult>;
  cancel(jobId: string): Promise<boolean>;
}
```

`inspectEnvironment` verifies an explicitly configured executable directly. For the default `codex` name, it verifies `where.exe` candidates and runnable per-user standalone release paths under `.codex\packages\standalone\releases\*\bin\codex.exe` using `--version`. It MUST NOT silently select the inaccessible Windows App resource path or replace an explicitly configured path. The returned version is the verified `codex-cli 0.147.0`-style output, not a fabricated fallback.

`discoverModels` invokes only the verified read-only `debug models --bundled` shape, parses JSON through `parseCodexModelCatalog`, caches bounded catalog data, and returns no fabricated model list. It reports `MODEL_DISCOVERY_UNAVAILABLE` when the command fails or the JSON shape is invalid.

`resolveReasoningProfile` uses the parsed model metadata. It returns the highest ordinary native value when strategy is `highest-supported`, validates exact explicit values, and rejects unknown/unsupported/topology-unsafe reasoning with `REASONING_PROFILE_UNSUPPORTED` or `PERMISSION_BLOCKED`. The value passed to the process is the exact native value from the catalog.

Initial invocation arguments must contain the following exact controls:

```text
exec
--ignore-user-config
--cd <isolated-worktree>
--model <exact-resolved-model-id>
-c model_reasoning_effort="<exact-native-reasoning>"
--sandbox read-only|workspace-write
--ask-for-approval never
--json
--output-last-message <bounded-job-output-path>
-
```

Resume arguments must contain `exec resume <exact-session-id>`, `--ignore-user-config`, the exact model and native reasoning, JSON/last-message capture, and stdin prompt. Because the installed resume help does not expose the same cwd/sandbox flags, resume is allowed only after the stored session identity proves the same worktree and authority envelope. Otherwise it fails with `SESSION_ID_UNAVAILABLE` and does not spawn a process.

The JSONL parser accepts only unambiguous machine-readable session fields such as `thread_id`, `threadId`, `session_id`, `sessionId`, or nested session/thread IDs. Conflicting IDs are ambiguous. Response text comes from structured message/item text fields; prose is never used as a session ID. Runtime failures call `analyzeOperationalError`, return bounded sanitized evidence, and leave quota state `UNKNOWN` until authoritative errors provide a normalized state or retry time.

The fixture supports `--version`, exact bundled catalog output, `exec`, and `exec resume` without network calls or model inference. It emits one stable session ID and structured response/tool JSONL so tests prove parsing rather than only mocking a return object.

- [ ] **Step 1: Write failing adapter argument and discovery tests.** Assert direct/fixture version inspection, exact bundled catalog invocation, dynamic model output, `--ignore-user-config` on `exec` and resume, exact model/reasoning/cwd/sandbox/approval arguments, stdin prompt delivery, no dangerous bypass flags, and no default model substitution.

- [ ] **Step 2: Run the focused adapter tests and verify the expected failure.**

Run: `npx vitest run test/unit/codex-adapter.test.ts`

Expected: FAIL because `CodexAdapter` and the fixture command do not exist.

- [ ] **Step 3: Add the fixture command and catalog fixture.** Keep the fixture deterministic, local, and incapable of network/model calls. Use the verified hidden/list visibility and reasoning descriptions in the catalog fixture.

- [ ] **Step 4: Implement executable inspection and bundled discovery.** Verify paths with `--version`, invoke only the exact metadata command, parse through the pure catalog module, and fail closed on missing/invalid output.

- [ ] **Step 5: Implement reasoning resolution and authority validation.** Run `inspectCodexProjectConfig` before execution, preserve native reasoning, and reject unsupported topology/configuration before `ProcessManager.run`.

- [ ] **Step 6: Implement initial/resume invocation and JSONL evidence parsing.** Pass prompts through stdin, capture session identity, bounded events, response text, tool counts, last meaningful action, output path, failure class, retry time, and raw sanitized evidence.

- [ ] **Step 7: Run focused adapter tests and verify they pass.**

Run: `npx vitest run test/unit/codex-adapter.test.ts test/unit/codex-model-catalog.test.ts test/unit/codex-config-guard.test.ts test/unit/process-manager.test.ts`

Expected: PASS with no real Codex process and no provider quota use.

- [ ] **Step 8: Commit the adapter slice.**

```text
git add -- src/worker/codex-adapter.ts src/worker/codex-model-catalog.ts src/worker/codex-config-guard.ts src/worker/worker-adapter.ts src/engine/process-manager.ts src/types.ts test/fixtures/mock-codex.js test/fixtures/mock-codex.cmd test/fixtures/mock-codex-catalog.json test/unit/codex-adapter.test.ts test/unit/codex-model-catalog.test.ts test/unit/codex-config-guard.test.ts test/unit/process-manager.test.ts test/unit/recovery-capsule.test.ts
git diff --cached --check
git commit -m "feat: add fixture-backed codex adapter"
```

### Task 5: Extend ModelSelector for Dynamic Explicit Codex and Authorized Fallback

**Files:**
- Modify: `src/engine/model-selector.ts`
- Modify: `src/engine/target-availability-ledger.ts`
- Modify: `src/worker/worker-adapter.ts`
- Modify: `src/types.ts`
- Modify: `test/unit/model-selector.test.ts`
- Modify: `test/unit/target-availability-ledger.test.ts`

**Interfaces:**

```ts
export interface ResolvedWorkerSelection {
  targetId: string;
  platform: string;
  modelId: string;
  variant?: string;
  reasoningStrategy: ReasoningStrategy;
  isExplicitOnly?: boolean;
  resolvedFromAlias?: string;
}

export interface FallbackResolutionOptions {
  failedTargetIds: Set<string>;
  avoidTargetId?: string;
  now?: Date;
  authorizedFallback?: ExplicitFallbackSelection;
}

getNextFallback(
  current: ResolvedWorkerSelection,
  roleOrIntent: WorkerRole | JobIntent,
  options: FallbackResolutionOptions
): Promise<ResolvedWorkerSelection>;
```

Dynamic explicit resolution works only when the request identifies the Codex target through `targetId`, `platform: 'codex'`, or a policy alias. A raw model ID without a platform/target/alias MUST NOT cause provider inference. The selector binds that request to the unique `EXPLICIT_DISCOVERED` target for the platform, resolves exact catalog membership and selectability, and returns the requested exact model ID.

Automatic resolution remains ranking-driven. It skips missing policy references, disabled/unregistered/uninstalled/unavailable targets, and every `explicitOnly` target. It never asks Codex for a model during automatic selection. Reviewer avoidance is applied only to automatic selection; explicit Codex selection bypasses it.

`getNextFallback` uses `authorizedFallback` only when the caller supplies it. It resolves that target through the explicit path, verifies it is not already failed, and does not consult role rankings for that branch. Without `authorizedFallback`, it uses the existing role ranking and therefore cannot select Codex. The availability ledger records the effective exact model ID for dynamic targets instead of requiring a policy model ID.

- [ ] **Step 1: Write failing selector tests.** Assert all current exact role arrays, Codex absent from automatic PLANNER/INVESTIGATOR/WORKER/REVIEWER selection, Codex absent after automatic quota cooldown, explicit `platform: 'codex'` plus model resolution, hidden catalog model rejection, exact unsupported model rejection, same-producer explicit reviewer override, and authorized Codex fallback only through `fallbackSelection`.

- [ ] **Step 2: Run the focused selector tests and verify the expected failure.**

Run: `npx vitest run test/unit/model-selector.test.ts test/unit/target-availability-ledger.test.ts`

Expected: FAIL because the selector assumes every target has a policy model ID and its fallback method has no explicit authorization route.

- [ ] **Step 3: Implement dynamic target resolution.** Resolve the effective requested model for `EXPLICIT_DISCOVERED` targets, preserve exact model casing/value as returned by the catalog, reject `UNKNOWN`/`NOT_SELECTABLE`, and propagate typed failure classes for explicit requests.

- [ ] **Step 4: Preserve automatic exclusion invariants.** Keep the existing ranking order, skip `explicitOnly` before adapter discovery/quota probing, and preserve reviewer diversification only for automatic requests.

- [ ] **Step 5: Add bounded authorized fallback resolution.** Migrate callers to `FallbackResolutionOptions`, resolve `authorizedFallback` explicitly, reject recursive/ambiguous fallback targets, and leave automatic fallback ranking Codex-free.

- [ ] **Step 6: Update availability records for effective model IDs.** Keep availability keyed by target ID while storing the exact resolved model for evidence. Do not mark catalog discovery as available or quota-restored.

- [ ] **Step 7: Run focused selector tests and verify they pass.**

Run: `npx vitest run test/unit/model-selector.test.ts test/unit/target-availability-ledger.test.ts`

Expected: PASS with automatic Codex exclusion and explicit-only fallback authorization.

### Task 6: Register Codex and Enforce Generic Session/Recovery/Fallback Semantics

**Files:**
- Modify: `src/engine/orchestrator.ts`
- Modify: `src/engine/ledger.ts`
- Modify: `src/engine/model-selector.ts`
- Modify: `src/worker/plan-worker.ts`
- Modify: `src/worker/implement-worker.ts`
- Modify: `src/engine/recovery-capsule.ts`
- Modify: `src/types.ts`
- Modify: `test/unit/session-policy.test.ts`
- Modify: `test/unit/ledger.test.ts`
- Modify: `test/integration/recovery-fallback.test.ts`
- Modify: `test/integration/multi-round.test.ts`

**Interfaces:**

```ts
canContinueSession(
  previous: WorkerSessionIdentity,
  next: ResolvedWorkerSelection,
  requestedMode: ExecutionMode,
  currentWorktreeCwd?: string
): boolean;
```

The orchestrator registers `CodexAdapter` alongside AGY and OpenCode through `AdapterRegistry`; no `if (platform === 'codex')` branch is added to job-state or fallback meaning.

`allowFallbackFor` returns false for an explicit primary target unless `fallbackSelection` exists and `allowFallback` is not explicitly false. The fallback loop passes the authorized selection into `getNextFallback`. It still runs only for the existing bounded quota/rate classes and still stops immediately when `ImplementResult.sourceEffectsPresent` is true.

Session continuation requires exact target/platform/model/native reasoning/session/worktree/execution-mode identity. The same target/model/reasoning can continue only when the session ID exists and the worktree/authority context is still valid. Same-platform model changes require the adapter capability; Codex declares that capability false. Cross-platform continuation is always fresh with capsule context. A requested model or materially different reasoning produces a fresh round even if `sessionPolicy` says `CONTINUE`; an unavailable exact session produces `SESSION_ID_UNAVAILABLE` and no invocation.

Persist the resolved native reasoning in the ledger and status identity. For implementation recovery, reuse `prevRecord.worktreePath` only when the path exists and the preserved branch/base state matches the capsule. For read-only plan worktrees, a cleaned prior path cannot satisfy exact continuation, so the bridge starts a fresh session with evidence rather than pretending resume safety.

The existing source-effect law remains authoritative:

```text
READ_ONLY quota/rate failure + authorized fallback -> bounded fallback allowed
WORKTREE_WRITE quota/rate failure + no source effects + authorized fallback -> bounded fallback allowed
WORKTREE_WRITE quota/rate failure + source effects -> preserve and interrupt; no new worker
```

Every failed attempt keeps its exact session/model/reasoning evidence in the existing platform-neutral Recovery Capsule. `MODEL_NOT_SELECTABLE`, `MODEL_DISCOVERY_UNAVAILABLE`, `REASONING_PROFILE_UNSUPPORTED`, and `SESSION_ID_UNAVAILABLE` are persisted through the generic failure/capsule path and never trigger silent model substitution.

- [ ] **Step 1: Write failing session and fallback integration tests.** Add tests for exact same-target/model/reasoning/worktree continuation, reasoning/model mismatch becoming fresh, missing session ID blocking continuation, Codex cross-model continuation refusal, explicit Codex fallback in `READ_ONLY`, explicit Codex fallback in write mode with no source effects, and authorized Codex fallback blocked after source effects.

- [ ] **Step 2: Run the focused tests and verify the expected failure.**

Run: `npx vitest run test/unit/session-policy.test.ts test/unit/ledger.test.ts test/integration/recovery-fallback.test.ts test/integration/multi-round.test.ts`

Expected: FAIL because the ledger does not persist native reasoning/session worktree identity and the orchestrator does not accept an explicit fallback route.

- [ ] **Step 3: Register Codex and persist generic session identity.** Add adapter construction from `cfg.platforms.codex.executable || 'codex'`, add native reasoning/session/worktree identity to ledger/status updates, and keep recovery capsule fields platform-neutral.

- [ ] **Step 4: Implement exact continuation checks.** Pass the full previous identity into `canContinueSession`, refuse unsafe Codex resume before invoking, and preserve fresh/recovery behavior when the exact context is unavailable.

- [ ] **Step 5: Implement explicit fallback authorization in orchestration.** Pass only `fallbackSelection` into the explicit fallback branch, retain bounded attempt counts, and preserve the existing target-keyed availability ledger.

- [ ] **Step 6: Re-prove source-effect interruption.** Assert that a write failure after a source edit preserves the worktree and capsule, publishes `INTERRUPTED_WITH_SOURCE_STATE`, does not call the authorized Codex fallback, and allows a later explicit recovery round to continue the preserved state.

- [ ] **Step 7: Run focused session/fallback tests and verify they pass.**

Run: `npx vitest run test/unit/session-policy.test.ts test/unit/ledger.test.ts test/integration/recovery-fallback.test.ts test/integration/multi-round.test.ts`

Expected: PASS with no silent target migration and no automatic recovery after source effects.

- [ ] **Step 8: Commit generic orchestration/session integration.**

```text
git add -- src/engine/orchestrator.ts src/engine/ledger.ts src/engine/model-selector.ts src/worker/plan-worker.ts src/worker/implement-worker.ts src/engine/recovery-capsule.ts src/types.ts test/unit/session-policy.test.ts test/unit/ledger.test.ts test/integration/recovery-fallback.test.ts test/integration/multi-round.test.ts
git diff --cached --check
git commit -m "feat: integrate codex through generic recovery flow"
```

### Task 7: Update Documentation and Test Boundaries Without Expanding Scope

**Files:**
- Modify: `README.md`
- Modify: `src/index.ts`
- Modify: `test/unit/test-boundary.test.ts`
- Modify: `test/integration/real-smoke.test.ts`
- Modify: `test/unit/config.test.ts`
- Modify: `test/unit/model-selector.test.ts`

Document Codex as an explicit-only platform, show an explicit `platform: 'codex'` plus exact model example, explain optional native reasoning defaulting, explain hidden/non-selectable catalog rejection, state that user config is ignored for execution/resume, and describe project-config fail-closed containment. State that catalog validity does not prove account/runtime availability or quota. Keep the supported automatic platform/ranking claims unchanged and keep every Gemini reference at Flash 3.7. Do not add startup registration or Project Ashley references.

The normal test boundary must continue excluding `test/integration/real-smoke.test.ts`. Add static assertions that `npm test` excludes the real smoke file, `test:real-smoke` is the only opt-in provider path, no real Codex executable invocation appears in the normal script, and the automatic role ranking fixtures contain no Codex target.

- [ ] **Step 1: Write failing documentation/boundary assertions.** Assert the README/index mention explicit-only Codex and the exact policy alias, the normal test script excludes real smoke, the real-smoke script is opt-in, and no startup/register script is changed.

- [ ] **Step 2: Run the focused boundary tests and verify the expected failure.**

Run: `npx vitest run test/unit/test-boundary.test.ts test/unit/config.test.ts test/unit/model-selector.test.ts`

Expected: FAIL because the current documentation and boundary tests do not mention Codex or its explicit-only configuration isolation.

- [ ] **Step 3: Update README and CLI help text.** Describe only the verified capabilities and limitations. Do not claim a real Codex smoke result, runtime availability, quota availability, or automatic Codex selection.

- [ ] **Step 4: Update boundary tests and smoke labels.** Keep real Codex smoke out of `npm test`; use fixtures/mocks for all new normal tests.

- [ ] **Step 5: Run focused documentation and boundary tests and verify they pass.**

Run: `npx vitest run test/unit/test-boundary.test.ts test/unit/config.test.ts test/unit/model-selector.test.ts`

Expected: PASS with no real provider calls.

### Task 8: Full Verification, Scope Audit, and Local Implementation Commit

**Files:**
- All files listed in Tasks 1-7.
- No `register-worker.ps1`, `unregister-worker.ps1`, Project Ashley path, remote branch, or deployment file.

- [ ] **Step 1: Run the TypeScript build.**

Run: `npm run build`

Expected: exit code 0 with the new generic types, adapter, catalog parser, config guard, and orchestration flow compiling.

- [ ] **Step 2: Run the normal test suite.**

Run: `npm test`

Expected: all normal files/tests pass. Record exact file and test counts. Confirm no real Codex/provider process starts.

- [ ] **Step 3: Run the focused Codex and recovery suites again.**

Run: `npx vitest run test/unit/codex-model-catalog.test.ts test/unit/codex-config-guard.test.ts test/unit/codex-adapter.test.ts test/unit/model-selector.test.ts test/unit/session-policy.test.ts test/integration/recovery-fallback.test.ts`

Expected: PASS with fixture/mock-only execution.

- [ ] **Step 4: Run the repository static searches.**

Run:

```text
rg -n -i "gemini[ -]?flash[ -]?3[.]5|gemini-3[.]5" . --glob '!node_modules/**' --glob '!dist/**'
rg -n "shell:\s*true" src test
rg -n "codex_explicit|codex" src/policy/default-selection-policy.json config.example.json test/unit/model-selector.test.ts
```

Expected: the invalid Gemini reference search has no output; the shell-enabled search has no output; Codex appears only in explicit policy/config/test paths and never in automatic ranking arrays.

- [ ] **Step 5: Run whitespace and staged-scope checks.**

Run: `git diff --check`, `git status --short`, `git diff --stat`, and `git diff --name-only`.

Expected: no whitespace errors and only the approved adapter, generic contract, policy, test, and documentation paths are changed.

- [ ] **Step 6: Stage only the approved implementation paths.**

Use explicit `git add --` paths from Tasks 1-7. Then run:

```text
git diff --cached --name-only
git diff --cached --check
```

Expected: the staged list excludes Project Ashley, startup scripts, real smoke execution changes outside the test boundary, secrets, generated credentials, and unrelated work.

- [ ] **Step 7: Commit the completed local implementation.**

```text
git commit -m "feat: add explicit-only codex cli worker target"
```

Expected: a local commit is created. Do not push, merge, deploy, or register startup.

- [ ] **Step 8: Verify final state and report SOL readiness.**

Run: `git rev-parse HEAD` and `git status --short --branch`.

Expected: report the full final SHA and a clean worktree. The final report MUST include the initial SHA, exact verified executable/version/capabilities, changed files, automatic-selection proof, explicit flow, model selectability/discovery, reasoning topology behavior, config isolation, session identity/resume, fallback/source-effect interaction, availability/quota behavior, exact build/test counts, commits created, real smoke status `NOT RUN`, remaining limitations, and `READY FOR SOL REVIEW: YES`.

## Plan Self-Review

Spec coverage is mapped as follows:

- Explicit-only policy and unchanged rankings: Tasks 1, 5, and 7.
- Exact catalog membership and hidden/non-selectable rejection: Task 2 and Task 5.
- Catalog/runtime/quota separation: Tasks 2, 4, and 5.
- Optional reasoning and ordinary/topology-changing distinction: Tasks 2 and 4.
- User config isolation and project config containment: Task 3 and Task 4.
- Safe sandbox, approval, cwd, stdin, and shell-disabled process execution: Tasks 3 and 4.
- Exact session/resume identity: Tasks 1, 6, and 4.
- Explicit fallbackSelection and source-effect recovery: Tasks 1, 5, and 6.
- Platform-neutral Recovery Capsule: Tasks 2 and 6.
- Generic future Cursor extensibility: Tasks 1, 5, and 6 avoid platform branches in orchestration.
- Fixture/mock-only verification and no real smoke: Tasks 4, 7, and 8.
- Final build, test, diff, scope, commit, and SOL handoff: Task 8.

The plan contains no current Codex model IDs in production policy. Current catalog IDs appear only in the local fixture required to prove dynamic parsing. The installed CLI's rejected `--ignore-user-config` catalog syntax is recorded as a narrow metadata-only exception; every execution/resume path remains explicitly isolated.
