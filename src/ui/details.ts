/**
 * The visitor's details for one conversation: the profile's conversation layer.
 *
 * The element's profile (`element.preferences`, mapped onto forms by {@link PROFILE_ALIASES}) is the host's, and
 * lasts as long as the element (or, with `persist`, on this origin). What the visitor types or confirms in a
 * conversation (a form they send, a target's step they continue, a target's review card they confirm) is kept here,
 * with that conversation only: it is saved with the conversation's messages, goes with it when it is deleted, and a new
 * conversation starts without it. The profile the agent reads is the host's with these over it.
 *
 * The details travel to an agent target as the handoff envelope's `contact`, so the next agent doesn't ask again.
 * Only these keys are kept: they are the ones a form of any agent here asks for again.
 *
 * @module
 */
import { PROFILE_ALIASES } from './config.js';
import { CONTACT_FIELDS, readContact, type HandoffContact } from '../handoff/envelope.js';

/** Profile keys that carry over, each with its name in a handoff's `contact`. */
export const DETAIL_KEYS = { name: 'name', email: 'email', phone: 'phone', address: 'street', city: 'city', zip: 'zip' } as const satisfies Record<string, (typeof CONTACT_FIELDS)[number]>;

export type DetailKey = keyof typeof DETAIL_KEYS;

const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const MAX = 200;

/** A value as kept: a string without control characters, trimmed and short; '' for anything else. */
function tidy(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX) : '';
}

/** The detail a field is, by its name: only when the name is one of the key's aliases (no partial match). */
export function detailOf(field: string): DetailKey | null {
  const n = norm(field);
  for (const key of Object.keys(DETAIL_KEYS) as DetailKey[]) {
    if ((PROFILE_ALIASES[key] ?? [key]).some((a) => norm(a) === n)) return key;
  }
  return null;
}

/**
 * The details among values the visitor sent, by profile key. A field counts only when its name is a detail's alias
 * exactly, and its value a non-empty string: a field left blank changes nothing.
 */
export function detailsFromFields(values: unknown): Partial<Record<DetailKey, string>> {
  const out: Partial<Record<DetailKey, string>> = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return out;
  for (const [field, v] of Object.entries(values as Record<string, unknown>)) {
    const key = detailOf(field);
    const t = tidy(v);
    if (key && t && out[key] === undefined) out[key] = t;
  }
  return out;
}

/** A handoff's `contact`, as profile keys (its `street` is the profile's `address`). */
export function detailsFromContact(contact: unknown): Partial<Record<DetailKey, string>> {
  const c = readContact(contact);
  const out: Partial<Record<DetailKey, string>> = {};
  if (!c) return out;
  for (const [key, field] of Object.entries(DETAIL_KEYS) as [DetailKey, keyof HandoffContact][]) {
    if (c[field]) out[key] = c[field];
  }
  return out;
}

/** The profile's details as a handoff's `contact`; undefined when it has none. */
export function contactFromProfile(profile: Record<string, string>): HandoffContact | undefined {
  const raw: Record<string, string> = {};
  for (const [key, field] of Object.entries(DETAIL_KEYS)) {
    const t = tidy(profile[key]);
    if (t) raw[field] = t;
  }
  return readContact(raw) ?? undefined;
}

/** `kept` with `patch` over it; null when nothing changed. */
export function mergeDetails(kept: Record<string, string> | undefined, patch: Partial<Record<DetailKey, string>>): Record<string, string> | null {
  const next = { ...(kept ?? {}) };
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (v && next[k] !== v) {
      next[k] = v;
      changed = true;
    }
  }
  return changed ? next : null;
}

/** The event a target's card sends for "Not you? Clear details": the page clears the conversation's details first. */
export const CLEAR_DETAILS_EVENT = 'clear_details';
