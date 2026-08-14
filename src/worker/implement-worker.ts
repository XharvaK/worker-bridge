import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ImplementResult, ProjectConfig } from '../types.js';
import { WorktreeManager } from '../git/worktree.js';
import { getDiffCheck, isWorkingTreeClean } from '../git/repo-guard.js';
import { AgyAdapter } from './agy-adapter.js';
import { logger } from '../utils/logger.js';
import { sanitizeSecrets } from '../utils/sanitizer.js';

const execFileAsync = promisify(execFile);

export class ImplementWorker {
  private worktreeManager: WorktreeManager;
  private agyAdapter: AgyAdapter;

  constructor(worktreeManager: WorktreeManager, agyAdapter: AgyAdapter) {
    this.worktreeManager = worktreeManager;
    this.agyAdapter = agyAdapter;
  }

  async execute(
    jobId: string,
    projectId: string,
    projectConfig: ProjectConfig,
    baseSha: string,
    goalText: string,
    planText: string,
    reviewText: string,
    shouldPush = true,
    remote = 'origin',
    timeoutSeconds = 1800
  ): Promise<ImplementResult> {
    logger.info(`Starting IMPLEMENT worker for job ${jobId} (Project: ${projectId}, Base: ${baseSha})`);

    const repoPath = projectConfig.path;
    let worktreePath = '';
    let workerBranch = '';

    try {
      // 1. Check CLI availability
      const cliCheck = await this.agyAdapter.checkAgyInstalled();
      if (!cliCheck.installed) {
        return {
          jobId,
          projectId,
          baseSha,
          workerBranch: `worker/${projectId}/${jobId}`,
          filesChanged: [],
          testsRun: false,
          bridgeVerificationPassed: false,
          diffCheckPassed: false,
          dirtyRemaining: false,
          exitCode: 1,
          error: cliCheck.error,
          reportText: `# Implementation Failed: \`${jobId}\`\n\n${cliCheck.error}`,
        };
      }

      // 2. Create isolated worktree
      const created = await this.worktreeManager.createImplementWorktree(repoPath, projectId, jobId, baseSha);
      worktreePath = created.worktreePath;
      workerBranch = created.workerBranch;

      const promptText = `
You are an autonomous implementation worker for project: "${projectId}".

==================================================
1. ORIGINAL IMPLEMENTATION GOAL
==================================================
${goalText}

==================================================
2. GEMINI IMPLEMENTATION PLAN
==================================================
${planText}

==================================================
3. SOL REVIEW & LOCKED CORRECTIONS (HIGHEST PRIORITY)
==================================================
${reviewText}

==================================================
IMPLEMENTATION CONTRACT & INSTRUCTIONS
==================================================
1. Implement the requested code and tests strictly adhering to Sol's locked review corrections.
2. Edit source files ONLY inside this isolated worktree.
3. You do NOT have git push authority. Do not attempt to push branches.
4. Run project verification tests locally to ensure high quality.
5. Leave clean source code ready for authoritative Bridge verification.
`.trim();

      // 3. Worker permission profile (Write isolated worktree only, no network/push/elevation)
      const implementProfile = AgyAdapter.getImplementProfile();

      const runResult = await this.agyAdapter.invokeAgent(
        jobId,
        worktreePath,
        implementProfile,
        promptText,
        timeoutSeconds
      );

      // 4. Authoritative Bridge Verification: Diff Check
      const diffCheck = await getDiffCheck(worktreePath);

      // 5. Authoritative Bridge Verification: Run Tests
      let testOutput = '';
      let testExitCode = 0;
      let testsRun = false;
      let bridgeVerificationPassed = true;

      if (projectConfig.testCommand) {
        testsRun = true;
        try {
          logger.info(`Running authoritative test command: "${projectConfig.testCommand}" in ${worktreePath}`);
          const parts = projectConfig.testCommand.split(' ');
          const cmd = parts[0];
          const args = parts.slice(1);
          const { stdout, stderr } = await execFileAsync(cmd, args, {
            cwd: worktreePath,
            windowsHide: true,
          });
          testOutput = stdout + (stderr ? `\n${stderr}` : '');
          testExitCode = 0;
          bridgeVerificationPassed = true;
        } catch (err: any) {
          testExitCode = err.code ?? 1;
          testOutput = (err.stdout || '') + (err.stderr ? `\n${err.stderr}` : '') + `\n${err.message}`;
          logger.warn(`Authoritative test verification failed with exit code ${testExitCode}`);
          bridgeVerificationPassed = false;
        }
      }

      // 6. Collect modified files
      const { stdout: diffStat } = await execFileAsync('git', ['-C', worktreePath, 'diff', '--stat', baseSha], {
        windowsHide: true,
      });

      const { stdout: statusPorcelain } = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain'], {
        windowsHide: true,
      });

      const filesChanged = statusPorcelain
        .trim()
        .split(/\r?\n/)
        .filter(l => l.trim().length > 0)
        .map(l => l.trim());

      // 7. Bridge commits and optionally pushes (AGY does NOT push)
      const commitRes = await this.worktreeManager.commitAndPushWorkerBranch(
        worktreePath,
        workerBranch,
        `feat(worker): [${jobId}] implementation`,
        shouldPush && projectConfig.allowPushWorkerBranch !== false,
        remote
      );

      const statusAfterCommit = await isWorkingTreeClean(worktreePath);

      const hasFailure = runResult.exitCode !== 0 || !bridgeVerificationPassed || !diffCheck.passed;

      // Build Markdown result report
      const reportText = `
# Implementation Result: \`${jobId}\`

- **Project**: \`${projectId}\`
- **Base SHA**: \`${baseSha}\`
- **Worker Branch**: \`${workerBranch}\`
- **Head SHA**: \`${commitRes.headSha}\`
- **Worker AGY Exit Code**: \`${runResult.exitCode}\`
- **Bridge Test Verification Passed**: \`${bridgeVerificationPassed}\`
- **Diff Check Passed**: \`${diffCheck.passed}\`
- **Remote Branch Pushed**: \`${commitRes.pushed}\`

---

## Changed Files & Diff Stat
\`\`\`text
${diffStat.trim() || 'No changes recorded'}
\`\`\`

---

## Diff Check
\`\`\`text
${diffCheck.passed ? 'PASSED (Clean whitespace and syntax)' : `FAILED:\n${diffCheck.output}`}
\`\`\`

---

## Authoritative Test Verification (${projectConfig.testCommand || 'No automated test command configured'})
- **Tests Executed**: \`${testsRun}\`
- **Test Exit Code**: \`${testExitCode}\`
- **Verification Verdict**: \`${bridgeVerificationPassed ? 'PASSED' : 'FAILED'}\`

\`\`\`text
${sanitizeSecrets(testOutput.trim()) || (testsRun ? 'Tests ran with no output' : 'N/A')}
\`\`\`

---

## Worker Execution Log Summary
\`\`\`text
${sanitizeSecrets(runResult.stdout.slice(-2000).trim() || 'Completed')}
\`\`\`
`.trim();

      return {
        jobId,
        projectId,
        baseSha,
        workerBranch,
        headSha: commitRes.headSha,
        filesChanged,
        testsRun,
        testOutput: sanitizeSecrets(testOutput),
        testExitCode,
        bridgeVerificationPassed,
        diffCheckPassed: diffCheck.passed,
        dirtyRemaining: !statusAfterCommit.clean,
        exitCode: hasFailure ? 1 : 0,
        error: hasFailure
          ? (!bridgeVerificationPassed
              ? `Authoritative test verification failed (Exit Code: ${testExitCode})`
              : (runResult.exitCode !== 0
                  ? `AGY process exited with code ${runResult.exitCode}`
                  : `Diff check failed: ${diffCheck.output}`))
          : undefined,
        reportText,
      };
    } catch (err: any) {
      logger.error(`Exception during IMPLEMENT execution for job ${jobId}: ${err.message || String(err)}`);
      return {
        jobId,
        projectId,
        baseSha,
        workerBranch: workerBranch || `worker/${projectId}/${jobId}`,
        filesChanged: [],
        testsRun: false,
        bridgeVerificationPassed: false,
        diffCheckPassed: false,
        dirtyRemaining: false,
        exitCode: 1,
        error: `Exception during implementation: ${err.message || String(err)}`,
        reportText: `# Implementation Failed: \`${jobId}\`\n\nError: ${err.message || String(err)}`,
      };
    } finally {
      if (worktreePath) {
        await this.worktreeManager.forceCleanupWorktree(repoPath, worktreePath);
      }
    }
  }
}
