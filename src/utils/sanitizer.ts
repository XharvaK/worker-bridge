/**
 * Secret & Credential Sanitizer.
 * Redacts tokens, keys, authorization headers, and cookies from output and logs.
 */

const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // GitHub tokens (gho_, ghp_, ghs_, ghr_, github_pat_)
  {
    pattern: /(gh[opusr]_[A-Za-z0-9_]{20,255})/g,
    replacement: '[REDACTED_GITHUB_TOKEN]'
  },
  {
    pattern: /(github_pat_[A-Za-z0-9_]{20,255})/g,
    replacement: '[REDACTED_GITHUB_PAT]'
  },
  // Bearer tokens & Authorization headers
  {
    pattern: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
    replacement: '$1[REDACTED_BEARER_TOKEN]'
  },
  {
    pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi,
    replacement: '$1[REDACTED_TOKEN]'
  },
  // Google / Gemini API Keys (AIzaSy...)
  {
    pattern: /(AIzaSy[A-Za-z0-9_-]{30,50})/g,
    replacement: '[REDACTED_GOOGLE_API_KEY]'
  },
  // Generic password/secret assignments
  {
    pattern: /((?:password|secret|token|api_key|apikey|private_key)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}(["']?)/gi,
    replacement: '$1[REDACTED_SECRET]$2'
  },
  // Private key blocks
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY_BLOCK]'
  }
];

export function sanitizeSecrets(text: string): string {
  if (!text) return '';
  let result = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
