import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { isPathContained } from '../utils/path-authority.js';

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
const BASIC_STRING_ESCAPES = new Set(['b', 't', 'n', 'f', 'r', '"', '\\']);
const NUMBER_VALUE = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.(?:\d(?:_?\d)*))?(?:[eE][+-]?\d(?:_?\d)*)?$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

type PathState =
  | { kind: 'missing' }
  | { kind: 'symlink' }
  | { kind: 'directory'; size: number }
  | { kind: 'file'; size: number }
  | { kind: 'other'; size: number }
  | { kind: 'error'; code?: string };

function blocked(inspectedFiles: string[], detail: string): ProjectConfigAuthorityResult {
  return { allowed: false, inspectedFiles, reason: `PERMISSION_BLOCKED: ${detail}`.slice(0, 300) };
}

function pathState(filePath: string): PathState {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return { kind: 'symlink' };
    if (stat.isDirectory()) return { kind: 'directory', size: stat.size };
    if (stat.isFile()) return { kind: 'file', size: stat.size };
    return { kind: 'other', size: stat.size };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', code };
  }
}

export function hashInspectedConfigs(inspectedFiles: string[]): string | null {
  try {
    const hash = createHash('sha256');
    const sorted = [...inspectedFiles].sort();
    for (const filePath of sorted) {
      hash.update(filePath);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath);
        hash.update(content);
      } else {
        hash.update('__MISSING__');
      }
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function isValidBasicString(value: string): boolean {
  if (value.length < 2 || value[0] !== '"') return false;
  let index = 1;
  while (index < value.length) {
    const char = value[index];
    if (char === '"') return index === value.length - 1;
    if (char === '\\') {
      index += 1;
      if (index >= value.length) return false;
      const escape = value[index];
      if (BASIC_STRING_ESCAPES.has(escape)) {
        index += 1;
        continue;
      }
      if (escape === 'u' || escape === 'U') {
        const digits = escape === 'u' ? 4 : 8;
        const sequence = value.slice(index + 1, index + 1 + digits);
        if (sequence.length !== digits || !/^[0-9A-Fa-f]+$/.test(sequence)) return false;
        index += digits + 1;
        continue;
      }
      return false;
    }
    if (char < ' ') return false;
    index += 1;
  }
  return false;
}

function isValidLiteralString(value: string): boolean {
  if (value.length < 2 || value[0] !== "'" || value[value.length - 1] !== "'") return false;
  return !value.slice(1, -1).includes("'") && !/[\u0000-\u001f]/.test(value.slice(1, -1));
}

function isValidSupportedValue(value: string): boolean {
  if (isValidBasicString(value) || isValidLiteralString(value)) return true;
  if (value === 'true' || value === 'false') return true;
  return NUMBER_VALUE.test(value);
}

function stripTomlComment(line: string): string | undefined {
  let quote: 'basic' | 'literal' | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === 'basic') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = undefined;
      }
      continue;
    }
    if (quote === 'literal') {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === '"') quote = 'basic';
    else if (char === "'") quote = 'literal';
    else if (char === '#') return line.slice(0, index);
  }
  return quote || escaped ? undefined : line;
}

function validateTomlSubset(content: string): string | undefined {
  let section: string | undefined;
  const seenSections = new Set<string>();
  const seenKeys = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const uncommented = stripTomlComment(rawLine);
    if (uncommented === undefined) return 'invalid TOML syntax';
    const line = uncommented.trim();
    if (!line) continue;

    if (line.startsWith('[')) {
      const sectionMatch = line.match(/^\[([^\]]+)\]$/);
      if (!sectionMatch) return 'invalid TOML syntax';
      section = sectionMatch[1].trim();
      if (!section || !/^[A-Za-z0-9_-]+$/.test(section)) {
        return CAPABILITY_WORDS.test(section) ? `capability-bearing section ${section}` : 'invalid TOML syntax';
      }
      if (!ALLOWED_SECTIONS.has(section)) {
        return CAPABILITY_WORDS.test(section) ? `capability-bearing section ${section}` : `unknown section ${section}`;
      }
      if (seenSections.has(section)) return `duplicate section ${section}`;
      seenSections.add(section);
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment || !assignment[2].trim()) return 'invalid TOML syntax';
    const key = assignment[1];
    const value = assignment[2].trim();
    const allowedKeys = section ? ALLOWED_SECTION_KEYS.get(section) : ALLOWED_TOP_LEVEL_KEYS;
    if (!allowedKeys?.has(key)) {
      return CAPABILITY_WORDS.test(`${section || ''}.${key}`) ? `capability-bearing key ${key}` : `unknown key ${key}`;
    }
    const qualifiedKey = `${section || '<root>'}.${key}`;
    if (seenKeys.has(qualifiedKey)) return `duplicate key ${key}`;
    seenKeys.add(qualifiedKey);
    if (!isValidSupportedValue(value)) return 'invalid TOML value';
  }
  return undefined;
}

function readBounded(filePath: string): { content?: string; reason?: string } {
  let descriptor: number | undefined;
  let result: { content?: string; reason?: string };
  try {
    descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (read === 0) break;
      bytesRead += read;
    }
    if (bytesRead > MAX_CONFIG_BYTES) {
      result = { reason: 'oversized configuration' };
    } else {
      try {
        result = { content: utf8Decoder.decode(buffer.subarray(0, bytesRead)) };
      } catch {
        result = { reason: 'invalid UTF-8 configuration' };
      }
    }
  } catch {
    result = { reason: 'unreadable configuration' };
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch {
      return { reason: 'unreadable configuration' };
    }
  }
  return result;
}

function inspectFile(
  filePath: string,
  state: Extract<PathState, { kind: 'file' }>,
  inspectedFiles: string[],
  containmentRoots: string[]
): ProjectConfigAuthorityResult | undefined {
  inspectedFiles.push(filePath);
  if (!isPathContained(filePath, containmentRoots)) return blocked(inspectedFiles, 'configuration escapes the bounded worktree');
  let realFile: string;
  let realRoots: string[];
  try {
    realFile = fs.realpathSync(filePath);
    realRoots = containmentRoots.map((root) => fs.realpathSync(root));
  } catch {
    return blocked(inspectedFiles, 'configuration containment could not be verified');
  }
  if (!isPathContained(realFile, realRoots)) return blocked(inspectedFiles, 'configuration escapes the bounded worktree');
  if (state.size > MAX_CONFIG_BYTES) return blocked(inspectedFiles, 'oversized configuration');

  const read = readBounded(realFile);
  if (read.reason) return blocked(inspectedFiles, read.reason);
  const parseFailure = validateTomlSubset(read.content || '');
  return parseFailure ? blocked(inspectedFiles, parseFailure) : undefined;
}

function inspectCandidate(
  current: string,
  inspectedFiles: string[],
  containmentRoots: string[]
): ProjectConfigAuthorityResult | undefined {
  const codexDirectory = path.join(current, '.codex');
  const configPath = path.join(codexDirectory, 'config.toml');
  const directoryState = pathState(codexDirectory);
  if (directoryState.kind === 'missing') return undefined;
  if (directoryState.kind === 'error') return blocked(inspectedFiles, `configuration metadata unavailable (${directoryState.code || 'I/O error'})`);
  if (directoryState.kind === 'symlink') return blocked(inspectedFiles, 'symlinked configuration directory');
  if (directoryState.kind !== 'directory') return blocked(inspectedFiles, 'configuration path is not a directory');

  const fileState = pathState(configPath);
  if (fileState.kind === 'missing') return undefined;
  if (fileState.kind === 'error') return blocked(inspectedFiles, `configuration metadata unavailable (${fileState.code || 'I/O error'})`);
  if (fileState.kind === 'symlink') return blocked(inspectedFiles, 'symlinked configuration file');
  if (fileState.kind !== 'file') return blocked(inspectedFiles, 'configuration path is not a file');
  return inspectFile(configPath, fileState, inspectedFiles, containmentRoots);
}

function findRepositoryRoot(boundWorktree: string, inspectedFiles: string[]): string | ProjectConfigAuthorityResult {
  let current = boundWorktree;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    const gitState = pathState(path.join(current, '.git'));
    if (gitState.kind === 'error') return blocked(inspectedFiles, `repository metadata unavailable (${gitState.code || 'I/O error'})`);
    if (gitState.kind === 'symlink') return blocked(inspectedFiles, 'symlinked repository metadata');
    if (gitState.kind === 'directory' || gitState.kind === 'file') return current;
    const parent = path.dirname(current);
    if (parent === current) return boundWorktree;
    current = parent;
  }
  return boundWorktree;
}

export function inspectCodexProjectConfig(worktreeCwd: string): ProjectConfigAuthorityResult {
  const inspectedFiles: string[] = [];
  const boundWorktree = path.resolve(worktreeCwd);
  const repositoryRoot = findRepositoryRoot(boundWorktree, inspectedFiles);
  if (typeof repositoryRoot !== 'string') return repositoryRoot;
  const containmentRoots = [boundWorktree, repositoryRoot];

  let current = boundWorktree;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    const failure = inspectCandidate(current, inspectedFiles, containmentRoots);
    if (failure) return failure;
    if (current === repositoryRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { allowed: true, inspectedFiles };
}
