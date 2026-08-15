/**
 * Per-platform environment variable filtering.
 *
 * Prevents cross-provider secret leakage by applying platform-specific
 * allowlists to the child process environment.
 */

/**
 * Defines which environment variables a platform's child processes are allowed to inherit.
 */
export interface PlatformEnvPolicy {
  /** Variable name prefixes to include (e.g., 'OPENAI_' includes OPENAI_API_KEY) */
  allowedPrefixes: string[];
  /** Exact variable names to include */
  allowedExact: string[];
  /** Windows-essential variables always included on win32 */
  windowsEssentials: string[];
}

/** Environment policy for Codex CLI workers */
export const CODEX_ENV_POLICY: PlatformEnvPolicy = {
  allowedPrefixes: ['CODEX_', 'OPENAI_', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'],
  allowedExact: ['PATH', 'HOME', 'USERPROFILE', 'USER', 'LANG', 'TERM', 'NODE_ENV'],
  windowsEssentials: [
    'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'WINDIR',
  ],
};

/** Environment policy for Antigravity (AGY) workers */
export const AGY_ENV_POLICY: PlatformEnvPolicy = {
  allowedPrefixes: ['GOOGLE_', 'GEMINI_', 'AGY_', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'],
  allowedExact: ['PATH', 'HOME', 'USERPROFILE', 'USER', 'LANG', 'TERM', 'NODE_ENV'],
  windowsEssentials: [
    'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'WINDIR',
  ],
};

/** Environment policy for OpenCode workers */
export const OPENCODE_ENV_POLICY: PlatformEnvPolicy = {
  allowedPrefixes: ['OPENCODE_', 'OPENROUTER_', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'],
  allowedExact: ['PATH', 'HOME', 'USERPROFILE', 'USER', 'LANG', 'TERM', 'NODE_ENV'],
  windowsEssentials: [
    'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'WINDIR',
  ],
};

/**
 * Filter environment variables according to a platform-specific policy.
 *
 * Only variables matching the policy's allowlists are included in the result.
 * On Windows, matching is case-insensitive for all checks.
 *
 * @param policy - The platform-specific environment policy
 * @param source - Source environment (defaults to process.env)
 * @returns Filtered environment record
 */
export function filterEnv(
  policy: PlatformEnvPolicy,
  source?: Record<string, string | undefined>,
): Record<string, string> {
  const env = source ?? (process.env as Record<string, string | undefined>);
  const result: Record<string, string> = {};
  const isWindows = process.platform === 'win32';

  const normalize = (s: string): string => isWindows ? s.toLowerCase() : s;

  const exactSet = new Set(policy.allowedExact.map(normalize));
  const essentialSet = new Set(
    isWindows ? policy.windowsEssentials.map(normalize) : [],
  );
  const prefixes = policy.allowedPrefixes.map(normalize);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;

    const normalizedKey = normalize(key);

    if (exactSet.has(normalizedKey)) {
      result[key] = value;
      continue;
    }

    if (essentialSet.has(normalizedKey)) {
      result[key] = value;
      continue;
    }

    if (prefixes.some(prefix => normalizedKey.startsWith(normalize(prefix)))) {
      result[key] = value;
      continue;
    }
  }

  return result;
}
