import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AntigravityAdapter, DEFAULT_AGY_PATH } from '../../src/worker/agy-adapter.js';
import { OpenCodeAdapter } from '../../src/worker/opencode-adapter.js';
import { ProcessManager } from '../../src/engine/process-manager.js';
import { WorktreeManager } from '../../src/git/worktree.js';
import { PlanWorker } from '../../src/worker/plan-worker.js';
import { ImplementWorker } from '../../src/worker/implement-worker.js';

const execFileAsync = promisify(execFile);

// This file is opt-in through `npm run test:real-smoke` and is excluded from `npm test`.
// Codex real smoke is intentionally absent and requires separate authorization.
describe('Opt-in Real Provider Smoke Tests (Disposable Fixture)', () => {
  let tmpBaseDir: string;
  let targetRepoDir: string;
  let workersDir: string;
  let targetBaseSha: string;
  const processManager = new ProcessManager();

  beforeEach(async () => {
    tmpBaseDir = path.join(
      os.tmpdir(),
      `test-real-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    targetRepoDir = path.join(tmpBaseDir, 'target-project');
    workersDir = path.join(tmpBaseDir, 'workers');

    fs.mkdirSync(targetRepoDir, { recursive: true });
    fs.mkdirSync(workersDir, { recursive: true });

    // Initialize fixture git repo
    await execFileAsync('git', ['init'], { cwd: targetRepoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'SmokeTester'], {
      cwd: targetRepoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.email', 'smoketester@local'], {
      cwd: targetRepoDir,
      windowsHide: true,
    });

    fs.writeFileSync(
      path.join(targetRepoDir, 'README.md'),
      '# Smoke Test Fixture Project\nMath operations and utilities.\n'
    );
    fs.writeFileSync(
      path.join(targetRepoDir, 'math.js'),
      'export function add(a, b) {\n  return a + b;\n}\n'
    );
    await execFileAsync('git', ['add', '.'], { cwd: targetRepoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'Initial commit for smoke testing'], {
      cwd: targetRepoDir,
      windowsHide: true,
    });

    const { stdout: shaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: targetRepoDir,
      windowsHide: true,
    });
    targetBaseSha = shaOut.trim();
  });

  afterEach(() => {
    if (fs.existsSync(tmpBaseDir)) {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('SMOKE A: Antigravity + Gemini 3.7 Flash High READ_ONLY plan (fresh session)', async () => {
    const agyAdapter = new AntigravityAdapter(DEFAULT_AGY_PATH, 'gemini-3.7-flash-high', processManager);
    const env = await agyAdapter.inspectEnvironment();
    if (!env.installed) {
      console.warn('AGY not installed in environment, skipping live smoke A');
      return;
    }

    const worktreeManager = new WorktreeManager(workersDir);
    const planWorker = new PlanWorker(worktreeManager, agyAdapter);

    const result = await planWorker.execute(
      'smoke-agy-plan-001',
      'smokeproj',
      targetRepoDir,
      targetBaseSha,
      'Analyze math.js and create a 3-bullet plan to add a subtract function.',
      120
    );

    expect(result.clean).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.planText.length).toBeGreaterThan(10);
  }, 180000);

  it('SMOKE B: OpenCode READ_ONLY plan (fresh session)', async () => {
    const opencodeAdapter = new OpenCodeAdapter('opencode', 'opencode/deepseek-v4-flash-free', processManager);
    const env = await opencodeAdapter.inspectEnvironment();
    if (!env.installed) {
      console.warn('OpenCode not installed in environment, skipping live smoke B');
      return;
    }

    const worktreeManager = new WorktreeManager(workersDir);
    const planWorker = new PlanWorker(worktreeManager, opencodeAdapter);

    const result = await planWorker.execute(
      'smoke-opencode-plan-001',
      'smokeproj',
      targetRepoDir,
      targetBaseSha,
      'Briefly inspect math.js and propose adding multiply(a, b).',
      120,
      opencodeAdapter,
      'opencode/deepseek-v4-flash-free',
      'max'
    );

    expect(result.clean).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.planText.length).toBeGreaterThan(10);
  }, 180000);

  it('SMOKE C: OpenCode CONTINUE read-only session with a correction', async () => {
    const opencodeAdapter = new OpenCodeAdapter('opencode', 'opencode/deepseek-v4-flash-free', processManager);
    const env = await opencodeAdapter.inspectEnvironment();
    if (!env.installed) return;

    const worktreeManager = new WorktreeManager(workersDir);
    const planWorker = new PlanWorker(worktreeManager, opencodeAdapter);

    // Initial query
    const res1 = await planWorker.execute(
      'smoke-opencode-cont-001',
      'smokeproj',
      targetRepoDir,
      targetBaseSha,
      'What functions are in math.js? Give a 1-sentence answer.',
      120,
      opencodeAdapter,
      'opencode/deepseek-v4-flash-free',
      'max'
    );

    expect(res1.exitCode).toBe(0);

    // Continuation query
    const res2 = await planWorker.execute(
      'smoke-opencode-cont-002',
      'smokeproj',
      targetRepoDir,
      targetBaseSha,
      'Now suggest 1 test case for it.',
      120,
      opencodeAdapter,
      'opencode/deepseek-v4-flash-free',
      'max',
      res1.sessionId
    );

    expect(res2.exitCode).toBe(0);
    expect(res2.planText.length).toBeGreaterThan(10);
  }, 240000);

  it('SMOKE D: Cross-platform Antigravity Plan -> OpenCode Implementation', async () => {
    const agyAdapter = new AntigravityAdapter(DEFAULT_AGY_PATH, 'gemini-3.7-flash-high', processManager);
    const opencodeAdapter = new OpenCodeAdapter('opencode', 'opencode/deepseek-v4-flash-free', processManager);

    const agyEnv = await agyAdapter.inspectEnvironment();
    const openEnv = await opencodeAdapter.inspectEnvironment();
    if (!agyEnv.installed || !openEnv.installed) return;

    const worktreeManager = new WorktreeManager(workersDir);
    const planWorker = new PlanWorker(worktreeManager, agyAdapter);
    const implementWorker = new ImplementWorker(worktreeManager, opencodeAdapter);

    // 1. Antigravity Plan
    const planRes = await planWorker.execute(
      'smoke-cross-001',
      'smokeproj',
      targetRepoDir,
      targetBaseSha,
      'Plan to add export function multiply(a, b) { return a * b; } to math.js.',
      120
    );
    expect(planRes.exitCode).toBe(0);

    // 2. OpenCode Implementation
    const impRes = await implementWorker.execute(
      'smoke-cross-001',
      'smokeproj',
      {
        path: targetRepoDir,
        allowed: true,
        defaultBranch: 'master',
        allowPushWorkerBranch: false,
      },
      targetBaseSha,
      'Add multiply function to math.js',
      planRes.planText,
      'Approved: Add export function multiply(a, b) { return a * b; } to math.js',
      false,
      'origin',
      180,
      opencodeAdapter,
      'opencode/deepseek-v4-flash-free',
      'max'
    );

    expect(impRes.exitCode).toBe(0);
    expect(impRes.bridgeVerificationPassed).toBe(true);
    expect(impRes.diffCheckPassed).toBe(true);

    // Verify commit in worker branch
    const { stdout: diffOut } = await execFileAsync(
      'git',
      ['-C', targetRepoDir, 'diff', `${targetBaseSha}..${impRes.workerBranch}`],
      { windowsHide: true }
    );
    expect(diffOut.length).toBeGreaterThan(0);
  }, 300000);
});
