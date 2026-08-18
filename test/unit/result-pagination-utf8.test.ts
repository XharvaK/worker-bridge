import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JobManager } from '../../src/service/job-manager.js';

describe('JobManager result pagination UTF-8 safety', () => {
  let rootDir: string;
  let projectDir: string;
  let manager: JobManager;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-mgr-utf8-'));
    projectDir = path.join(rootDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    manager = new JobManager({
      trustedRoots: [rootDir],
      storagePath: path.join(rootDir, 'ledger.json'),
    });
  });

  afterEach(() => {
    if (fs.existsSync(rootDir)) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function createCompletedJob(resultText: string): string {
    const job = manager.createJob({
      clientRequestId: 'req-utf8',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'UTF-8 pagination test',
    });
    manager.updateJobResult(job.jobId, { resultText, state: 'WORKER_RETURNED' });
    return job.jobId;
  }

  it('reproduces the split-code-point defect: a Turkish boundary produces a replacement character', () => {
    // 'ğ' is U+011F encoded as C4 9F (2 bytes). A 1-byte budget cuts inside it.
    const text = 'ğüşiöçİ';
    const jobId = createCompletedJob(text);

    const page = manager.getResult(jobId, 0, 1);

    // Fixed behavior: one complete code point, authoritative next offset.
    expect(page.resultText).toBe('ğ');
    expect(page.resultText).not.toContain('\uFFFD');
    expect(page.nextOffset).toBe(2);
    expect(page.offset).toBe(0);
    expect(page.hasMore).toBe(true);
  });

  it('reproduces the split-code-point defect: a CJK boundary produces a replacement character', () => {
    // '中' is U+4E2D encoded as E4 B8 AD (3 bytes).
    const text = '中文';
    const jobId = createCompletedJob(text);

    const page = manager.getResult(jobId, 0, 2);

    expect(page.resultText).toBe('中');
    expect(page.resultText).not.toContain('\uFFFD');
    expect(page.nextOffset).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it('reproduces the split-code-point defect: a 4-byte emoji boundary produces a replacement character', () => {
    // '🚀' is U+1F680 encoded as F0 9F 9A 80 (4 bytes).
    const text = '🚀';
    const jobId = createCompletedJob(text);

    const page = manager.getResult(jobId, 0, 2);

    expect(page.resultText).toBe('🚀');
    expect(page.resultText).not.toContain('\uFFFD');
    expect(page.nextOffset).toBe(4);
    expect(page.hasMore).toBe(false);
  });

  it('keeps ordinary ASCII pagination byte-exact and unchanged', () => {
    const text = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
    const jobId = createCompletedJob(text);

    const page1 = manager.getResult(jobId, 0, 14);
    expect(page1.resultText).toBe('line 1\nline 2\n');
    expect(page1.offset).toBe(0);
    expect(page1.limit).toBe(14);
    expect(page1.nextOffset).toBe(14);
    expect(page1.hasMore).toBe(true);

    const page2 = manager.getResult(jobId, 14, 14);
    expect(page2.resultText).toBe('line 3\nline 4\n');
    expect(page2.offset).toBe(14);
    expect(page2.nextOffset).toBe(28);
    expect(page2.hasMore).toBe(true);

    const page3 = manager.getResult(jobId, 28, 14);
    expect(page3.resultText).toBe('line 5\n');
    expect(page3.offset).toBe(28);
    expect(page3.nextOffset).toBe(35);
    expect(page3.hasMore).toBe(false);
    expect(page3.totalBytes).toBe(35);
  });

  it('reconstructs the original text exactly by following only nextOffset values', () => {
    const original = 'ğüşiöçİ 中文 🚀 alpha beta gamma\n'.repeat(20);
    const jobId = createCompletedJob(original);

    const chunks: string[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = manager.getResult(jobId, offset, 7);
      expect(page.offset).toBe(offset);
      expect(page.resultText).not.toContain('\uFFFD');
      chunks.push(page.resultText);
      pages += 1;
      offset = page.nextOffset;
      if (!page.hasMore) break;
      expect(offset).toBeGreaterThan(page.offset);
      expect(pages).toBeLessThan(10000);
    }

    const reconstructed = chunks.join('');
    expect(reconstructed).toBe(original);
    expect(pages).toBeGreaterThan(2);
  });

  it('rejects an offset that lands inside a multi-byte sequence with INVALID_RESULT_OFFSET', () => {
    const text = 'ğüşiöçİ';
    const jobId = createCompletedJob(text);
    // Byte 1 is the continuation byte (9F) of 'ğ' (C4 9F).
    expect(() => manager.getResult(jobId, 1, 10)).toThrow(/INVALID_RESULT_OFFSET/);
  });

  it('rejects an offset beyond the result with INVALID_RESULT_OFFSET', () => {
    const text = 'abc';
    const jobId = createCompletedJob(text);
    expect(() => manager.getResult(jobId, 4, 10)).toThrow(/INVALID_RESULT_OFFSET/);
  });

  it('accepts an offset at end of text as an empty final page', () => {
    const text = 'abc';
    const jobId = createCompletedJob(text);
    const page = manager.getResult(jobId, 3, 10);
    expect(page.resultText).toBe('');
    expect(page.nextOffset).toBe(3);
    expect(page.hasMore).toBe(false);
  });

  it('guarantees forward progress when the budget is smaller than one code point', () => {
    const text = '🚀🚀';
    const jobId = createCompletedJob(text);
    const page = manager.getResult(jobId, 0, 1);
    expect(page.resultText).toBe('🚀');
    expect(page.nextOffset).toBe(4);
    expect(page.hasMore).toBe(true);
  });

  it('clamps requested limits into the bounded page range', () => {
    const text = 'abc';
    const jobId = createCompletedJob(text);
    const page = manager.getResult(jobId, 0, 1000000);
    expect(page.limit).toBe(64 * 1024);
    expect(page.resultText).toBe('abc');
    expect(page.hasMore).toBe(false);
  });
});