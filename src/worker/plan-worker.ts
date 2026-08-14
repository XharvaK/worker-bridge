import { PlanResult } from '../types.js';
import { WorktreeManager } from '../git/worktree.js';
import { isWorkingTreeClean } from '../git/repo-guard.js';
import { AgyAdapter } from './agy-adapter.js';
import { logger } from '../utils/logger.js';

export class PlanWorker {
  private worktreeManager: WorktreeManager;
  private agyAdapter: AgyAdapter;

  constructor(worktreeManager: WorktreeManager, agyAdapter: AgyAdapter) {
    this.worktreeManager = worktreeManager;
    this.agyAdapter = agyAdapter;
  }

  async execute(
    jobId: string,
    projectId: string,
    repoPath: string,
    baseSha: string,
    goalText: string,
    timeoutSeconds = 900
  ): Promise<PlanResult> {
    logger.info(`Starting PLAN worker for job ${jobId} (Project: ${projectId}, Base: ${baseSha})`);

    let worktreePath = '';
    try {
      // 1. Check CLI availability
      const cliCheck = await this.agyAdapter.checkAgyInstalled();
      if (!cliCheck.installed) {
        return {
          jobId,
          projectId,
          baseSha,
          model: this.agyAdapter.getModel(),
          planText: '',
          exitCode: 1,
          clean: true,
          mutatedFiles: [],
          error: cliCheck.error,
        };
      }

      // 2. Create isolated detached worktree
      worktreePath = await this.worktreeManager.createPlanWorktree(repoPath, projectId, jobId, baseSha);

      const promptText = `
You are an autonomous implementation planning worker for project: "${projectId}".

==================================================
IMPLEMENTATION GOAL
==================================================
${goalText}

==================================================
CRITICAL OPERATIONAL RULES
==================================================
1. INVESTIGATE the repository codebase to understand all relevant architecture, dependencies, and file structures.
2. PRODUCE a comprehensive, code-aware implementation plan.
3. DO NOT modify, add, or delete ANY source files in the repository. PLAN mode is strictly READ-ONLY.
4. Output your final implementation plan in structured Markdown format.
`.trim();

      // 3. Preventative permission profile (Deny file writes, deny network, enable sandbox)
      const planProfile = AgyAdapter.getPlanProfile();

      const runResult = await this.agyAdapter.invokeAgent(
        jobId,
        worktreePath,
        planProfile,
        promptText,
        timeoutSeconds
      );

      // 4. Mechanical Read-Only Assertion: Verify no files were modified
      const statusCheck = await isWorkingTreeClean(worktreePath);

      if (!statusCheck.clean) {
        logger.error(`PLAN mode violation for job ${jobId}: modified files detected!`, { files: statusCheck.modifiedFiles });
        return {
          jobId,
          projectId,
          baseSha,
          model: this.agyAdapter.getModel(),
          planText: '',
          exitCode: 1,
          clean: false,
          mutatedFiles: statusCheck.modifiedFiles,
          error: `PLAN mode violated read-only constraint: repository was modified by worker (${statusCheck.modifiedFiles.join(', ')})`,
        };
      }

      const planText = runResult.stdout.trim() || 'Plan generated successfully (empty stdout). Check logs for details.';

      return {
        jobId,
        projectId,
        baseSha,
        model: this.agyAdapter.getModel(),
        planText,
        exitCode: runResult.exitCode,
        clean: true,
        mutatedFiles: [],
        error: runResult.exitCode !== 0 ? (runResult.stderr.trim() || `AGY process exited with code ${runResult.exitCode}`) : undefined,
      };
    } catch (err: any) {
      logger.error(`Exception during PLAN execution for job ${jobId}: ${err.message || String(err)}`);
      return {
        jobId,
        projectId,
        baseSha,
        model: this.agyAdapter.getModel(),
        planText: '',
        exitCode: 1,
        clean: false,
        mutatedFiles: [],
        error: `Exception during plan generation: ${err.message || String(err)}`,
      };
    } finally {
      if (worktreePath) {
        await this.worktreeManager.forceCleanupWorktree(repoPath, worktreePath);
      }
    }
  }
}
