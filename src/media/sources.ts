/**
 * A media element's files and captions, and the hosts that failed this session. Part of the lazily loaded player:
 * nothing here is imported by the chat at page load.
 *
 * @module
 */
import type { CaptionTrack, MediaModel } from '../harness/playable.js';

/** The session key the chat's gate reads (`BLOCKED_KEY` in harness/playable.ts). */
const BLOCKED_KEY = 'nxis:media-blocked';

/** Mark a media file's host blocked for the session: the chat draws its buttons as links to the page again. */
export function blockHost(src: string, storage: Storage | null = session()): void {
  try {
    const host = new URL(src).host;
    const all = JSON.parse(storage?.getItem(BLOCKED_KEY) ?? '[]') as unknown;
    const list = Array.isArray(all) ? all : [];
    if (!list.includes(host)) storage?.setItem(BLOCKED_KEY, JSON.stringify([...list, host]));
  } catch {
    // Not a URL, or no session: it fails again next time, and opens the page then.
  }
}

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function make<K extends 'source' | 'track'>(doc: Document, tag: K, attrs: Record<string, string>): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** A video's captions as `<track kind="captions">` elements, the first on by default. Added to a playing element,
 * they show without reloading it. */
export function addTracks(el: HTMLMediaElement, captions: CaptionTrack[] | undefined): void {
  el.querySelectorAll('track').forEach((t) => t.remove());
  (captions ?? []).forEach((c, i) =>
    el.append(make(el.ownerDocument, 'track', { kind: 'captions', src: c.src, ...(c.lang ? { srclang: c.lang } : {}), label: c.label ?? 'Captions', ...(i ? {} : { default: '' }) })),
  );
}

/**
 * Give a media element an item's files that this browser can play (HLS only where it is native; DASH never), and a
 * video's poster and captions, ready for `play()`. False when it can play none of them: the item opens its page
 * instead. Nothing is fetched until `play()`.
 */
export function loadSources(el: HTMLMediaElement, m: MediaModel): boolean {
  const ok = m.sources.filter((s) => !s.type || el.canPlayType(s.type) !== '');
  if (!ok.length) return false;
  el.removeAttribute('src');
  el.replaceChildren(...ok.map((s) => make(el.ownerDocument, 'source', { src: s.src, ...(s.type ? { type: s.type } : {}) })));
  if (m.kind === 'video') addTracks(el, m.captions);
  if (m.kind === 'video' && m.poster) el.setAttribute('poster', m.poster);
  else el.removeAttribute('poster');
  el.load();
  return true;
}
