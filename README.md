# Worker Bridge (`worker-bridge`)

A lightweight, secure, local development bridge connecting **Doc / Sol** (ChatGPT / Architect & Adversarial Reviewer) to multi-platform headless AI workers (**Google Antigravity** and **OpenCode**) via a private GitHub mailbox repository.

---

## Core Architecture & Law

```
                   DOC + SOL
                      |
                      v
                WORKER BRIDGE
                 /          \
                /            \
      AntigravityAdapter    OpenCodeAdapter
             |                    |
             v                    v
            AGY                OpenCode CLI
             |                    |
             v                    v
       selected model        selected model
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
   - Models default to their highest supported reasoning profile (`--effort high` for AGY, `--variant max` / `high` for OpenCode) unless explicitly overridden.
5. **Opus Policy**:
   - Claude Opus (`claude-opus-4-6-thinking`) is strictly **`EXPLICIT_ONLY`** to preserve quota. Excluded from all automatic rankings and fallbacks.
6. **Authoritative Bridge Verification**:
   - `IMPLEMENTATION_READY` is granted exclusively on bridge-observed test execution and diff checks. Model prose is never accepted as verification evidence.

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
