# Worker Bridge (`worker-bridge`)

A lightweight, secure, local development bridge connecting **Doc** and a **northbound orchestrator** (primary: ChatGPT through the DevSpace-WB gateway; also supported: Cursor Agent / Grok 4.6) to multi-platform headless AI workers across five CLI provider families:
1. **OpenAI Codex CLI** (`codex`): `luna-max` (`gpt-5.6-luna`, Priority #1 for WORKER) and explicit-only discovered models (`codex_explicit`)
2. **Google Antigravity CLI** (`agy`): `gemini-3.7-flash-high` (Gemini Flash 3.7 High)
3. **Cursor CLI** (`cursor-cli`): `cursor-grok-4.6-xhigh`, `cursor-grok-4.6-medium`
4. **Freebuff** (`freebuff`): `freebuff_default` (provider-managed default, Priority #4 for WORKER)
5. **OpenCode CLI** (`opencode`): `nemotron-3.5-lightning`, `deepseek-v4-flash-max`, `hy3-high`, `laguna-s-2.1-high`, `nemotron-3-ultra`

---

## Core Architecture & Authority Boundaries

```
                           DOC (Human Owner)
                                  |
                                  v
                  Northbound Orchestrator
        (ChatGPT via DevSpace-WB gateway; Cursor Agent also supported)
                                  |
                                  | MCP (JSON-RPC) / IPC (named pipe)
                                  v
                            WORKER BRIDGE
           /          /           |           \            \
          v          v            v            v            v
    CodexAdapter AgyAdapter CursorAdapter FreebuffAdapter OpenCodeAdapter
          |          |            |            |            |
          v          v            v            v            v
      Codex CLI   AGY CLI     Cursor CLI    Freebuff     OpenCode CLI
```

### Selection Capability vs. Current MCP Execution Capability

Worker Bridge maintains a strict separation between **selection policy** (which model/platform is ranked highest when execution is authorized) and **execution authority** (which execution modes are permitted over a specific interface):

- **Selection Primaries (Active Policy)**:
  - `INVESTIGATOR` Primary: `Cursor CLI / Grok 4.6 XHigh` (`cursor-grok-4.6-xhigh`)
  - `WORKER` Primary: `Codex CLI / Luna Max` (`gpt-5.6-luna`, reasoning: `max`)
  - `REVIEWER` Primary: `OpenCode CLI / Nemotron 3.5 Lightning` (`opencode/nemotron-3.5-lightning-free`)

- **Current MCP Execution Capability** (same fail-closed surface over both the Cursor MCP interface and the DevSpace-WB northbound gateway):
  - `READ_ONLY` (`plan`, `design`, `investigate`, `review`, `audit`): **Fully available and executable over MCP**. Runs safely in isolated plan worktrees with mechanical read-only modes.
  - `WORKTREE_WRITE` (`implement`, `fix`): **Blocked fail-closed over MCP with `OWNER_AUTHORITY_UNAVAILABLE`**. The WORKER ranking is active selection policy, but source-writing delegation from a northbound orchestrator remains unavailable until Worker Bridge has authenticated owner authority.

---

## Core Principles & Law

1. **Workflow Ownership**: The workflow belongs to Doc (the human operator). The northbound orchestrator (ChatGPT through the DevSpace-WB gateway, or Cursor Agent) plans and coordinates tasks. AI outputs and assistant recommendations do not constitute owner authorization.
2. **Core Invariants**:
   - `WORKER PLATFORM != WORKFLOW`
   - `MODEL != AUTHORITY`
   - `MODEL OUTPUT != OWNER APPROVAL`
   - `MODEL OUTPUT != SOURCE PROMOTION AUTHORITY`
   - `GITHUB MAILBOX != AUTHORITY`
   - `LOCAL BRIDGE CONFIG OWNS LOCAL EXECUTION AUTHORITY`
   - `READ-ONLY DISPATCH != WRITE AUTHORITY`
3. **No Internal Planner Role**: Worker Bridge target execution roles are strictly:
   - `INVESTIGATOR` (intents: `plan`, `design`, `investigate`)
   - `WORKER` (intents: `implement`, `fix`)
   - `REVIEWER` (intents: `review`, `audit`)
4. **Surface Separation & Lineage Recursion Protection**:
   - `cursor-agent` = northbound orchestrator surface (injected by trusted MCP server boundary; cannot be selected as a downstream worker).
   - `cursor-cli` = downstream worker execution surface (`platformId: 'cursor-cli'`).
   - Lineage markers (`WORKER_BRIDGE_PARENT_JOB_ID`, `WORKER_BRIDGE_EXECUTION_DEPTH`, `WORKER_BRIDGE_EXECUTION_CONTEXT`) are injected into all spawned child processes to fail closed against nested MCP re-entry.
5. **Highest Reasoning Default**:
   - Discovered models default to their highest supported ordinary reasoning profile unless explicitly overridden.
6. **Opus Policy**:
   - Claude Opus (`claude-opus-4-6-thinking`) is strictly **`EXPLICIT_ONLY`** to preserve quota. Excluded from all automatic rankings and fallbacks.
7. **Authoritative Bridge Verification**:
   - `IMPLEMENTATION_READY` is granted exclusively on bridge-observed test execution and clean diff checks. Model prose is never accepted as verification evidence.
8. **Codex Policy**:
   - Codex supports exact semantic targets (`codex_luna_max` in WORKER, `gpt-5.6-luna` with explicit `max` reasoning) and explicit-only discovered targets (`codex_explicit` with `modelBinding: EXPLICIT_DISCOVERED`).
   - Discovery uses only `codex debug models --bundled` for the bundled read-only catalog. Hidden or non-selectable models fail closed with `MODEL_NOT_SELECTABLE`.
   - Execution uses `--ignore-user-config`. Project `.codex/config.toml` is authority-checked and capability-expanding configs are rejected as `PERMISSION_BLOCKED`.

---

## Supported Worker Platforms

### 1. Antigravity (`agy`)
- CLI: Official `agy.exe` (`1.1.13+`)
- Execution: `-p <prompt> --model <model> --effort high --mode <plan|accept-edits> --sandbox --add-dir <cwd>`
- Models: `gemini-3.7-flash-high` (Gemini Flash 3.7 High), `gemini-3.6-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking` (explicit only).

### 2. OpenCode (`opencode`)
- CLI: Official OpenCode CLI (`1.18.15+`)
- Execution: `opencode run "<prompt>" --dir "<cwd>" -m "<provider/model>" --variant "<variant>" --format json --auto`
- Models: `opencode/nemotron-3.5-lightning-free`, `opencode/deepseek-v4-flash-free` (variant: `max`), `opencode/hy3-free` (variant: `high`), `opencode/laguna-s-2.1-free` (variant: `high`), `opencode/nemotron-3-ultra-free`.

### 3. Cursor CLI (`cursor-cli`)
- CLI: Official Cursor Agent CLI (`2026.08.11+`)
- Execution: `cursor-agent -p --output-format text --workspace <cwd> --model <model> [--mode ask]`
- Models: `cursor-grok-4.6-xhigh`, `cursor-grok-4.6-medium`, `cursor-grok-4.6-high`. Native direct execution via bundled binary without `cmd.exe` or `shell=true`.

### 4. Codex CLI (`codex`) — explicit-only & Luna Max
- Targets:
  - `codex_luna_max`: ranked #1 in `WORKER` role policy (`gpt-5.6-luna` with explicit `max` effort).
  - `codex_explicit`: explicit-only dynamic target with `modelBinding: EXPLICIT_DISCOVERED`. Absent from automatic rankings, automatic fallback, cooldown reranking, and reviewer diversification.
- Discovery: the adapter uses only `codex debug models --bundled` for the bundled read-only catalog. Hidden or non-selectable models fail closed with `MODEL_NOT_SELECTABLE`.
- Reasoning: omitted reasoning selects the highest discovered `ORDINARY` native profile. An explicit profile must be discovered with known topology.
- Execution and resume: worker execution and exact-session resume use `--ignore-user-config`. The bridge binds the model, native reasoning, worktree/cwd, sandbox, and approval mode.
- Configuration: bounded project `.codex/config.toml` authority inspection rejects unknown, unparsable, or capability-expanding configuration as `PERMISSION_BLOCKED`.

### 5. Freebuff (`freebuff`)
- CLI: Official Freebuff CLI (`0.0.149+`)
- Target: `freebuff_default` (`modelBinding: PROVIDER_MANAGED`, `reasoning: provider-managed`).
- Role: `WORKER` only (ineligible for `INVESTIGATOR` and `REVIEWER` due to lack of mechanical read-only enforcement).
- Automatic Ranking: #4 in `WORKER` selection policy.
- Qualification Status: Currently qualifies as `UNAVAILABLE` (`AUTOMATION_SEAM_UNAVAILABLE`) because installed/upstream Freebuff CLI provides an interactive TUI only and lacks a supported non-interactive task-delivery seam.
- Re-qualification: Unavailability is recorded as a bounded cooldown; the provider is mechanically re-probed on a 30-minute window so stale unavailability does not suppress Freebuff forever. Re-probing runs the current capability detection only — the adapter still needs future implementation to detect and use a real automation seam when upstream Freebuff exposes one.
- Fallback Behavior: When unavailable, selection gracefully falls through to #5 `OpenCode Nemotron 3.5 Lightning`.
- Explicit Selection: Allowed, surfaces `AUTOMATION_SEAM_UNAVAILABLE` fail-closed error without false claims of execution.

---

## Locked Final Rankings

### INVESTIGATOR (Read-Only: plan / design / investigate)
1. `Cursor CLI — Grok 4.6 XHigh` (`cursor_grok_46_xhigh` -> `cursor-grok-4.6-xhigh`)
2. `OpenCode CLI — Nemotron 3.5 Lightning` (`opencode_nemotron_35_lightning`)
3. `OpenCode CLI — DeepSeek V4 Flash Max` (`opencode_deepseek_v4_flash_max`)
4. `Antigravity CLI — Gemini Flash 3.7 High` (`agy_gemini_flash_37_high`)
5. `OpenCode CLI — HY3 High` (`opencode_hy3_high`)
6. `OpenCode CLI — Laguna S 2.1 High` (`opencode_laguna_s_21_high`)
7. `OpenCode CLI — Nemotron 3 Ultra` (`opencode_nemotron_3_ultra`)

### WORKER (Source-Writing: implement / fix)
1. `Codex CLI — Luna Max` (`codex_luna_max` -> `gpt-5.6-luna` / `max`)
2. `Antigravity CLI — Gemini Flash 3.7 High` (`agy_gemini_flash_37_high`)
3. `Cursor CLI — Grok 4.6 Medium` (`cursor_grok_46_medium` -> `cursor-grok-4.6-medium`)
4. `Freebuff — provider-managed default` (`freebuff_default` -> provider-managed default)
5. `OpenCode CLI — Nemotron 3.5 Lightning` (`opencode_nemotron_35_lightning`)
6. `OpenCode CLI — DeepSeek V4 Flash Max` (`opencode_deepseek_v4_flash_max`)
7. `OpenCode CLI — HY3 High` (`opencode_hy3_high`)
8. `OpenCode CLI — Laguna S 2.1 High` (`opencode_laguna_s_21_high`)
9. `OpenCode CLI — Nemotron 3 Ultra` (`opencode_nemotron_3_ultra`)

### REVIEWER (Read-Only: review / audit)
1. `OpenCode CLI — Nemotron 3.5 Lightning` (`opencode_nemotron_35_lightning`)
2. `Cursor CLI — Grok 4.6 XHigh` (`cursor_grok_46_xhigh` -> `cursor-grok-4.6-xhigh`)
3. `Antigravity CLI — Gemini Flash 3.7 High` (`agy_gemini_flash_37_high`)
4. `OpenCode CLI — HY3 High` (`opencode_hy3_high`)
5. `OpenCode CLI — DeepSeek V4 Flash Max` (`opencode_deepseek_v4_flash_max`)
6. `OpenCode CLI — Nemotron 3 Ultra` (`opencode_nemotron_3_ultra`)
7. `OpenCode CLI — Laguna S 2.1 High` (`opencode_laguna_s_21_high`)

---

## Running Worker Bridge

### Runtime Architecture: transports are thin, execution is shared

The READ_ONLY execution path (role derivation, target selection with fallback, worker invocation, mechanical read-only verification, recovery capsules) is implemented exactly once in the **execution kernel** (`src/engine/read-only-kernel.ts`). Transports do not reimplement it:

- `serve` (durable IPC service) owns durable job records, a single-flight serial queue, cancellation, and target availability state; it delegates all READ_ONLY execution to the kernel.
- `start` (mailbox daemon) publishes execution outcomes into the mailbox ledger and coordinates review checkpoints; its READ_ONLY branch is kernel-driven as well.
- `WORKTREE_WRITE` execution remains in the orchestrator until the write path is unified; the kernel and transport boundaries are documented in code so that unification does not duplicate fallback or verification behavior.

Cancellation, process tracking, and process-tree termination share one `ProcessManager` per service — adapters and the kernel never spawn processes outside it.

### Mode A: Durable Background Service + MCP Interfaces

1. **Start the durable background service**:
   ```bash
   node dist/index.js serve
   ```
   Listens on local Windows Named Pipe `\\.\pipe\worker-bridge-<username>` (or Unix domain socket).

2. **Configure a northbound MCP client** (for example the DevSpace-WB gateway, or Cursor IDE):
   Add to `~/.cursor/mcp.json` or project `.cursor/mcp.json` for Cursor:
   ```json
   {
     "mcpServers": {
       "worker-bridge": {
         "command": "node",
         "args": ["C:/Users/Xharv/Projects/worker-bridge/dist/index.js", "mcp-stdio"]
       }
     }
   }
   ```

3. **Authority Boundaries in MCP v2**:
   - `READ_ONLY` tasks (`plan`, `design`, `investigate`, `audit`, `review`) execute immediately in isolated worktrees.
   - `WORKTREE_WRITE` tasks (`implement`, `fix`) fail closed with `OWNER_AUTHORITY_UNAVAILABLE`. Use Mode B for write operations.

### Mode B: Continuous GitHub Mailbox Daemon (Owner-Authorized Write Mode)

```bash
node dist/index.js start
```

---

## Testing

```bash
npm run build
npm test
```

Codex real-provider smoke is not part of `npm test` and is not run automatically. The opt-in `test:real-smoke` path remains separate and requires separate operator authorization.
