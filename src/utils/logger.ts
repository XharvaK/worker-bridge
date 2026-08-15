import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeSecrets } from './sanitizer.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export class Logger {
  private logFilePath: string | null = null;
  private minLevel: LogLevel = 'INFO';

  private levelOrder: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  };

  private useStderrOnly = false;

  constructor(options?: { logFilePath?: string; minLevel?: LogLevel; useStderrOnly?: boolean }) {
    if (options?.logFilePath) {
      this.logFilePath = options.logFilePath;
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    if (options?.minLevel) {
      this.minLevel = options.minLevel;
    }
    if (options?.useStderrOnly !== undefined) {
      this.useStderrOnly = options.useStderrOnly;
    }
  }

  setUseStderr(useStderr: boolean): void {
    this.useStderrOnly = useStderr;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelOrder[level] >= this.levelOrder[this.minLevel];
  }

  private formatMessage(level: LogLevel, message: string, context?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const ctxString = context ? ` ${JSON.stringify(context)}` : '';
    const raw = `[${timestamp}] [${level}] ${message}${ctxString}`;
    return sanitizeSecrets(raw);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>) {
    if (!this.shouldLog(level)) return;
    const formatted = this.formatMessage(level, message, context);
    if (this.useStderrOnly || process.env.WORKER_BRIDGE_MCP === '1') {
      process.stderr.write(formatted + '\n');
    } else if (level === 'ERROR') {
      console.error(formatted);
    } else if (level === 'WARN') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }

    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, formatted + '\n', 'utf8');
      } catch (err) {
        console.error(`Failed to write to log file: ${String(err)}`);
      }
    }
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.write('DEBUG', message, context);
  }

  info(message: string, context?: Record<string, unknown>) {
    this.write('INFO', message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.write('WARN', message, context);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.write('ERROR', message, context);
  }
}

export const logger = new Logger();
