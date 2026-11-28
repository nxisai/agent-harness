/**
 * A value kept in the tab's `sessionStorage` for a few minutes, so a visitor
 * moving between a site's pages pays for a read once a session, not once a page.
 *
 * Blocked, full or missing storage, a corrupt entry and a clock that went
 * backwards all read as nothing cached: the caller fetches again.
 *
 * @module
 */

/** How long an entry is reused: ten minutes, as the site's actions and pages. */
export const SESSION_TTL_MS = 10 * 60 * 1000;

/** The tab's session storage, or null where it is unavailable or blocked. */
export function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The value under `key` when it was written within `ttl`, else null. */
export function readSession<T>(storage: Storage | null, key: string, now = Date.now(), ttl = SESSION_TTL_MS): T | null {
  try {
    const e = JSON.parse(storage?.getItem(key) || 'null') as { at: number; v: T } | null;
    return e && typeof e.at == 'number' && e.at <= now && now - e.at <= ttl && e.v != null ? e.v : null;
  } catch {
    return null;
  }
}

/** Keep `value` under `key`; a storage that refuses it costs a refetch, nothing more. */
export function writeSession(storage: Storage | null, key: string, value: unknown, now = Date.now()): void {
  try {
    storage?.setItem(key, JSON.stringify({ at: now, v: value }));
  } catch {
    /* full or blocked */
  }
}
