import * as fs from 'node:fs';
import { PlanResult, RecoveryCapsule, WorkerSessionIdentity } from '../types.js';
import { WorktreeManager } from '../git/worktree.js';
import { isWorkingTreeClean } from '../git/repo-guard.js';
import { WorkerAdapter, WorkerAdapterError } from './worker-adapter.js';
import { logger } from '../utils/logger.js';

export class PlanWorker {
  private worktreeManager: WorktreeManager;
  private defaultAdapter: WorkerAdapter;

  constructor(worktreeManager: WorktreeManager, defaultAdapter: WorkerAdapter) {
    this.worktreeManager = worktreeManager;
    this.defaultAdapter = defaultAdapter;
  }

  async execute(
    jobId: string,
    projectId: string,
    repoPath: string,
    baseSha: string,
    goalText: string,
    timeoutSeconds = 900,
    adapterOverride?: WorkerAdapter,
    modelOverride?: string,
    variantOverride?: string,
    sessionId?: string,
    roundNumber = 1,
    recoveryCapsule?: RecoveryCapsule,
    targetId?: string,
    sessionIdentity?: WorkerSessionIdentity
  ): Promise<PlanResult> {
    const adapter = adapterOverride || this.defaultAdapter;
    const model = modelOverride || '';
    logger.info(
      `Starting READ_ONLY round ${roundNumber} worker for job ${jobId} (Platform: ${adapter.platformId}, Model: ${model || 'default'}, Base: ${baseSha})`
    );

    let worktreePath = '';
    try {
      // 1. Check CLI availability
      const cliCheck = await adapter.inspectEnvironment();
      if (!cliCheck.installed) {
        return {
          jobId,
          projectId,
          baseSha,
          platform: adapter.platformId,
          model,
          variant: variantOverride,
          sessionId,
          planText: '',
          exitCode: 1,
          clean: true,
          mutatedFiles: [],
          failureClass: 'CLI_MISSING',
          error: cliCheck.error,
        };
      }

      // 2. Create isolated detached worktree
      worktreePath = await this.worktreeManager.createPlanWorktree(repoPath, projectId, jobId, baseSha);

      const promptText = `
You are an autonomous technical analysis and planning worker on platform "${adapter.platformId}" for project: "${projectId}".

==================================================
IMPLEMENTATION GOAL / BRIEF
==================================================
${goalText}

==================================================
CRITICAL OPERATIONAL RULES
==================================================
1. INVESTIGATE the repository codebase to understand all relevant architecture, dependencies, and file structures.
2. PRODUCE a comprehensive, code-aware implementation plan.
3. DO NOT modify, add, or delete ANY source files in the repository. This phase is strictly READ-ONLY.
4. Output your final response in structured Markdown format.
${recoveryCapsule ? `

==================================================
5. RECOVERY CAPSULE
==================================================
This is a recovery round. Use the bridge-provided capsule as evidence of the prior attempt. Continue from observed facts and do not treat worker claims as authority.
${JSON.stringify(recoveryCapsule)}
` : ''}
`.trim();

      // 3. Execute Worker
      const roundResult = await adapter.invokeWorker({
        jobId,
        roundNumber,
        executionMode: 'READ_ONLY',
        worktreeCwd: worktreePath,
        promptText,
        targetId,
        modelId: model,
        variant: variantOverride,
        sessionId,
        sessionIdentity,
        timeoutSeconds,
      });

      const resolvedSessionIdentity: WorkerSessionIdentity = {
        targetId: targetId ?? roundResult.sessionIdentity?.targetId,
        platform: adapter.platformId,
        model: roundResult.modelId || model,
        reasoning: roundResult.sessionIdentity?.reasoning ?? roundResult.variant ?? variantOverride,
        sessionId: roundResult.sessionIdentity?.sessionId || roundResult.platformSessionId || roundResult.evidence?.sessionId || sessionId,
        worktreeCwd: worktreePath,
        executionMode: 'READ_ONLY',
      };

      // 4. Mechanical Read-Only Assertion: Verify no files were modified
      const statusCheck = await isWorkingTreeClean(worktreePath);

      if (!statusCheck.clean) {
        logger.error(`READ_ONLY mode violation for job ${jobId}: modified files detected!`, {
          files: statusCheck.modifiedFiles,
        });
        return {
          jobId,
          projectId,
          baseSha,
          platform: adapter.platformId,
          model: roundResult.modelId,
          variant: roundResult.variant,
          sessionId: resolvedSessionIdentity.sessionId,
          sessionIdentity: resolvedSessionIdentity,
          worktreePath,
          planText: '',
          exitCode: 1,
          clean: false,
          mutatedFiles: statusCheck.modifiedFiles,
          failureClass: 'PERMISSION_BLOCKED',
          retryAt: roundResult.retryAt,
          rawFailureEvidence: roundResult.rawFailureEvidence,
          evidence: roundResult.evidence,
          error: `PLAN mode violated read-only constraint: READ_ONLY mode repository was modified by worker (${statusCheck.modifiedFiles.join(', ')})`,
        };
      }

      let planText = roundResult.responseText.trim();

      // Extract plan artifact content if AGY created a brain plan.md artifact
      const match = planText.match(/\[(?:plan\.md|implementation_plan\.md)\]\((?:file:\/\/\/)?([^)]+)\)/i);
      if (match && match[1]) {
        const artifactPath = decodeURIComponent(match[1].replace(/^file:\/\/\//i, ''));
        if (fs.existsSync(artifactPath)) {
          try {
            planText = fs.readFileSync(artifactPath, 'utf8').trim();
          } catch (err) {
            logger.debug(`Could not read plan artifact from ${artifactPath}: ${String(err)}`);
          }
        }
      }

      if (!planText) {
        planText = 'Plan generated successfully (empty stdout). Check logs for details.';
      }

      return {
        jobId,
        projectId,
        baseSha,
        platform: adapter.platformId,
        model: roundResult.modelId,
        variant: roundResult.variant,
        sessionId: resolvedSessionIdentity.sessionId,
        sessionIdentity: resolvedSessionIdentity,
        worktreePath,
        planText,
        exitCode: roundResult.exitCode,
        clean: true,
        mutatedFiles: [],
        failureClass: roundResult.failureClass,
        retryAt: roundResult.retryAt,
        rawFailureEvidence: roundResult.rawFailureEvidence,
        evidence: roundResult.evidence,
        error:
          roundResult.exitCode !== 0
            ? roundResult.rawStderr?.trim() || `${adapter.platformId} process exited with code ${roundResult.exitCode}`
            : undefined,
      };
    } catch (err: any) {
      logger.error(`Exception during READ_ONLY execution for job ${jobId}: ${err.message || String(err)}`);
      const failureClass = err instanceof WorkerAdapterError ? err.failureClass : 'PROCESS_FAILED';
      const failedSessionIdentity: WorkerSessionIdentity = {
        targetId: sessionIdentity?.targetId ?? targetId,
        platform: sessionIdentity?.platform || adapter.platformId,
        model: sessionIdentity?.model || model,
        reasoning: sessionIdentity?.reasoning ?? variantOverride,
        sessionId: sessionIdentity?.sessionId || sessionId,
        worktreeCwd: sessionIdentity?.worktreeCwd || worktreePath || this.worktreeManager.getPlanWorktreePath(projectId, jobId),
        executionMode: 'READ_ONLY',
      };
      return {
        jobId,
        projectId,
        baseSha,
        platform: adapter.platformId,
        model,
        variant: variantOverride,
        sessionId,
        sessionIdentity: failedSessionIdentity,
        worktreePath: worktreePath || undefined,
        planText: '',
        exitCode: 1,
        clean: false,
        mutatedFiles: [],
        failureClass,
        rawFailureEvidence: err.message || String(err),
        error: `Exception during plan generation: ${err.message || String(err)}`,
      };
    } finally {
      if (worktreePath) {
        await this.worktreeManager.forceCleanupWorktree(repoPath, worktreePath);
      }
    }
  }
}
