# Gemini Worker Bridge (`gemini-worker-bridge`)

A lightweight, secure, local development bridge connecting **ChatGPT / Sol** (Architect & Adversarial Reviewer) to **Google Antigravity / Gemini Flash High** (Headless Implementation Worker) via a private GitHub mailbox repository, with **zero Codex quota use**.

---

## Key Principles & Guardrails

1. **Doc is not the message bus**: Asynchronous handoffs are managed automatically via the GitHub mailbox repository.
2. **Zero Codex quota**: All implementation work is routed to the official Antigravity CLI (`agy`) using existing authenticated Google quota.
3. **Official Antigravity CLI Substrate**: Targets the official standalone `agy` CLI (`-p`, `--cwd`, `--model`, `--sandbox`, fine-grained permissions) rather than IDE-internal interfaces (`agentapi.bat`).
4. **Antigravity Permissions as Real Tool Boundary**:
   - **PLAN Mode**: Preventative write denial (`--permission:fs:write=deny`, tools write denied) + detached disposable worktree + pre/post index check.
   - **IMPLEMENT Mode**: Filesystem writes strictly scoped to the isolated worker worktree. Elevation, SSH, deployment, and git push tools are strictly denied.
5. **AGY Has No Git Push Authority**: AGY implementation authority ends inside the isolated worktree. The **Bridge owns Git commits and pushes**, ensuring model output is not source promotion authority.
6. **Authoritative Bridge Test Verification**: `IMPLEMENTATION_READY` is granted exclusively on bridge-observed test execution. If the model claims tests pass but bridge execution fails, the state transitions to `FAILED`.
7. **Interrupted Means Preserve Evidence**: On bridge crash or restart, in-flight jobs become `INTERRUPTED` without blind re-execution. The worktree, branch, logs, and modified files are preserved for inspection.
8. **No Auto-Resolution of Semantic Mailbox Conflicts**: If a Git rebase conflict occurs on the mailbox, the bridge aborts the rebase, preserves local state, marks the job `BLOCKED` (`mailbox_git_conflict`), and requests human/Sol resolution.
9. **Network Boundary Clarity**: The Bridge directly performs network operations only for configured GitHub mailbox/repo transport. AGY communicates with Google's Antigravity service via its authenticated CLI substrate. Tool-level web access is governed by AGY permission policies.
10. **Zero Antigravity Credential Handling**: The bridge never reads, copies, logs, or persists Antigravity authentication tokens.

---

## Directory Structure

```
gemini-worker-bridge/
├── config.example.json            # Template for local config
├── register-worker.ps1            # User Scheduled Task installer (no admin)
├── unregister-worker.ps1          # Scheduled Task uninstaller
├── src/
│   ├── index.ts                   # CLI entrypoint (start, run-once, status, cancel)
│   ├── config.ts                  # Configuration and allowlist manager
│   ├── types.ts                   # Core interfaces and schema definitions
│   ├── engine/
│   │   ├── orchestrator.ts        # Master polling and dispatch loop
│   │   ├── ledger.ts              # Persistent idempotency and crash ledger
│   │   └── process-manager.ts     # Process spawning, tree kill, timeouts
│   ├── worker/
│   │   ├── agy-adapter.ts         # Official Antigravity CLI invocation adapter
│   │   ├── plan-worker.ts         # Preventative read-only PLAN worker
│   │   └── implement-worker.ts    # Authoritative test-verified IMPLEMENT worker
│   ├── git/
│   │   ├── worktree.ts            # Git worktree lifecycle management
│   │   └── repo-guard.ts          # Branch protection and SHA validation
│   ├── mailbox/
│   │   ├── parser.ts              # Job schema parsing & validation
│   │   ├── transport.ts           # Mailbox git fetch/pull/rebase/push (safe abort on conflict)
│   │   └── syncer.ts              # Mailbox artifact reader/writer
│   └── utils/
│       ├── logger.ts              # Redacted structured logger
│       ├── sanitizer.ts           # Token and secret scrubber
│       └── notifier.ts            # Windows Toast notification helper
└── test/                          # Unit and integration test suites
```

---

## Quick Setup

1. **Official AGY CLI**:
   - Ensure the official Antigravity CLI (`agy`) is installed and authenticated.
   - Run `agy models` to discover available model identifiers (e.g. `gemini-2.5-flash` or `gemini-3.7-flash`).

2. **Clone or create your private mailbox repository on GitHub**:
   - Repository name: `gemini-worker-mailbox` (Private)
   - Clone locally to `C:\Users\Xharv\Projects\gemini-worker-mailbox`.

3. **Configure the Bridge**:
   - Copy `config.example.json` to `config.json`:
     ```bash
     copy config.example.json config.json
     ```
   - Verify paths in `config.json`:
     ```json
     {
       "mailboxRepoPath": "C:\\Users\\Xharv\\Projects\\gemini-worker-mailbox",
       "workerRootDir": "C:\\Users\\Xharv\\Projects\\.workers",
       "agyExecutable": "agy",
       "workerModel": "gemini-2.5-flash",
       "pushWorkerBranches": true,
       "notificationsEnabled": true,
       "allowedProjects": {
         "ashley": {
           "path": "C:\\Users\\Xharv\\Projects\\composer-assistant",
           "allowed": true,
           "defaultBranch": "master",
           "allowPushWorkerBranch": true,
           "testCommand": "npm test"
         }
       }
     }
     ```

4. **Build & Test the Project**:
   ```bash
   npm run build
   npm test
   ```

5. **Start the Bridge**:
   ```bash
   npm start
   ```
