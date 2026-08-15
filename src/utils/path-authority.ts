/**
 * Shared Windows-aware path canonicalization and containment authority.
 *
 * This module provides the authoritative path containment checks used by:
 * - Codex project configuration guard
 * - MCP trusted root enforcement
 * - Dynamic project preparation
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Canonicalize a filesystem path by resolving symlinks, junctions, and relative segments.
 * On Windows, normalizes the drive letter to lowercase for consistent comparison.
 */
export function canonicalizePath(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    // If the path doesn't exist yet, resolve without following symlinks
    resolved = path.resolve(p);
  }

  // Normalize Windows drive letter to lowercase for consistent comparison
  if (process.platform === 'win32' && /^[A-Z]:/.test(resolved)) {
    resolved = resolved[0].toLowerCase() + resolved.slice(1);
  }

  return resolved;
}

/**
 * Check whether a candidate path is contained within one or more root paths.
 * Resolves symlinks and junctions before comparison.
 * On Windows, performs case-insensitive comparison.
 *
 * UNC paths (\\server\share) are always rejected.
 *
 * @param candidate - The path to check
 * @param roots - One or more root paths that define the containment boundary
 * @returns true if the candidate resolves to a path under one of the roots
 */
export function isPathContained(candidate: string, roots: string[]): boolean {
  // Reject UNC paths on Windows
  if (process.platform === 'win32' && (candidate.startsWith('\\\\') || candidate.startsWith('//'))) {
    return false;
  }

  // Reject extended-length path prefix
  if (candidate.startsWith('\\\\?\\') || candidate.startsWith('\\\\.\\')) {
    return false;
  }

  let canonCandidate: string;
  try {
    canonCandidate = canonicalizePath(candidate);
  } catch {
    return false;
  }

  for (const root of roots) {
    let canonRoot: string;
    try {
      canonRoot = canonicalizePath(root);
    } catch {
      continue;
    }

    const relative = process.platform === 'win32'
      ? path.relative(canonRoot.toLowerCase(), canonCandidate.toLowerCase())
      : path.relative(canonRoot, canonCandidate);

    // Empty relative means they're the same path
    if (relative === '') return true;

    // Check that relative path doesn't escape
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return true;
    }
  }

  return false;
}

/**
 * Assert that a candidate path is contained within the given roots.
 * Throws an error with a descriptive message if containment fails.
 *
 * @param candidate - The path to check
 * @param roots - One or more root paths that define the containment boundary
 * @throws Error if the candidate escapes the containment boundary
 */
export function assertPathContained(candidate: string, roots: string[]): void {
  if (!isPathContained(candidate, roots)) {
    throw new Error(
      `PATH_ESCAPE: Path "${candidate}" is not contained within the authorized roots: ${roots.join(', ')}`
    );
  }
}
