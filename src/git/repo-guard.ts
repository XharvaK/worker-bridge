import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const PROTECTED_BRANCHES = new Set([
  'master',
  'main',
  'trunk',
  'production',
  'prod',
  'release',
  'staging',
]);

export function assertNotProtectedBranch(branchName: string): void {
  const normalized = branchName.trim().toLowerCase().replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  if (PROTECTED_BRANCHES.has(normalized)) {
    throw new Error(`SECURITY VIOLATION: Operation attempted on protected branch "${branchName}". Pushing or altering primary branches is strictly prohibited.`);
  }
}

export async function verifyBaseSha(repoPath: string, baseSha: string): Promise<{ valid: boolean; error?: string }> {
  const cleanSha = baseSha.trim();
  if (!/^[a-fA-F0-9]{7,40}$/.test(cleanSha)) {
    return { valid: false, error: `Invalid SHA format: "${baseSha}"` };
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', `${cleanSha}^{commit}`], {
      windowsHide: true,
    });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Base commit SHA "${baseSha}" does not exist in repository "${repoPath}": ${String(err)}` };
  }
}

export async function isWorkingTreeClean(cwd: string): Promise<{ clean: boolean; modifiedFiles: string[] }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain'], {
      windowsHide: true,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { clean: true, modifiedFiles: [] };
    }
    const modifiedFiles = trimmed.split(/\r?\n/).map(line => line.trim());
    return { clean: false, modifiedFiles };
  } catch (err) {
    logger.error(`Failed to check git status in ${cwd}: ${String(err)}`);
    return { clean: false, modifiedFiles: [`ERROR_CHECKING_STATUS: ${String(err)}`] };
  }
}

export async function getDiffCheck(cwd: string): Promise<{ passed: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, 'diff', '--check'], {
      windowsHide: true,
    });
    return { passed: true, output: (stdout + stderr).trim() };
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '') + (err.message || '');
    return { passed: false, output: output.trim() };
  }
}
