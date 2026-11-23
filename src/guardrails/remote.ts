/**
 * The guardrails policy from the site's model proxy: `guardrails-src` on the element. A chunk of its own, loaded by
 * the guardrails only when the element names a source.
 *
 * The copy is fetched once, revalidated with its ETag (kept in `localStorage`), and fetched again when the proxy
 * says it holds another version. It is merged over the page's configuration tighten-only, on every read. If it
 * can't be fetched or read, nothing is merged: the page's configuration and the built-in defaults apply, and the
 * proxy still enforces its own copy. A copy that loaded once is kept when a later fetch fails: it can only be
 * stricter.
 *
 * @module
 */
import { parsePolicy, tightenWith, type BrowserPolicy, type MergeKit } from './policy-core.js';
import type { Guardrails, RemotePolicy } from './runtime.js';

const KEY = 'nxis-guardrails:';

/**
 * Fetch the proxy's policy for these guardrails, and keep it current.
 *
 * @param g - The runtime to attach to: its `remote` is set at once, and merges nothing until a policy has loaded.
 * @param src - Where the copy is served: the model proxy's endpoint, or any URL that answers with the copy.
 * @param kit - The guardrails' own `settingsFor` and `glob`, so this chunk carries no second copy of them.
 * @returns Once the first fetch has settled, loaded or not.
 */
export function attach(g: Guardrails, src: string, kit: MergeKit): Promise<void> {
  let policy: BrowserPolicy | null = null;
  let pending: Promise<void> | null = null;
  /** The version last asked for, so a proxy saying "v2" again doesn't fetch again while v2 won't load. */
  let asked: string | undefined;
  const hook: RemotePolicy = {
    merge: (c) => (policy ? tightenWith(c, policy, kit) : c),
    stale: (v) => {
      if (v === asked) return;
      asked = v;
      void load();
    },
  };
  g.remote = hook;

  const load = (): Promise<void> => (pending ??= fetchCopy().finally(() => (pending = null)));

  async function fetchCopy(): Promise<void> {
    let cached: { etag: string; body: string } | null = null;
    try {
      cached = JSON.parse(localStorage.getItem(KEY + src) ?? 'null');
    } catch {
      // No storage, or nothing usable in it.
    }
    try {
      const res = await fetch(src, {
        headers: { Accept: 'application/json', ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}) },
        credentials: 'same-origin',
        cache: 'no-cache',
      });
      let body: string;
      if (res.status === 304 && cached) body = cached.body;
      else if (res.ok) {
        body = await res.text();
        const etag = res.headers.get('ETag');
        try {
          if (etag) localStorage.setItem(KEY + src, JSON.stringify({ etag, body }));
          else localStorage.removeItem(KEY + src);
        } catch {
          // Not cached: fetched whole next time.
        }
      } else throw new Error(`${src} answered ${res.status}`);
      const p = parsePolicy(body);
      policy = p;
      hook.version = p.version;
      hook.held = p.prompt === 'proxy';
    } catch (err) {
      console.warn(`[nxis-guardrails] no policy from ${src}; ${policy ? 'keeping the one loaded' : 'using the built-in defaults'}:`, err);
    }
  }

  return load();
}
