/**
 * Screening: injection phrases, invisible characters, encoded payloads and exfiltration through URLs.
 *
 * A signal, never a boundary (OWASP LLM Prompt Injection Prevention Cheat Sheet, "Input validation and
 * sanitization" and its limits). Paraphrases, other languages and other encodings get past phrase matching; the
 * boundary is the tiers, the bound approvals, the link and handoff rules, and the data blocks. Screening runs on a
 * normalised copy (NFKC, lower case, accents and invisible characters dropped) and on what Base64 and hex in the text
 * decode to, for inspection only: the visitor's text is never changed.
 *
 * @module
 */
import { INVISIBLE } from './context.js';
import { hasEncoded } from './patterns.js';

/** Overriding instructions or revealing the prompt, in English, Spanish, French and German. */
const INJECTION = new RegExp(
  [
    // English
    String.raw`\b(?:ignore|disregard|forget|override|bypass)\b.{0,40}\b(?:previous|prior|above|earlier|all|your|system|safety)\b.{0,20}\b(?:instructions?|prompts?|rules|directions|guidelines)\b`,
    String.raw`\b(?:reveal|show|print|repeat|output|tell me|give me|leak|dump)\b.{0,30}\b(?:system|hidden|initial|original|secret|developer)\s+(?:prompt|instructions?|message|rules)\b`,
    String.raw`\byou are now\b.{0,30}\b(?:dan|unrestricted|unfiltered|jailbroken|developer mode|no (?:rules|limits))\b`,
    String.raw`\b(?:developer|god|jailbreak|dan) mode\b`,
    String.raw`\bnew (?:system )?instructions?\s*:`,
    // Spanish
    String.raw`\b(?:ignora|olvida|omite)\b.{0,30}\binstrucciones\b`,
    String.raw`\b(?:muestra|revela|repite|dime)\b.{0,30}\b(?:prompt|instrucciones) del sistema\b`,
    // French
    String.raw`\b(?:ignore[rz]?|oublie[rz]?)\b.{0,30}\b(?:instructions|consignes)\b`,
    String.raw`\b(?:revele[rz]?|montre[rz]?|affiche[rz]?|repete[rz]?)\b.{0,30}\b(?:prompt|instructions) (?:systeme|initiales?)\b`,
    // German
    String.raw`\b(?:ignorier\w*|vergiss|missachte\w*)\b.{0,40}\b(?:anweisungen|instruktionen|regeln)\b`,
    String.raw`\b(?:zeig\w*|verrat\w*|wiederhol\w*|gib)\b.{0,30}\b(?:system-?prompt|systemanweisungen)\b`,
  ].join('|'),
  'i',
);

/** A copy for matching: NFKC, lower case, accents and invisible characters gone, runs of space collapsed. */
export const forMatching = (text: string): string =>
  String(text ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

/** Whether text has zero-width, bidi or Unicode tag characters. */
export const hasInvisible = (text: string): boolean => new RegExp(INVISIBLE.source).test(text);

/** Mostly printable: decoded bytes that read as text. */
const readable = (s: string): boolean => s.length >= 8 && (s.match(/[\x20-\x7e\s]/g)?.length ?? 0) / s.length > 0.9;

/** What the Base64 and hex runs in text decode to, where that reads as text. For inspection only. */
export function decodings(text: string): string[] {
  const out: string[] = [];
  for (const [m] of text.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
    try {
      const d = atob(m.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(m.length / 4) * 4, '='));
      if (readable(d)) out.push(d);
    } catch {
      // Not Base64.
    }
  }
  for (const [, m] of text.matchAll(/(?<![0-9a-z])(?:0x)?((?:[0-9a-f]{2}){8,})(?![0-9a-z])/gi)) {
    const d = m.replace(/../g, (h) => String.fromCharCode(parseInt(h, 16)));
    if (readable(d)) out.push(d);
  }
  return out;
}

/** Whether text, or what it decodes to, reads as an injection attempt. */
export const injected = (text: string): boolean => [text, ...decodings(text)].some((t) => INJECTION.test(forMatching(t)));

/** Shannon entropy, in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** A value that reads as a payload: encoded, or 32+ characters of high-entropy letters and digits with no words. */
const payload = (v: string): boolean =>
  hasEncoded(v) || (v.length >= 32 && !/[\s-]/.test(v) && /\d/.test(v) && /[a-z]/i.test(v) && entropy(v) > 4.2);

/**
 * Whether a URL looks like it carries data out: a query value or the fragment that reads as a payload, or a path
 * segment that is encoded. A slug, a search or an ordinary tracking parameter isn't.
 */
export function exfiltrates(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url, typeof location === 'undefined' ? 'https://localhost/' : location.href);
  } catch {
    return false;
  }
  let hash = u.hash.slice(1);
  try {
    hash = decodeURIComponent(hash);
  } catch {
    // Kept as written.
  }
  return [...u.searchParams.values(), hash].some(payload) || u.pathname.split('/').some(hasEncoded);
}

/** Every http(s) URL written in text. */
export const urlsIn = (text: string): string[] => [...String(text ?? '').matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)].map((m) => m[0]);

/** Origins from a `link-origins` list: whitespace or commas between them, anything that doesn't parse dropped. */
export function originsOf(list: string | string[] | null | undefined): string[] {
  const items = Array.isArray(list) ? list : String(list ?? '').split(/[\s,]+/);
  return items
    .map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return '';
      }
    })
    .filter((o) => o && o !== 'null');
}
