# Worker Bridge (`worker-bridge`)

A lightweight, secure, local development bridge connecting **Doc / Sol** (ChatGPT / Architect & Adversarial Reviewer) to multi-platform headless AI workers (**Google Antigravity**, **OpenCode**, and explicit-only **Codex CLI**) via a private GitHub mailbox repository.

---

## Core Architecture & Law

```
                   DOC + SOL
                      |
                      v
                WORKER BRIDGE
                 /          \
                /            \
      AntigravityAdapter    OpenCodeAdapter       CodexAdapter
             |                    |              (explicit-only)
             v                    v                    v
            AGY                OpenCode CLI        Codex CLI
             |                    |                    |
             v                    v                    v
       selected model        selected model       exact selected model
```

1. **Workflow Ownership**: The JOB belongs to Sol/Doc. Worker platforms and models are replaceable execution substrates.
2. **Core Invariants**:
   - `WORKER PLATFORM != WORKFLOW`
   - `MODEL != AUTHORITY`
   - `MODEL OUTPUT != OWNER APPROVAL`
   - `MODEL OUTPUT != SOURCE PROMOTION AUTHORITY`
   - `GITHUB MAILBOX != AUTHORITY`
   - `LOCAL BRIDGE CONFIG OWNS LOCAL EXECUTION AUTHORITY`
   - `READ-ONLY DISPATCH != WRITE AUTHORITY`
3. **Owner Approval Gate**:
   - `READ_ONLY` mode (`plan`, `design`, `investigate`, `review`, `audit`) is authorized directly by initial dispatch.
   - `WORKTREE_WRITE` mode (`implement`, `fix`) strictly requires explicit owner approval (`ownerApproval: { approved: true }`).
4. **Highest Reasoning Default**:
   - AGY and OpenCode use their existing highest supported profiles unless explicitly overridden. An explicit Codex model with omitted reasoning resolves to the highest discovered ordinary native profile. Unknown topology fails closed.
5. **Opus Policy**:
   - Claude Opus (`claude-opus-4-6-thinking`) is strictly **`EXPLICIT_ONLY`** to preserve quota. Excluded from all automatic rankings and fallbacks.
6. **Authoritative Bridge Verification**:
   - `IMPLEMENTATION_READY` is granted exclusively on bridge-observed test execution and diff checks. Model prose is never accepted as verification evidence.
7. **Codex Policy**:
   - Codex is **explicit-only**. It is absent from automatic rankings, automatic fallback, cooldown reranking, and reviewer diversification. Catalog validity does not prove authentication, runtime availability, account access, or quota.

---

## Supported Worker Platforms

### 1. Antigravity (`agy`)
- CLI: Official `agy.exe` (`1.1.13+`)
- Execution: `-p <prompt> --model <model> --effort high --mode <plan|accept-edits> --sandbox --add-dir <cwd>`
- Models: `gemini-3.7-flash-high`, `gemini-3.6-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking` (explicit only).

### 2. OpenCode (`opencode`)
- CLI: Official OpenCode CLI (`1.18.15+`)
- Execution: `opencode run "<prompt>" --dir "<cwd>" -m "<provider/model>" --variant "<variant>" --format json --auto`
- Models: `opencode/deepseek-v4-flash-free` (variant: `max`), `opencode/hy3-free` (variant: `high`), `opencode/laguna-s-2.1-free` (variant: `high`), `opencode/nemotron-3.5-lightning-free`, `opencode/nemotron-3-ultra-free`, `mistral/*`.

### 3. Codex CLI (`codex`) — explicit-only
- Target: policy alias `codex_explicit` with `modelBinding: EXPLICIT_DISCOVERED`; no current Codex model ID is hardcoded in policy.
- Explicit request: provide the Codex platform and the exact catalog model ID, for example:
  ```json
  { "targetId": "codex_explicit", "platform": "codex", "model": "<exact-discovered-model>" }
  ```
  A raw model ID without an explicit Codex platform, target, or alias does not trigger Codex discovery.
- Discovery: the adapter uses only `codex debug models --bundled` for the bundled read-only catalog. Exact catalog membership and user selectability are separate from authentication, runtime availability, and quota. Hidden or non-selectable models fail closed with `MODEL_NOT_SELECTABLE`.
- Reasoning: omitted reasoning selects the highest discovered `ORDINARY` native profile. An explicit profile must be discovered with known topology. Topology-changing reasoning requires an explicit request and authority-envelope proof; the adapter fails closed when that proof is unavailable.
- Execution and resume: worker execution and exact-session resume use `--ignore-user-config`. The bridge binds the model, native reasoning, worktree/cwd, sandbox, and approval mode. Resume is allowed only with an exact session ID and matching platform, model, reasoning, worktree, execution mode, and authority context. `resume --last` and session-ID inference from prose are not used.
- Configuration: bounded project `.codex/config.toml` authority inspection rejects unknown, unparsable, or capability-expanding configuration as `PERMISSION_BLOCKED`. The bridge does not copy, edit, or persist Codex credentials or configuration.
- Fallback: Codex can run only through an explicit, bounded `fallbackSelection`. No automatic fallback can select it. After `WORKTREE_WRITE` source effects, all fallback stops and the existing Recovery Capsule/recovery authorization path remains authoritative.

---

## Rankings

### Locked Planner Ranking (Read-Only: plan / investigate / review)
1. `Gemini Flash 3.7 High` (`antigravity`)
2. `DeepSeek V4 Flash Max` (`opencode`)
3. `HY3 High` (`opencode`)
4. `Laguna S 2.1 High` (`opencode`)
5. `Nemotron 3 Ultra` (`opencode`)
6. `Nemotron 3.5 Lightning` (`opencode`)

### Locked Worker Ranking (Source-Writing: implement / fix)
1. `Gemini Flash 3.7 High` (`antigravity`)
2. `Nemotron 3.5 Lightning` (`opencode`)
3. `DeepSeek V4 Flash Max` (`opencode`)
4. `HY3 High` (`opencode`)
5. `Laguna S 2.1 High` (`opencode`)
6. `Nemotron 3 Ultra` (`opencode`)

---

## Quick Setup

1. **Configure the Bridge**:
   - Copy `config.example.json` to `config.json`.
   - Update repository paths in `config.json`.

2. **Build & Test**:
   ```bash
   npm run build
   npm test
   ```

3. **Start the Bridge**:
   ```bash
   npm start
   ```

Codex real-provider smoke is not part of `npm test` and was not run for this implementation. The opt-in `test:real-smoke` path remains separate and requires separate authorization.
