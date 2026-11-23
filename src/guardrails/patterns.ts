/**
 * What secrets and encoded payloads look like, for the tool, output and handoff stages.
 *
 * Patterns, so a signal: a key in a format not listed here gets through, and a value that only looks like one is
 * refused. Both are cheaper than a key leaving the page.
 *
 * @module
 */

/** Keys and tokens in the formats their issuers use, and `password=…` style pairs. */
const SECRET_SOURCES = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, // OpenAI, Anthropic
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // a JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
  /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd|pwd)\s*[:=]\s*["']?[^\s"',;]{6,}/i,
];

/** One pattern matching any secret, globally, for redacting. */
export const SECRET = new RegExp(SECRET_SOURCES.map((r) => `(?:${r.source})`).join('|'), 'gi');

/** Whether text holds something that looks like a secret. */
export const hasSecret = (text: string): boolean => {
  SECRET.lastIndex = 0;
  const found = SECRET.test(text);
  SECRET.lastIndex = 0;
  return found;
};

/** Text with every secret-looking span replaced. */
export const withoutSecrets = (text: string, mark = '[withheld]'): string => text.replace(SECRET, mark);

/**
 * Whether text carries an encoded blob: a run of 80 or more Base64 characters mixing upper case, lower case and
 * digits (a slug or a word doesn't), or 64 or more hex digits.
 */
export function hasEncoded(text: string): boolean {
  if (/\b[0-9a-fA-F]{64,}\b/.test(text)) return true;
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{80,}={0,2}/g)) {
    if (/[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /\d/.test(m[0])) return true;
  }
  return false;
}

/** Every string in a value, however deep. */
export function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out, depth + 1);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out, depth + 1);
  return out;
}
