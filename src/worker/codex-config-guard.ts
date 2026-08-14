import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectConfigAuthorityResult {
  allowed: boolean;
  inspectedFiles: string[];
  reason?: string;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ANCESTOR_DEPTH = 8;

const ALLOWED_TOP_LEVEL_KEYS = new Set(['model_reasoning_effort']);
const ALLOWED_SECTIONS = new Set(['model']);
const ALLOWED_SECTION_KEYS = new Map([['model', new Set(['reasoning_effort'])]]);
const CAPABILITY_WORDS = /(?:mcp|tool|hook|plugin|provider|endpoint|network|filesystem|file_system|elevation|sandbox|approval|permission|exec|command)/i;

function blocked(inspectedFiles: string[], detail: string): ProjectConfigAuthorityResult {
  return { allowed: false, inspectedFiles, reason: `PERMISSION_BLOCKED: ${detail}`.slice(0, 300) };
}

function stripComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && !escaped) quoted = !quoted;
    if (char === '#' && !quoted) return line.slice(0, index);
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  return line;
}

function inspectFile(filePath: string, inspectedFiles: string[]): ProjectConfigAuthorityResult | undefined {
  inspectedFiles.push(filePath);
  let content: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return blocked(inspectedFiles, 'configuration path is not a file');
    if (stat.size > MAX_CONFIG_BYTES) return blocked(inspectedFiles, 'oversized configuration');
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return blocked(inspectedFiles, 'unreadable configuration');
  }

  let section: string | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!ALLOWED_SECTIONS.has(section) && !CAPABILITY_WORDS.test(section)) {
        return blocked(inspectedFiles, `unknown section ${section}`);
      }
      if (!ALLOWED_SECTIONS.has(section)) return blocked(inspectedFiles, `capability-bearing section ${section}`);
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignment || !assignment[2].trim()) return blocked(inspectedFiles, 'invalid TOML');
    const key = assignment[1];
    const value = assignment[2].trim();
    const allowedKeys = section ? ALLOWED_SECTION_KEYS.get(section) : ALLOWED_TOP_LEVEL_KEYS;
    if (!allowedKeys?.has(key)) {
      return blocked(inspectedFiles, CAPABILITY_WORDS.test(`${section || ''}.${key}`) ? `capability-bearing key ${key}` : `unknown key ${key}`);
    }
    if (!/^(["']).*\1$/.test(value) && !/^(?:true|false|-?\d+(?:\.\d+)?)$/.test(value)) {
      return blocked(inspectedFiles, 'invalid TOML value');
    }
  }
  return undefined;
}

export function inspectCodexProjectConfig(worktreeCwd: string): ProjectConfigAuthorityResult {
  const inspectedFiles: string[] = [];
  const boundWorktree = path.resolve(worktreeCwd);
  let repositoryRoot = boundWorktree;
  let probe = boundWorktree;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    if (fs.existsSync(path.join(probe, '.git'))) {
      repositoryRoot = probe;
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  let current = boundWorktree;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    const configPath = path.join(current, '.codex', 'config.toml');
    if (fs.existsSync(configPath)) {
      const failure = inspectFile(configPath, inspectedFiles);
      if (failure) return failure;
    }
    const parent = path.dirname(current);
    if (parent === current || current === repositoryRoot) break;
    current = parent;
  }
  return { allowed: true, inspectedFiles };
}
