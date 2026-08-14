import * as fs from 'node:fs';
import * as path from 'node:path';
import { JobSpec, JobStatus } from '../types.js';
import { parseJobSpec, formatStatusJson } from './parser.js';
import { logger } from '../utils/logger.js';

export interface MailboxJobEntry {
  jobId: string;
  jobDir: string;
  spec: JobSpec | null;
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

      let spec: JobSpec | null = null;
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

  async readJobGoal(jobId: string): Promise<string | null> {
    return this.readJobFile(jobId, 'goal.md');
  }

  async readJobPlan(jobId: string): Promise<string | null> {
    return this.readJobFile(jobId, 'plan.md');
  }

  async readJobReview(jobId: string): Promise<string | null> {
    return this.readJobFile(jobId, 'review.md');
  }

  async writeJobPlan(jobId: string, planContent: string): Promise<void> {
    await this.writeJobFile(jobId, 'plan.md', planContent);
  }

  async writeJobResult(jobId: string, resultContent: string): Promise<void> {
    await this.writeJobFile(jobId, 'result.md', resultContent);
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
