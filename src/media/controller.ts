/**
 * The docked player: one media element, one item at a time, outside the conversation so its redraws never stop it.
 *
 * The element is created by the chat on the first Play tap and `play()` is called there, inside the tap, as iOS
 * requires; this module arrives a moment later (a dynamic `import()`) and adopts it. From then on every tap calls
 * {@link MediaController.toggle} synchronously.
 *
 * - **One at a time.** When ours starts, any `<audio>` or `<video>` playing on the page pauses; when the page's own
 *   player starts, ours pauses. Nothing advances to a next item.
 * - **Failure.** A Content-Security-Policy violation, an `error` from the element or its last source, or no frame
 *   15 s after Play marks the item's host blocked for the session, and the dock says "Can't play here", with the
 *   item's page; the chat turns its buttons back into links.
 * - **The panel.** Closed, audio goes on (a small button beside the launcher shows progress and pauses it) and video
 *   pauses. {@link MediaController.dispose} stops playback and lets the file go.
 * - **Reporting.** The first `playing` of each item per page load is reported (as `page_open`, through the chat), and
 *   every state change is an `nxis-media` DOM event for the site's own analytics.
 *
 * @module
 */
import type { MediaModel } from '../harness/playable.js';
import { addTracks, blockHost, loadSources } from './sources.js';
import { clockOf, glyph, PAUSE_D, PLAY_D, renderDock, type DockEls } from './dock.js';
import { MEDIA_DOCK_CSS } from './styles.js';

/** What the chat hears from the player. */
export interface MediaState {
  /** The item loaded, if any. */
  id: string | null;
  playing: boolean;
  kind?: 'audio' | 'video';
}

/** The `type` of an `nxis-media` event. */
export type MediaEventType = 'play' | 'pause' | 'ended' | 'error' | 'blocked';

/** Where the player lives, and who it tells. */
export interface MediaHost {
  /** Where the dock's styles go: the element's shadow root. */
  root: ShadowRoot | Document;
  /** The dock goes just before this: the status line under the conversation. */
  before: Element;
  /** The chat's launcher, which a closed panel's audio sits beside. */
  launcher?: HTMLElement;
  /** Where `nxis-media` events are dispatched: the chat element. */
  events?: EventTarget;
  /** Every change of item or of playing. */
  onState?(state: MediaState): void;
  /** The item can't play here; its host is now blocked for the session. */
  onBlocked?(item: MediaModel, reason: 'csp' | 'error' | 'stall'): void;
  /** The item played for the first time this page load. */
  onFirstPlay?(item: MediaModel): void;
}

/** How long Play may wait for a first frame before the item counts as unplayable here. */
export const STALL_MS = 15000;
const RATES = [1, 1.25, 1.5, 2];
/** Items reported this page load: once each, whichever controller played them. */
const reported = new Set<string>();

export class MediaController {
  readonly el: HTMLVideoElement;
  readonly dock: DockEls;
  current: MediaModel | null = null;
  private host: MediaHost;
  private stall: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  /** Where the item just loaded starts, until its metadata is in. */
  private seekTo: number | undefined;
  private panelOpen = true;
  private mini: HTMLButtonElement | null = null;
  private off = new AbortController();

  /**
   * @param el - The element the first tap created and started; a new one when omitted.
   */
  constructor(host: MediaHost, el?: HTMLVideoElement) {
    this.host = host;
    const doc = host.before.ownerDocument;
    this.el = el ?? doc.createElement('video');
    this.el.preload = 'none';
    this.el.playsInline = true;
    this.el.setAttribute('playsinline', '');
    this.dock = renderDock();
    if (!host.root.querySelector?.('style[data-md]')) {
      const style = doc.createElement('style');
      style.dataset.md = '';
      style.textContent = MEDIA_DOCK_CSS;
      (host.root instanceof Document ? doc.head : host.root).append(style);
    }
    this.dock.frame.append(this.el);
    host.before.before(this.dock.root);
    this.wire(doc);
  }

  /** Play `item` (or keep playing it): loads it if it is new, then `play()`, synchronously. False when the browser
   * can play none of its files. */
  play(item: MediaModel): boolean {
    if (this.current?.id !== item.id) {
      if (!loadSources(this.el, item)) return false;
      this.startAt(item.start);
      this.show(item);
    }
    this.start(this.el.play());
    return true;
  }

  /**
   * Take over an item the chat already started on {@link el} (the first tap, before this module arrived).
   *
   * @param started - What its `play()` returned.
   */
  adopt(item: MediaModel, started?: Promise<void>): void {
    // The first tap gave it one file to start with; the captions come now, without a reload.
    if (item.kind === 'video') addTracks(this.el, item.captions);
    this.startAt(item.start);
    this.show(item);
    this.start(started);
    // Its `play` came before this module did: catch up on what that event does.
    if (!this.el.paused) this.playing();
  }

  /** The tap on an item's button: pause it when it is the one playing, else play it. */
  toggle(item: MediaModel): boolean {
    if (this.current?.id === item.id && !this.el.paused) {
      this.el.pause();
      return true;
    }
    return this.play(item);
  }

  pause(): void {
    this.el.pause();
  }

  /** The chat's panel opened or closed: closed, audio goes on beside the launcher and video pauses. */
  panel(open: boolean): void {
    this.panelOpen = open;
    if (!open && this.current?.kind === 'video') this.el.pause();
    this.paintMini();
  }

  /** Stop, let the file go, and hide the dock. */
  close(): void {
    this.el.pause();
    this.clearStall();
    this.el.removeAttribute('src');
    this.el.replaceChildren();
    try {
      this.el.load();
    } catch {
      // Nothing to release.
    }
    this.current = null;
    this.seekTo = undefined;
    this.dock.root.hidden = true;
    this.dock.status.textContent = '';
    this.paintMini();
    this.state();
  }

  /** The chat is gone: stop, release, and take the dock and its listeners with it. */
  dispose(): void {
    this.close();
    this.off.abort();
    this.dock.root.remove();
  }

  // ── inside ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Start the item just loaded `seconds` in. Set before its metadata, `currentTime` is where playback starts; set
   * again once the metadata is in, for a browser that let the first go. Only for a new item: a resumed one carries on
   * where it was.
   */
  private startAt(seconds: number | undefined): void {
    this.seekTo = seconds && seconds > 0 ? seconds : undefined;
    this.seek();
  }

  private seek(): void {
    if (this.seekTo === undefined) return;
    try {
      this.el.currentTime = this.seekTo;
    } catch {
      // Not seekable yet: the metadata will say.
    }
    if (this.el.readyState >= 1) this.seekTo = undefined;
  }

  private show(item: MediaModel): void {
    const d = this.dock;
    this.current = item;
    this.started = false;
    d.root.hidden = false;
    d.frame.hidden = item.kind !== 'video';
    d.frame.style.setProperty('--md-aspect', item.aspect ?? '16 / 9');
    d.art.hidden = item.kind === 'video' || !item.poster;
    if (item.poster) d.art.src = item.poster;
    d.title.textContent = item.title;
    d.show.textContent = item.show ?? '';
    d.show.hidden = !item.show;
    d.tx.hidden = !item.transcript;
    d.txBody.textContent = item.transcript ?? '';
    d.txBody.hidden = true;
    d.tx.setAttribute('aria-expanded', 'false');
    d.page.hidden = !item.page;
    if (item.page) d.page.href = item.page;
    const pageLabel = item.kind === 'video' ? 'Video page' : 'Episode page';
    d.page.setAttribute('aria-label', pageLabel);
    d.page.title = pageLabel;
    d.status.className = 'md-status';
    d.status.textContent = '';
    this.el.playbackRate = 1;
    this.paintRate();
    this.paintTime();
    this.state();
  }

  /** Wait for the first frame; a refusal or a stall is a failure, and a pause the browser imposed is just a pause. */
  private start(started: Promise<void> | undefined): void {
    this.clearStall();
    if (!this.started) this.stall = setTimeout(() => this.fail('stall'), STALL_MS);
    started?.catch((err: { name?: string }) => {
      // NotAllowedError: the browser wanted a tap. AbortError: a pause or a new item came first. Neither is the host's.
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return this.clearStall();
      this.fail('error');
    });
  }

  private clearStall(): void {
    clearTimeout(this.stall);
    this.stall = undefined;
  }

  private fail(reason: 'csp' | 'error' | 'stall'): void {
    const item = this.current;
    if (!item) return;
    this.clearStall();
    this.el.pause();
    for (const s of item.sources) blockHost(s.src);
    const d = this.dock;
    d.status.className = 'md-status err';
    d.status.replaceChildren(`Can't play here. `);
    if (item.page) {
      const a = document.createElement('a');
      a.href = item.page;
      a.textContent = item.kind === 'video' ? 'Open the video page' : 'Open the episode page';
      d.status.append(a);
    }
    this.emit(reason === 'error' ? 'error' : 'blocked');
    this.host.onBlocked?.(item, reason);
  }

  private state(): void {
    this.host.onState?.({ id: this.current?.id ?? null, playing: !!this.current && !this.el.paused, ...(this.current ? { kind: this.current.kind } : {}) });
  }

  private emit(type: MediaEventType): void {
    const c = this.current;
    this.host.events?.dispatchEvent(
      new CustomEvent('nxis-media', { bubbles: true, composed: true, detail: { type, id: c?.id, kind: c?.kind, title: c?.title, page: c?.page } }),
    );
  }

  private paintTime(): void {
    const d = this.dock;
    const total = Number.isFinite(this.el.duration) && this.el.duration > 0 ? this.el.duration : this.current?.seconds ?? 0;
    const at = this.el.currentTime || 0;
    d.seek.max = String(Math.max(1, Math.round(total)));
    d.seek.value = String(Math.round(at));
    const text = `${clockOf(at)} of ${clockOf(total)}`;
    d.seek.setAttribute('aria-valuetext', text);
    d.time.textContent = `${clockOf(at)} / ${clockOf(total)}`;
    if (this.mini) this.mini.style.setProperty('--md-p', `${total ? Math.min(100, (at / total) * 100) : 0}%`);
  }

  private paintRate(): void {
    const r = this.el.playbackRate;
    this.dock.rate.textContent = `${r}×`;
    this.dock.rate.setAttribute('aria-label', `Playback speed: ${r}×`);
  }

  private paintPlaying(): void {
    const on = !this.el.paused;
    this.dock.pp.setAttribute('aria-pressed', String(on));
    this.dock.pp.setAttribute('aria-label', on ? 'Pause' : 'Play');
    this.paintMini();
    this.state();
  }

  /** While the panel is closed and audio plays (or is paused mid-way), a small button beside the launcher. */
  private paintMini(): void {
    // The launcher is position: fixed, so it has no offsetParent; it is on screen when it has a box.
    const want = !this.panelOpen && this.current?.kind === 'audio' && !!this.host.launcher?.getClientRects().length;
    if (!want) {
      this.mini?.remove();
      this.mini = null;
      return;
    }
    if (!this.mini) {
      this.mini = document.createElement('button');
      this.mini.type = 'button';
      this.mini.className = 'md-mini';
      this.mini.addEventListener('click', () => (this.el.paused ? this.start(this.el.play()) : this.el.pause()));
      this.host.launcher!.after(this.mini);
    }
    // Beside the launcher, from where its styles put it (its box may still be moving as the panel closes).
    const l = this.host.launcher!;
    const cs = getComputedStyle(l);
    const size = l.getBoundingClientRect();
    this.mini.style.right = `${Math.round((parseFloat(cs.right) || 20) + size.width + 8)}px`;
    this.mini.style.bottom = `${Math.round((parseFloat(cs.bottom) || 20) + (size.height - 40) / 2)}px`;
    const on = !this.el.paused;
    this.mini.replaceChildren(glyph(on ? PAUSE_D : PLAY_D));
    this.mini.setAttribute('aria-label', `${on ? 'Pause' : 'Play'} ${this.current!.title}`);
    this.paintTime();
  }

  /** Ours started: whatever the page itself is playing stops. */
  private playing(): void {
    for (const m of this.el.ownerDocument.querySelectorAll<HTMLMediaElement>('audio, video')) if (m !== this.el && !m.paused) m.pause();
    this.emit('play');
    this.paintPlaying();
  }

  private seekBy(s: number): void {
    const max = Number.isFinite(this.el.duration) ? this.el.duration : Infinity;
    this.el.currentTime = Math.max(0, Math.min(max, (this.el.currentTime || 0) + s));
    this.paintTime();
  }

  private wire(doc: Document): void {
    const { signal } = this.off;
    const on = <K extends string>(t: EventTarget, type: K, fn: (e: Event) => void, capture = false) => t.addEventListener(type, fn, { signal, capture });
    const el = this.el;
    const d = this.dock;

    on(el, 'play', () => this.playing());
    on(el, 'playing', () => {
      this.started = true;
      this.clearStall();
      const c = this.current;
      if (c && !reported.has(c.id)) {
        reported.add(c.id);
        this.host.onFirstPlay?.(c);
      }
    });
    on(el, 'loadedmetadata', () => this.seek());
    on(el, 'loadeddata', () => {
      this.started = true;
      this.clearStall();
    });
    on(el, 'pause', () => {
      this.emit('pause');
      this.paintPlaying();
    });
    on(el, 'ended', () => {
      this.emit('ended');
      this.paintPlaying();
    });
    on(el, 'timeupdate', () => this.paintTime());
    on(el, 'durationchange', () => this.paintTime());
    on(el, 'ratechange', () => this.paintRate());
    // The element's own error, or its last source's: nothing left to try.
    on(el, 'error', (e) => {
      if (!this.current) return;
      const t = e.target as Element;
      if (t === el || (t.tagName === 'SOURCE' && !t.nextElementSibling?.matches('source'))) this.fail('error');
    }, true);
    // The page's own player started: ours stops. Ours is in a shadow root, so its events never reach here.
    on(doc, 'play', (e) => {
      if (e.target !== el && e.target instanceof HTMLMediaElement) el.pause();
    }, true);
    // A Content-Security-Policy that refuses the file.
    on(doc, 'securitypolicyviolation', (e) => {
      const v = e as SecurityPolicyViolationEvent;
      const c = this.current;
      if (!c || !/^media-src|^default-src/.test(v.effectiveDirective || v.violatedDirective || '')) return;
      const hosts = c.sources.map((s) => new URL(s.src).host);
      try {
        if (hosts.includes(new URL(v.blockedURI).host)) this.fail('csp');
      } catch {
        this.fail('csp');
      }
    });

    on(d.pp, 'click', () => (el.paused ? this.start(el.play()) : el.pause()));
    on(d.seek, 'input', () => {
      el.currentTime = Number(d.seek.value);
      this.paintTime();
    });
    on(d.rate, 'click', () => {
      el.playbackRate = RATES[(RATES.indexOf(el.playbackRate) + 1) % RATES.length];
      this.paintRate();
    });
    on(d.tx, 'click', () => {
      const open = d.txBody.hidden;
      d.txBody.hidden = !open;
      d.tx.setAttribute('aria-expanded', String(open));
    });
    on(d.close, 'click', () => this.close());
    // Keyboard, as video players do: Space or K plays and pauses, ←/→ 5 s, J/L 10 s. Space on a control is the
    // control's own; the range input keeps its arrows.
    on(d.root, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as Element;
      const control = t.closest('button, a, input');
      const k = e.key.toLowerCase();
      if (k === 'k' || (k === ' ' && !control)) el.paused ? this.start(el.play()) : el.pause();
      else if ((k === 'arrowleft' || k === 'arrowright') && !t.matches('input')) this.seekBy(k === 'arrowleft' ? -5 : 5);
      else if (k === 'j' || k === 'l') this.seekBy(k === 'j' ? -10 : 10);
      else return;
      e.preventDefault();
    });
  }
}
