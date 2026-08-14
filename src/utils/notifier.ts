import { spawn } from 'node:child_process';
import { logger } from './logger.js';

export interface NotificationOptions {
  title: string;
  message: string;
}

export async function sendWindowsNotification(options: NotificationOptions): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const cleanTitle = options.title.replace(/'/g, "''").replace(/"/g, '`"');
      const cleanMessage = options.message.replace(/'/g, "''").replace(/"/g, '`"');

      // Best-effort PowerShell script to trigger Windows balloon/toast notification
      const script = `
        [void] [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms");
        $notify = New-Object System.Windows.Forms.NotifyIcon;
        $notify.Icon = [System.Drawing.SystemIcons]::Information;
        $notify.BalloonTipTitle = "${cleanTitle}";
        $notify.BalloonTipText = "${cleanMessage}";
        $notify.BalloonTipIcon = "Info";
        $notify.Visible = $True;
        $notify.ShowBalloonTip(5000);
        Start-Sleep -Milliseconds 100;
        $notify.Dispose();
      `;

      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      });

      child.on('error', (err) => {
        logger.debug(`Notification spawn error (ignoring): ${err.message}`);
        resolve(false);
      });

      child.unref();
      resolve(true);
    } catch (err) {
      logger.debug(`Notification exception (ignoring): ${String(err)}`);
      resolve(false);
    }
  });
}
