import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import {
  ImplementResult,
  OwnerApproval,
  ProjectConfig,
  RecoveryCapsule,
  RecoveryCurrentState,
  WorkerRoundResult,
} from '../types.js';
import { WorktreeManager } from '../git/worktree.js';
import { getDiffCheck, isWorkingTreeClean } from '../git/repo-guard.js';
import { WorkerAdapter } from './worker-adapter.js';
import { logger } from '../utils/logger.js';
import { sanitizeSecrets } from '../utils/sanitizer.js';
import { buildRecoveryCapsule, captureWorktreeState } from '../engine/recovery-capsule.js';

const execFileAsync = promisify(execFile);

function hasSourceEffects(state: RecoveryCurrentState, baseSha: string): boolean {
  const status = state.gitStatus.trim();
  if (state.inspectionFailed || status.startsWith('GIT_INSPECTION_ERROR:')) return true;
  if (status.length > 0) return true;
  return Boolean(state.headSha && state.headSha.trim() && state.headSha.trim() !== baseSha.trim());
}

function fallbackEvidence(roundResult: WorkerRoundResult): NonNullable<WorkerRoundResult['evidence']> {
  return (
    roundResult.evidence || {
      stdout: roundResult.responseText || '',
      stderr: roundResult.rawStderr || '',
      partialResponse: roundResult.responseText || '',
      outputTruncated: false,
      sessionId: roundResult.platformSessionId,
    }
  );
}

export class ImplementWorker {
  private worktreeManager: WorktreeManager;
  private defaultAdapter: WorkerAdapter;

  constructor(worktreeManager: WorktreeManager, defaultAdapter: WorkerAdapter) {
    this.worktreeManager = worktreeManager;
    this.defaultAdapter = defaultAdapter;
  }

  private createRecoveryCapsule(
    jobId: string,
    roundNumber: number,
    contractRevision: number,
    ownerApproval: OwnerApproval | undefined,
    baseSha: string,
    goalText: string,
    planText: string,
    reviewText: string,
    adapter: WorkerAdapter,
    targetId: string | undefined,
    model: string,
    sessionId: string | undefined,
    promptText: string,
    roundResult: WorkerRoundResult,
    state: RecoveryCurrentState,
    incompleteOperations: string[]
  ): RecoveryCapsule {
    return buildRecoveryCapsule({
      contract: {
        jobId,
        round: roundNumber,
        revision: contractRevision,
        role: 'WORKER',
        originalGoal: goalText,
        acceptedPlan: planText,
        solReview: reviewText,
        ownerApproval,
        baseSha,
        executionConstraints: [
          'WORKTREE_WRITE source changes are limited to the isolated worktree.',
          'Do not push from the worker session.',
          'Do not start a clean implementation from the base SHA after source effects exist.',
        ],
      },
      sourceWorker: {
        targetId,
        platform: adapter.platformId,
        model: roundResult.modelId || model,
        reasoning: roundResult.variant,
        sessionId: roundResult.platformSessionId || sessionId,
        requestPrompt: roundResult.requestPrompt || promptText,
        startedAt: roundResult.startedAt,
        endedAt: roundResult.completedAt,
        failureClass: roundResult.failureClass,
        retryAt: roundResult.retryAt,
      },
      capturedHistory: fallbackEvidence(roundResult),
      currentState: {
        ...state,
        incompleteOperations,
      },
      recoveryDirective: {
        provenComplete: ['isolated implementation worktree created', 'worker response captured', 'Git state observed by Worker Bridge'],
        appearsIncomplete: ['authoritative verification', 'worker branch commit or publication'],
        knownFailures: [roundResult.failureClass || 'PROCESS_FAILED'],
        remainingWork: ['inspect the preserved source effects', 'continue or correct the existing implementation', 'run authoritative verification'],
        mustNotRepeatBlindly: ['discard the preserved worktree', 'start a clean implementation from the base SHA', 'retry the same unavailable target before retryAt'],
        instruction: 'CONTINUE EXISTING IMPLEMENTATION. DO NOT START OVER.',
      },
    });
  }

  private formatReport(input: {
    jobId: string;
    projectId: string;
    adapter: WorkerAdapter;
    model: string;
    variant?: string;
    baseSha: string;
    workerBranch: string;
    headSha?: string;
    roundResult?: WorkerRoundResult;
    filesChanged: string[];
    diffStat: string;
    diffCheckPassed: boolean;
    diffCheckOutput: string;
    testsRun: boolean;
    testOutput: string;
    testExitCode: number;
    bridgeVerificationPassed: boolean;
    pushed: boolean;
    sourceEffectsPresent: boolean;
    interrupted: boolean;
  }): string {
    const roundResult = input.roundResult;
    return `
# Implementation Result: \`${input.jobId}\`

- **Project**: \`${input.projectId}\`
- **Platform**: \`${input.adapter.platformId}\`
- **Model**: \`${roundResult?.modelId || input.model}\` (Variant: \`${roundResult?.variant || input.variant || 'none'}\`)
- **Base SHA**: \`${input.baseSha}\`
- **Worker Branch**: \`${input.workerBranch}\`
- **Head SHA**: \`${input.headSha || 'not-committed'}\`
- **Worker Exit Code**: \`${roundResult?.exitCode ?? 1}\`
- **Source Effects Present**: \`${input.sourceEffectsPresent}\`
- **Interrupted Source State**: \`${input.interrupted}\`
- **Bridge Test Verification Passed**: \`${input.bridgeVerificationPassed}\`
- **Diff Check Passed**: \`${input.diffCheckPassed}\`
- **Remote Branch Pushed**: \`${input.pushed}\`

---

## Changed Files & Diff Stat
\`\`\`text
${sanitizeSecrets(input.diffStat.trim() || input.filesChanged.join('\n') || 'No changes recorded')}
\`\`\`

---

## Diff Check
\`\`\`text
${input.diffCheckPassed ? 'PASSED (Clean whitespace and syntax)' : `FAILED:\n${sanitizeSecrets(input.diffCheckOutput)}`}
\`\`\`

---

## Authoritative Test Verification
- **Tests Executed**: \`${input.testsRun}\`
- **Test Exit Code**: \`${input.testExitCode}\`
- **Verification Verdict**: \`${input.bridgeVerificationPassed ? 'PASSED' : 'FAILED'}\`

\`\`\`text
${sanitizeSecrets(input.testOutput.trim()) || (input.testsRun ? 'Tests ran with no output' : 'N/A')}
\`\`\`

---

## Worker Execution Output
\`\`\`text
${sanitizeSecrets(roundResult?.responseText?.slice(-2000).trim() || 'No worker response captured')}
\`\`\`
`.trim();
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
    timeoutSeconds = 1800,
    adapterOverride?: WorkerAdapter,
    modelOverride?: string,
    variantOverride?: string,
    sessionId?: string,
    roundNumber = 1,
    recoveryCapsule?: RecoveryCapsule,
    preservedWorktreePath?: string,
    targetId?: string,
    contractRevision = 1,
    ownerApproval?: OwnerApproval
  ): Promise<ImplementResult> {
    const adapter = adapterOverride || this.defaultAdapter;
    const model = modelOverride || '';
    logger.info(
      `Starting WORKTREE_WRITE round ${roundNumber} worker for job ${jobId} (Platform: ${adapter.platformId}, Model: ${model || 'default'}, Base: ${baseSha})`
    );

    const repoPath = projectConfig.path;
    let worktreePath = '';
    let workerBranch = '';
    let preserveWorktree = false;
    let sourceEffectsPresent = false;
    let promptText = '';
    let lastState: RecoveryCurrentState | undefined;
    let lastRoundResult: WorkerRoundResult | undefined;

    try {
      const cliCheck = await adapter.inspectEnvironment();
      if (!cliCheck.installed) {
        return {
          jobId,
          projectId,
          baseSha,
          platform: adapter.platformId,
          model,
          targetId,
          variant: variantOverride,
          sessionId,
          workerBranch: `worker/${projectId}/${jobId}`,
          filesChanged: [],
          testsRun: false,
          bridgeVerificationPassed: false,
          diffCheckPassed: false,
          dirtyRemaining: false,
          exitCode: 1,
          failureClass: 'CLI_MISSING',
          sourceEffectsPresent: false,
          error: cliCheck.error,
          reportText: `# Implementation Failed: \`${jobId}\`\n\n${sanitizeSecrets(cliCheck.error || 'Worker CLI is unavailable.')}`,
        };
      }

      if (preservedWorktreePath && fs.existsSync(preservedWorktreePath)) {
        worktreePath = preservedWorktreePath;
        const { stdout: branchOut } = await execFileAsync('git', ['-C', worktreePath, 'branch', '--show-current'], {
          windowsHide: true,
        });
        workerBranch = branchOut.trim() || this.worktreeManager.getWorkerBranchName(projectId, jobId);
      } else {
        const created = await this.worktreeManager.createImplementWorktree(repoPath, projectId, jobId, baseSha);
        worktreePath = created.worktreePath;
        workerBranch = created.workerBranch;
      }

      promptText = `
You are an autonomous implementation worker on platform "${adapter.platformId}" for project: "${projectId}".

==================================================
1. ORIGINAL IMPLEMENTATION GOAL / BRIEF
==================================================
${goalText}

==================================================
2. PROPOSED IMPLEMENTATION PLAN
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
${recoveryCapsule ? `

==================================================
6. RECOVERY CAPSULE
==================================================
This is a recovery round. Continue the existing implementation from the observed worktree state. Do not discard source effects and do not start over from the base SHA.
${JSON.stringify(recoveryCapsule)}
` : ''}
`.trim();

      lastRoundResult = await adapter.invokeWorker({
        jobId,
        roundNumber,
        executionMode: 'WORKTREE_WRITE',
        worktreeCwd: worktreePath,
        promptText,
        modelId: model,
        variant: variantOverride,
        sessionId,
        timeoutSeconds,
      });

      lastState = await captureWorktreeState(worktreePath, baseSha);
      sourceEffectsPresent = hasSourceEffects(lastState, baseSha);
      const workerFailed = lastRoundResult.exitCode !== 0 || Boolean(lastRoundResult.failureClass);

      // Observe source effects before tests or commit. A failed source-writing attempt
      // is recoverable evidence, not permission to start a clean fallback.
      if (workerFailed) {
        const diffCheck = await getDiffCheck(worktreePath);
        const recoveryEvidence = this.createRecoveryCapsule(
          jobId,
          roundNumber,
          contractRevision,
          ownerApproval,
          baseSha,
          goalText,
          planText,
          reviewText,
          adapter,
          targetId,
          model,
          sessionId,
          promptText,
          lastRoundResult,
          lastState,
          [
            'worker execution did not complete',
            'authoritative tests and commit were not run',
            ...(sourceEffectsPresent ? [] : ['no source effects were observed']),
          ]
        );
        preserveWorktree = sourceEffectsPresent;
        const reportText = this.formatReport({
          jobId,
          projectId,
          adapter,
          model,
          variant: variantOverride,
          baseSha,
          workerBranch,
          headSha: lastState.headSha,
          roundResult: lastRoundResult,
          filesChanged: lastState.filesChanged,
          diffStat: lastState.gitDiffStat,
          diffCheckPassed: diffCheck.passed,
          diffCheckOutput: diffCheck.output,
          testsRun: false,
          testOutput: '',
          testExitCode: 0,
          bridgeVerificationPassed: false,
          pushed: false,
          sourceEffectsPresent,
          interrupted: sourceEffectsPresent,
        });
        return {
          jobId,
          projectId,
          baseSha,
          platform: adapter.platformId,
          model: lastRoundResult.modelId || model,
          targetId,
          variant: lastRoundResult.variant,
          sessionId: lastRoundResult.platformSessionId || sessionId,
          workerBranch,
          headSha: lastState.headSha,
          filesChanged: lastState.filesChanged,
          testsRun: false,
          testOutput: '',
          testExitCode: 0,
          bridgeVerificationPassed: false,
          diffCheckPassed: diffCheck.passed,
          dirtyRemaining: sourceEffectsPresent,
          exitCode: 1,
          failureClass: lastRoundResult.failureClass || 'PROCESS_FAILED',
          retryAt: lastRoundResult.retryAt,
          rawFailureEvidence: lastRoundResult.rawFailureEvidence,
          sourceEffectsPresent,
          worktreePath: sourceEffectsPresent ? worktreePath : undefined,
          currentHeadSha: lastState.headSha,
          recoveryEvidence,
          error: sourceEffectsPresent
            ? `Worker failed after source effects were observed (${lastRoundResult.failureClass || 'PROCESS_FAILED'}). Worktree preserved for recovery.`
            : `${adapter.platformId} process exited with code ${lastRoundResult.exitCode} before source effects were observed.`,
          reportText,
        };
      }

      const diffCheck = await getDiffCheck(worktreePath);
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
        } catch (err: any) {
          testExitCode = err.code ?? 1;
          testOutput = (err.stdout || '') + (err.stderr ? `\n${err.stderr}` : '') + `\n${err.message}`;
          logger.warn(`Authoritative test verification failed with exit code ${testExitCode}`);
          bridgeVerificationPassed = false;
        }
      }

      lastState = await captureWorktreeState(worktreePath, baseSha);
      sourceEffectsPresent = hasSourceEffects(lastState, baseSha);
      const verificationFailed = !bridgeVerificationPassed || !diffCheck.passed;
      if (verificationFailed) {
        preserveWorktree = sourceEffectsPresent;
        const failedResult: WorkerRoundResult = {
          ...lastRoundResult,
          exitCode: 1,
          failureClass: lastRoundResult.failureClass || 'PROCESS_FAILED',
        };
        const recoveryEvidence = sourceEffectsPresent
          ? this.createRecoveryCapsule(
              jobId,
              roundNumber,
              contractRevision,
              ownerApproval,
              baseSha,
              goalText,
              planText,
              reviewText,
              adapter,
              targetId,
              model,
              sessionId,
              promptText,
              failedResult,
              { ...lastState, bridgeVerification: { build: 'not-run', tests: bridgeVerificationPassed ? 'passed' : 'failed' } },
              ['authoritative verification failed', 'worker branch commit and publication were not run']
            )
          : undefined;
        const reportText = this.formatReport({
          jobId,
          projectId,
          adapter,
          model,
          variant: variantOverride,
          baseSha,
          workerBranch,
          headSha: lastState.headSha,
          roundResult: failedResult,
          filesChanged: lastState.filesChanged,
          diffStat: lastState.gitDiffStat,
          diffCheckPassed: diffCheck.passed,
          diffCheckOutput: diffCheck.output,
          testsRun,
          testOutput,
          testExitCode,
          bridgeVerificationPassed,
          pushed: false,
          sourceEffectsPresent,
          interrupted: sourceEffectsPresent,
        });
        return {
          jobId,
          projectId,
          baseSha,
          platform: adapter.platformId,
          model: lastRoundResult.modelId || model,
          targetId,
          variant: lastRoundResult.variant,
          sessionId: lastRoundResult.platformSessionId || sessionId,
          workerBranch,
          headSha: lastState.headSha,
          filesChanged: lastState.filesChanged,
          testsRun,
          testOutput: sanitizeSecrets(testOutput),
          testExitCode,
          bridgeVerificationPassed,
          diffCheckPassed: diffCheck.passed,
          dirtyRemaining: sourceEffectsPresent,
          exitCode: 1,
          failureClass: failedResult.failureClass,
          sourceEffectsPresent,
          worktreePath: sourceEffectsPresent ? worktreePath : undefined,
          currentHeadSha: lastState.headSha,
          recoveryEvidence,
          error: !bridgeVerificationPassed
            ? `Authoritative test verification failed (Exit Code: ${testExitCode})`
            : `Diff check failed: ${diffCheck.output}`,
          reportText,
        };
      }

      const commitRes = await this.worktreeManager.commitAndPushWorkerBranch(
        worktreePath,
        workerBranch,
        `feat(worker): [${jobId}] implementation on ${adapter.platformId} (${lastRoundResult.modelId})`,
        shouldPush && projectConfig.allowPushWorkerBranch !== false,
        remote
      );
      const statusAfterCommit = await isWorkingTreeClean(worktreePath);
      const reportText = this.formatReport({
        jobId,
        projectId,
        adapter,
        model,
        variant: variantOverride,
        baseSha,
        workerBranch,
        headSha: commitRes.headSha,
        roundResult: lastRoundResult,
        filesChanged: lastState.filesChanged,
        diffStat: lastState.gitDiffStat,
        diffCheckPassed: diffCheck.passed,
        diffCheckOutput: diffCheck.output,
        testsRun,
        testOutput,
        testExitCode,
        bridgeVerificationPassed,
        pushed: commitRes.pushed,
        sourceEffectsPresent,
        interrupted: false,
      });

      return {
        jobId,
        projectId,
        baseSha,
        platform: adapter.platformId,
        model: lastRoundResult.modelId,
        targetId,
        variant: lastRoundResult.variant,
        sessionId: lastRoundResult.platformSessionId || sessionId,
        workerBranch,
        headSha: commitRes.headSha,
        filesChanged: lastState.filesChanged,
        testsRun,
        testOutput: sanitizeSecrets(testOutput),
        testExitCode,
        bridgeVerificationPassed,
        diffCheckPassed: diffCheck.passed,
        dirtyRemaining: !statusAfterCommit.clean,
        exitCode: 0,
        sourceEffectsPresent,
        currentHeadSha: commitRes.headSha,
        reportText,
      };
    } catch (err: any) {
      logger.error(`Exception during WORKTREE_WRITE execution for job ${jobId}: ${err.message || String(err)}`);
      if (worktreePath) {
        try {
          lastState = await captureWorktreeState(worktreePath, baseSha);
          sourceEffectsPresent = hasSourceEffects(lastState, baseSha);
          preserveWorktree = sourceEffectsPresent;
        } catch {
          // Git observation failure is unsafe to interpret as a clean worktree.
          sourceEffectsPresent = true;
          preserveWorktree = true;
        }
      }
      const errorText = `Exception during implementation: ${err.message || String(err)}`;
      const recoveryEvidence = sourceEffectsPresent && lastState && lastRoundResult
        ? this.createRecoveryCapsule(
            jobId,
            roundNumber,
            contractRevision,
            ownerApproval,
            baseSha,
            goalText,
            planText,
            reviewText,
            adapter,
            targetId,
            model,
            sessionId,
            promptText,
            { ...lastRoundResult, failureClass: lastRoundResult.failureClass || 'PROCESS_FAILED', exitCode: 1 },
            lastState,
            ['implementation execution raised an exception', 'authoritative verification and publication may be incomplete']
          )
        : undefined;
      return {
        jobId,
        projectId,
        baseSha,
        platform: adapter.platformId,
        model,
        targetId,
        variant: variantOverride,
        sessionId,
        workerBranch: workerBranch || `worker/${projectId}/${jobId}`,
        headSha: lastState?.headSha,
        filesChanged: lastState?.filesChanged || [],
        testsRun: false,
        bridgeVerificationPassed: false,
        diffCheckPassed: false,
        dirtyRemaining: sourceEffectsPresent,
        exitCode: 1,
        failureClass: 'PROCESS_FAILED',
        sourceEffectsPresent,
        worktreePath: sourceEffectsPresent ? worktreePath : undefined,
        currentHeadSha: lastState?.headSha,
        recoveryEvidence,
        error: errorText,
        reportText: `# Implementation Failed: \`${jobId}\`\n\n${sanitizeSecrets(errorText)}${sourceEffectsPresent ? '\n\nThe affected worktree was preserved for recovery.' : ''}`,
      };
    } finally {
      if (worktreePath && !preserveWorktree) {
        await this.worktreeManager.forceCleanupWorktree(repoPath, worktreePath);
      }
    }
  }
}
