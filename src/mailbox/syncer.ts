import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkJob, JobStatus, RecoveryCapsule } from '../types.js';
import { parseJobSpec, formatStatusJson } from './parser.js';
import { logger } from '../utils/logger.js';
import { serializeRecoveryCapsule } from '../engine/recovery-capsule.js';

export interface MailboxJobEntry {
  jobId: string;
  jobDir: string;
  spec: WorkJob | null;
  parseError?: string;
  status: JobStatus | null;
}

export class MailboxSyncer {
  private mailboxRepoPath: string;

  constructor(mailboxRepoPath: string) {
    this.mailboxRepoPath = path.resolve(mailboxRepoPath);
  }

  getJobsDir(): string {
    return path.join(this.mailboxRepoPath, 'jobs');
  }

  getJobDir(jobId: string): string {
    return path.join(this.getJobsDir(), jobId);
  }

  getJobRoundsDir(jobId: string): string {
    return path.join(this.getJobDir(jobId), 'rounds');
  }

  getRoundDir(jobId: string, roundNumber: number): string {
    const formattedRound = roundNumber.toString().padStart(3, '0');
    return path.join(this.getJobRoundsDir(jobId), formattedRound);
  }

  async listJobs(): Promise<MailboxJobEntry[]> {
    const jobsDir = this.getJobsDir();
    if (!fs.existsSync(jobsDir)) {
      return [];
    }

    const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
    const results: MailboxJobEntry[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobId = entry.name;
      const jobDir = path.join(jobsDir, jobId);
      const jobJsonPath = path.join(jobDir, 'job.json');
      const statusJsonPath = path.join(jobDir, 'status.json');

      let spec: WorkJob | null = null;
      let parseError: string | undefined;
      let status: JobStatus | null = null;

      if (fs.existsSync(jobJsonPath)) {
        try {
          const content = fs.readFileSync(jobJsonPath, 'utf8');
          const res = parseJobSpec(content);
          if (res.valid && res.spec) {
            spec = res.spec;
          } else {
            parseError = res.error;
          }
        } catch (err) {
          parseError = String(err);
        }
      }

      if (fs.existsSync(statusJsonPath)) {
        try {
          const statusContent = fs.readFileSync(statusJsonPath, 'utf8');
          status = JSON.parse(statusContent) as JobStatus;
        } catch (err) {
          logger.warn(`Failed to parse status.json for ${jobId}: ${String(err)}`);
        }
      }

      results.push({
        jobId,
        jobDir,
        spec,
        parseError,
        status,
      });
    }

    return results;
  }

  async readJobFile(jobId: string, filename: string): Promise<string | null> {
    const filePath = path.join(this.getJobDir(jobId), filename);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      logger.error(`Failed to read file ${filename} for job ${jobId}: ${String(err)}`);
      return null;
    }
  }

  async writeJobFile(jobId: string, filename: string, content: string): Promise<void> {
    const jobDir = this.getJobDir(jobId);
    if (!fs.existsSync(jobDir)) {
      fs.mkdirSync(jobDir, { recursive: true });
    }
    const filePath = path.join(jobDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
  }

  async writeRoundFile(jobId: string, roundNumber: number, filename: string, content: string): Promise<void> {
    const roundDir = this.getRoundDir(jobId, roundNumber);
    if (!fs.existsSync(roundDir)) {
      fs.mkdirSync(roundDir, { recursive: true });
    }
    const filePath = path.join(roundDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
  }

  async readRoundFile(jobId: string, roundNumber: number, filename: string): Promise<string | null> {
    const filePath = path.join(this.getRoundDir(jobId, roundNumber), filename);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      return null;
    }
  }

  async readJobGoal(jobId: string): Promise<string | null> {
    const brief = await this.readJobFile(jobId, 'brief.md');
    if (brief) return brief;
    return this.readJobFile(jobId, 'goal.md');
  }

  async readJobPlan(jobId: string, round = 1): Promise<string | null> {
    const roundPlan = await this.readRoundFile(jobId, round, 'worker-response.md');
    if (roundPlan) return roundPlan;
    return this.readJobFile(jobId, 'plan.md');
  }

  async readJobReview(jobId: string, round = 1): Promise<string | null> {
    const roundReview = await this.readRoundFile(jobId, round, 'sol-review.md');
    if (roundReview) return roundReview;
    return this.readJobFile(jobId, 'review.md');
  }

  async writeJobPlan(jobId: string, planContent: string, round = 1): Promise<void> {
    await this.writeJobFile(jobId, 'plan.md', planContent);
    await this.writeRoundFile(jobId, round, 'worker-response.md', planContent);
  }

  async writeJobResult(jobId: string, resultContent: string, round = 1): Promise<void> {
    await this.writeJobFile(jobId, 'result.md', resultContent);
    await this.writeRoundFile(jobId, round, 'worker-response.md', resultContent);
  }

  async writeRecoveryCapsule(jobId: string, round: number, capsule: RecoveryCapsule): Promise<string> {
    const filename = 'recovery-capsule.json';
    await this.writeRoundFile(jobId, round, filename, serializeRecoveryCapsule(capsule));
    return path.join(this.getRoundDir(jobId, round), filename);
  }

  async writeJobStatus(jobId: string, status: JobStatus): Promise<void> {
    await this.writeJobFile(jobId, 'status.json', formatStatusJson(status));
  }

  async readJobStatus(jobId: string): Promise<JobStatus | null> {
    const raw = await this.readJobFile(jobId, 'status.json');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as JobStatus;
    } catch {
      return null;
    }
  }
}
