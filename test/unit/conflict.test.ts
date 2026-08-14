import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MailboxTransport } from '../../src/mailbox/transport.js';

const execFileAsync = promisify(execFile);

describe('Mailbox Git Conflict Handling', () => {
  let tmpMailboxDir: string;
  let tmpRemoteDir: string;

  beforeEach(async () => {
    tmpRemoteDir = path.join(os.tmpdir(), `test-conflict-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpMailboxDir = path.join(os.tmpdir(), `test-conflict-local-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    fs.mkdirSync(tmpRemoteDir, { recursive: true });

    // Initialize bare remote repo
    await execFileAsync('git', ['init', '--bare', '-b', 'main', tmpRemoteDir], { windowsHide: true });

    // Clone locally
    await execFileAsync('git', ['clone', tmpRemoteDir, tmpMailboxDir], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpMailboxDir, 'config', 'user.name', 'Test User'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpMailboxDir, 'config', 'user.email', 'test@example.com'], { windowsHide: true });

    // Initial commit on main
    fs.writeFileSync(path.join(tmpMailboxDir, 'README.md'), '# Mailbox\n');
    await execFileAsync('git', ['-C', tmpMailboxDir, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpMailboxDir, 'commit', '-m', 'Initial commit'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpMailboxDir, 'push', 'origin', 'main'], { windowsHide: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRemoteDir)) {
      try {
        fs.rmSync(tmpRemoteDir, { recursive: true, force: true });
      } catch {}
    }
    if (fs.existsSync(tmpMailboxDir)) {
      try {
        fs.rmSync(tmpMailboxDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('detects a rebase conflict, aborts the rebase cleanly, and flags conflict: true without choosing winners', async () => {
    const transport = new MailboxTransport(tmpMailboxDir, 'origin', 'main');

    // Create a second clone to simulate remote change on the same file
    const secondCloneDir = path.join(os.tmpdir(), `test-conflict-second-${Date.now()}`);
    await execFileAsync('git', ['clone', tmpRemoteDir, secondCloneDir], { windowsHide: true });
    await execFileAsync('git', ['-C', secondCloneDir, 'config', 'user.name', 'Remote User'], { windowsHide: true });
    await execFileAsync('git', ['-C', secondCloneDir, 'config', 'user.email', 'remote@example.com'], { windowsHide: true });

    // Remote edits README.md and pushes
    fs.writeFileSync(path.join(secondCloneDir, 'README.md'), '# Remote Conflicting Change\n');
    await execFileAsync('git', ['-C', secondCloneDir, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync('git', ['-C', secondCloneDir, 'commit', '-m', 'Remote edit'], { windowsHide: true });
    await execFileAsync('git', ['-C', secondCloneDir, 'push', 'origin', 'main'], { windowsHide: true });

    // Local also edits README.md differently and commits
    fs.writeFileSync(path.join(tmpMailboxDir, 'README.md'), '# Local Conflicting Change\n');
    await execFileAsync('git', ['-C', tmpMailboxDir, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpMailboxDir, 'commit', '-m', 'Local edit'], { windowsHide: true });

    // Attempt fetchAndRebase
    const result = await transport.fetchAndRebase();

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.error).toContain('mailbox_git_conflict');

    // Verify git rebase was cleanly aborted (not stuck in intermediate rebase state)
    const { stdout: status } = await execFileAsync('git', ['-C', tmpMailboxDir, 'status'], { windowsHide: true });
    expect(status).not.toContain('rebase in progress');

    try {
      fs.rmSync(secondCloneDir, { recursive: true, force: true });
    } catch {}
  });
});
