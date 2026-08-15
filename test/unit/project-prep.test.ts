import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DurableService } from '../../src/service/durable-service.js';
import { ConfigManager } from '../../src/config.js';
import { IpcClient } from '../../src/service/ipc-client.js';
import { PrepareProjectResult } from '../../src/service/ipc-protocol.js';

const execFileAsync = promisify(execFile);

describe('Project Preparation (worker_bridge_prepare_project)', () => {
  let tmpDir: string;
  let trustedRoot: string;
  let repoDir: string;
  let outsideDir: string;
  let pipePath: string;
  let service: DurableService;
  let client: IpcClient;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-prep-test-'));
    trustedRoot = path.join(tmpDir, 'Projects');
    outsideDir = path.join(tmpDir, 'Outside');
    repoDir = path.join(trustedRoot, 'my-repo');

    fs.mkdirSync(trustedRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize git repository in repoDir
    await execFileAsync('git', ['init'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'tester@test.com'], { cwd: repoDir, windowsHide: true });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello world\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir, windowsHide: true });

    pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\worker-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      : path.join(tmpDir, 'test-bridge.sock');

    const configManager = new ConfigManager({
      mailboxRepoPath: path.join(tmpDir, 'mailbox'),
      workerRootDir: path.join(tmpDir, 'workers'),
      allowedProjects: {},
    });

    service = new DurableService({
      pipePath,
      configManager,
      trustedRoots: [trustedRoot],
    });

    await service.start();
    client = new IpcClient({ pipePath });
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    await service.stop();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates EXISTING_CLEAN repository successfully', async () => {
    const result = await client.call<PrepareProjectResult>('prepare_project', {
      projectPath: repoDir,
    });

    expect(result.status).toBe('ready');
    expect(result.clean).toBe(true);
    expect(result.baseSha).toHaveLength(40);
    expect(result.branch).toBeTruthy();
  });

  it('detects EXISTING_DIRTY repository and blocks fast-forward sync', async () => {
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'uncommitted changes\n');

    const result = await client.call<PrepareProjectResult>('prepare_project', {
      projectPath: repoDir,
    });
    expect(result.clean).toBe(false);

    // Fast-forward sync on dirty repo must throw DIRTY_WORKTREE
    await expect(
      client.call('prepare_project', {
        projectPath: repoDir,
        syncMode: 'fast-forward',
      })
    ).rejects.toThrow('DIRTY_WORKTREE');
  });

  it('rejects projectPath outside trusted root with PATH_ESCAPE', async () => {
    await expect(
      client.call('prepare_project', {
        projectPath: outsideDir,
      })
    ).rejects.toThrow('PATH_ESCAPE');
  });

  it('rejects non-existent repository directories with PROJECT_NOT_FOUND', async () => {
    const nonExistent = path.join(trustedRoot, 'does-not-exist');
    await expect(
      client.call('prepare_project', {
        projectPath: nonExistent,
      })
    ).rejects.toThrow('PROJECT_NOT_FOUND');
  });

  it('rejects non-git directories with NOT_A_GIT_REPO', async () => {
    const nonGit = path.join(trustedRoot, 'not-git');
    fs.mkdirSync(nonGit, { recursive: true });
    await expect(
      client.call('prepare_project', {
        projectPath: nonGit,
      })
    ).rejects.toThrow('NOT_A_GIT_REPO');
  });

  it('detects DESTINATION_COLLISION when cloning to an existing folder', async () => {
    await expect(
      client.call('prepare_project', {
        remote: 'https://github.com/example/repo.git',
        destinationName: 'my-repo', // already exists
      })
    ).rejects.toThrow('DESTINATION_COLLISION');
  });

  it('rejects invalid destination names preventing path traversal', async () => {
    await expect(
      client.call('prepare_project', {
        remote: 'https://github.com/example/repo.git',
        destinationName: '../escape',
      })
    ).rejects.toThrow('INVALID_DESTINATION');
  });

  it('rejects destination names starting with hyphens preventing git option injection', async () => {
    await expect(
      client.call('prepare_project', {
        remote: 'https://github.com/example/repo.git',
        destinationName: '-b',
      })
    ).rejects.toThrow('INVALID_DESTINATION');

    await expect(
      client.call('prepare_project', {
        remote: 'https://github.com/example/repo.git',
        destinationName: '--config',
      })
    ).rejects.toThrow('INVALID_DESTINATION');
  });

  it('rejects refs starting with hyphens preventing git checkout option injection', async () => {
    await expect(
      client.call('prepare_project', {
        remote: 'https://github.com/example/repo.git',
        destinationName: 'valid-dest',
        ref: '-b',
      })
    ).rejects.toThrow('INVALID_REF');

    await expect(
      client.call('prepare_project', {
        remote: 'https://github.com/example/repo.git',
        destinationName: 'valid-dest',
        ref: '--upload-pack=calc.exe',
      })
    ).rejects.toThrow('INVALID_REF');
  });

  it('rejects insecure/arbitrary remote protocol URLs and remote flags', async () => {
    await expect(
      client.call('prepare_project', {
        remote: 'file:///etc/passwd',
        destinationName: 'malicious',
      })
    ).rejects.toThrow('INVALID_REMOTE');

    await expect(
      client.call('prepare_project', {
        remote: 'ext::sh -c calc',
        destinationName: 'malicious',
      })
    ).rejects.toThrow('INVALID_REMOTE');

    await expect(
      client.call('prepare_project', {
        remote: '-u',
        destinationName: 'malicious',
      })
    ).rejects.toThrow('INVALID_REMOTE');
  });
});
