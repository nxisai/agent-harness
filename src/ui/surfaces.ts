/**
 * A handoff target's step surfaces in the thread: the Quote and Booking steps, drawn as A2UI under the reply that
 * brought them, and the visitor's choices sent back on the same task.
 *
 * The element loads this with a dynamic `import()` with the first reply that has a `surface` part (or a stored
 * conversation that holds one), so a page that never hands a conversation to such a target pays nothing for it.
 *
 * - **Where a surface goes**: a `createSurface` draws a card under its message's bubble; one sent again for an id
 *   already drawn replaces the earlier card. Updates (`updateComponents`, `updateDataModel`) go to the live card
 *   wherever it is, and are folded into what the conversation keeps, so a reload draws the card as it last was.
 *   `deleteSurface` removes it. At most {@link LIMITS}.surfaces per conversation: the oldest goes first.
 * - **A choice or a press** is sent to the target as an `action` part with the visitor's words beside it
 *   (see docs/quote-booking-surfaces.md). `nxis.back` and `nxis.open` are the page's own, never sent.
 * - **Only the visitor commits**: `commit` and `consent` are set only for a ConfirmCard's confirm button, read from
 *   the component that sent it, never from what the target wrote.
 * - **One at a time**: once an action is sent, every surface is inert until the target answers; a confirmed
 *   ConfirmCard's surface stays done until the target sends it again.
 * - **Superseded**: when the handoff is over, and once a later reply draws a new surface, the earlier ones (those
 *   no reply has touched since) are inert for good: dimmed, their countdowns stopped, and nothing they hold sent.
 * - **Unsent edits** are kept with the conversation, per surface, and drawn again after a reload; they go once the
 *   surface sends, is superseded or is drawn anew.
 *
 * Everything is data from another server, read strictly first (`a2ui/steps.ts`). It imports nothing at run time
 * that the page-load code has: the renderer, Lit and zod arrive in {@link SurfacesHost.kit}.
 *
 * @module
 */
import type { A2uiMessage } from '../a2ui/emit.js';
import type { MountedSurface, mountSurface } from '../a2ui/host.js';
import { COMMIT_KEY, LIMITS, PAGE_EVENTS, fold, readSurfaceMessages, surfaceIdOf, type ConfirmRow, type SurfaceAction, type SurfaceEntry } from '../a2ui/steps.js';
import { CITE_EVENT, DOWNLOAD_EVENT, OPEN_EVENT, stepsCatalog, type StepsKit } from '../a2ui/steps-catalog.js';

/** A thread item that can hold surfaces: a target's reply. */
export interface SurfaceItem {
  surface?: SurfaceEntry[];
  /** Its surfaces include a `ReceiptCard`: what the target did is done (the handoff bar says so). */
  receipt?: boolean;
}

/** What the surfaces need of the element. */
export interface SurfacesHost {
  kit: StepsKit;
  mount: typeof mountSurface;
  /** Send an action to the target, with the visitor's words. Resolves false when it wasn't sent. */
  act(text: string, action: SurfaceAction): Promise<boolean>;
  /** Open a link, after the guardrails' navigation check, keeping the conversation for a page of this site. */
  go(url: string, name: string): void;
  /** Origins a surface's links may open besides this page's: `link-origins`, and the relay's. */
  origins(): string[];
  /** Back to the assistant. */
  back(): void;
  /** Whether the conversation on screen is still handed off. */
  live(): boolean;
  /** Keep the conversations. */
  save(): void;
}

// A step surface spans the panel, and its basic fields' labels read as the step components' do: one color, size
// and weight for a ChoicePicker's and a TextField's alike.
const CSS = `
.surface { width: 100%; margin-top: 6px; }
.surface.a2ui-scope {
  --a2ui-choicepicker-label-color: var(--ink); --a2ui-choicepicker-label-font-size: 13px; --a2ui-choicepicker-label-font-weight: 600;
  --a2ui-textfield-label-font-size: 13px; --a2ui-textfield-label-font-weight: 600;
  --a2ui-checkbox-label-font-size: 13px;
}
.surface[aria-busy="true"] { cursor: progress; }
.surface.is-off:not([aria-busy="true"]) { opacity: .62; }
.surface[data-stale] { opacity: .4; filter: grayscale(1); cursor: not-allowed; }
/* A superseded surface's buttons all read as off, the basic ones (Change details) as its step components' do. */
.surface.a2ui-scope[data-stale] { --a2ui-button-background: var(--surface); --a2ui-button-border: 1px dashed var(--border-strong); --a2ui-color-primary: var(--surface); --a2ui-color-on-primary: var(--ink-3); --a2ui-color-on-secondary: var(--ink-3); --blue: var(--border-strong); --on-blue: var(--ink-3); --off-bg: var(--surface); --off-ink: var(--ink-3); --off-line: dashed; }
.remote.has-surface { max-width: 100%; width: 100%; }
.remote.has-surface > .msg { align-self: flex-start; }
`;

interface Live {
  wrap: HTMLElement;
  mounted: MountedSurface;
  entry: SurfaceEntry;
}

/** Every element under `root` that matches `sel`, through the components' shadow roots. */
function deepAll(root: Element | ShadowRoot, sel: string, out: HTMLElement[] = []): HTMLElement[] {
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.matches(sel)) out.push(el);
    if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
  }
  return out;
}

/**
 * A card that is over (superseded, sent, or its agent gone) can't be used and reads that way to assistive tech too:
 * its buttons and fields are disabled, not only out of reach. Those it turned off come back if it is live again.
 */
function disable(wrap: HTMLElement, off: boolean): void {
  for (const c of deepAll(wrap, off ? 'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])' : '[data-nxis-off]') as HTMLButtonElement[]) {
    c.disabled = off;
    c.toggleAttribute('data-nxis-off', off);
  }
}

/** Move to a Sources row and light it up for a moment, as the reply's own markers do. */
function highlight(row: HTMLElement): void {
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: 'nearest' });
  row.classList.add('ra-hl');
  setTimeout(() => row.classList.remove('ra-hl'), 1600);
}

/** The surfaces of one element's conversations. */
export class Surfaces {
  private live = new Map<string, Live>();
  private busy = false;
  private typing?: ReturnType<typeof setTimeout>;
  /** The card edited last, while its trailing save is due. */
  private editing?: SurfaceEntry;

  constructor(private host: SurfacesHost) {
    // A reload or a closed tab never beats the visitor's last edit.
    const flush = () => this.editing && this.keep(this.editing);
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  }

  /**
   * Take a reply's surface messages: a new surface goes on `item`, an update to the surface it names wherever that
   * is in `items`.
   *
   * @param items - The conversation's items; `item` among them or about to be.
   * @returns Whether `item` now holds a surface of its own (and so needs drawing).
   */
  receive(items: unknown[], item: SurfaceItem, raw: unknown): boolean {
    this.busy = false;
    const holders = () => [...(items as SurfaceItem[]).filter((it) => it !== item), item];
    // This reply's number: one more than any before it touched.
    const at = 1 + Math.max(0, ...holders().flatMap((it) => (it.surface ?? []).map((e) => e.at ?? 0)));
    for (const m of readSurfaceMessages(raw)) {
      const id = surfaceIdOf(m);
      const owner = holders().find((it) => it.surface?.some((e) => e.id === id));
      const entry = owner?.surface?.find((e) => e.id === id);
      if (m.createSurface) {
        if (owner) this.drop(owner, id);
        (item.surface ??= []).push({ id, create: m, made: at, at });
        const all = holders().flatMap((it) => (it.surface ?? []).map((e) => [it, e.id] as const));
        for (const [it, old] of all.slice(0, Math.max(0, all.length - LIMITS.surfaces))) this.drop(it, old);
      } else if (owner && entry) {
        if (m.deleteSurface) {
          this.drop(owner, id);
          continue;
        }
        fold(entry, m);
        entry.at = at;
        const on = this.live.get(id);
        if (on?.entry === entry) this.send(on, m);
      }
    }
    item.receipt = !!item.surface?.some((e) => JSON.stringify(e.create).includes('"component":"ReceiptCard"'));
    this.sync();
    this.host.save();
    return !!item.surface?.length;
  }

  /** Draw `item`'s surfaces at the end of `el`, its reply's element. */
  paint(el: HTMLElement, item: SurfaceItem): void {
    const root = el.getRootNode() as ShadowRoot | Document;
    const styles = root instanceof ShadowRoot ? root : el.ownerDocument.head;
    if (!styles.querySelector('style[data-surfaces]')) {
      const style = el.ownerDocument.createElement('style');
      style.dataset.surfaces = '';
      style.textContent = CSS;
      styles.append(style);
    }
    for (const entry of item.surface ?? []) {
      const wrap = el.ownerDocument.createElement('div');
      wrap.className = 'surface a2ui a2ui-scope';
      wrap.dataset.surface = entry.id;
      el.append(wrap);
      el.classList.add('has-surface');
      wrap.addEventListener(CITE_EVENT, (e) => {
        const row = el.querySelector<HTMLElement>(`.ra-srow[data-n="${Number((e as CustomEvent).detail)}"]`);
        if (row) highlight(row);
      });
      wrap.addEventListener(OPEN_EVENT, (e) => {
        const { url, name } = (e as CustomEvent<{ url: string; name: string }>).detail;
        this.open(url, name);
      });
      wrap.addEventListener(DOWNLOAD_EVENT, (e) => this.download((e as CustomEvent<{ url: string }>).detail.url));
      // A press sends what is on screen: the fields' values go into the card's data before its button reads them.
      wrap.addEventListener('click', () => deepAll(wrap, 'nxis-step-textfield').forEach((f: any) => f.flush?.()), true);
      for (const type of ['input', 'change', 'click']) wrap.addEventListener(type, () => this.edited(entry));
      this.mount(wrap, entry);
    }
    this.sync();
  }

  /** Re-draw the surfaces' state: inert while an action is out, once done, and once superseded. */
  sync(answered = false): void {
    if (answered) this.busy = false;
    const live = this.host.live();
    for (const [id, on] of this.live) if (!on.wrap.isConnected) this.live.delete(id);
    const newest = Math.max(0, ...[...this.live.values()].map((on) => on.entry.made ?? 0));
    let dropped = false;
    for (const on of this.live.values()) {
      const stale = !live || (on.entry.at ?? 0) < newest;
      if (stale && on.entry.draft) dropped = delete on.entry.draft;
      const off = this.busy || stale || !!on.entry.done;
      on.wrap.toggleAttribute('inert', off);
      const over = stale || !!on.entry.done;
      disable(on.wrap, over);
      // Its components draw a moment after it mounts: those too.
      if (over) setTimeout(() => (on.wrap.hasAttribute('data-stale') || on.entry.done) && disable(on.wrap, true), 50);
      on.wrap.toggleAttribute('data-stale', stale);
      on.wrap.classList.toggle('is-off', off);
      on.wrap.setAttribute('aria-busy', String(this.busy && live));
    }
    if (dropped) this.host.save();
  }

  /**
   * The visitor changed something on a live surface: its data model, kept as their unsent edits at once (a reload
   * right after typing keeps it), and again a moment later for a change the card makes after the event.
   */
  private edited(entry: SurfaceEntry): void {
    this.keep(entry);
    this.editing = entry;
    clearTimeout(this.typing);
    this.typing = setTimeout(() => {
      this.editing = undefined;
      this.keep(entry);
    }, 250);
  }

  private keep(entry: SurfaceEntry): void {
    const on = this.live.get(entry.id);
    if (on?.entry !== entry || on.wrap.hasAttribute('inert')) return;
    const json = JSON.stringify(on.mounted.read('') ?? {});
    if (json.length > LIMITS.bytes || json === JSON.stringify(entry.draft ?? null)) return;
    entry.draft = JSON.parse(json);
    this.host.save();
  }

  private mount(wrap: HTMLElement, entry: SurfaceEntry): void {
    const prior = this.live.get(entry.id);
    if (prior && prior.wrap !== wrap) prior.mounted.dispose();
    try {
      // A copy: what the visitor changes on the card stays in the renderer (and their unsent edits), not in what the
      // conversation keeps.
      const create = entry.draft ? { ...entry.create, createSurface: { ...(entry.create.createSurface as object), dataModel: entry.draft } } : entry.create;
      const mounted = this.host.mount(wrap, [JSON.parse(JSON.stringify(create)) as A2uiMessage], (e: any) => void this.act(entry, e), stepsCatalog(this.host.kit));
      if (!mounted) throw new Error('no surface');
      this.live.set(entry.id, { wrap, mounted, entry });
    } catch (err) {
      console.warn(`[nxis] could not draw the surface "${entry.id}":`, err);
      wrap.remove();
    }
  }

  private send(on: Live, m: A2uiMessage): void {
    try {
      on.mounted.send([m]);
    } catch (err) {
      // An update the renderer refuses leaves the card as it was; a reload draws it from what was kept.
      console.warn(`[nxis] could not update the surface "${on.entry.id}":`, err);
    }
  }

  private drop(owner: SurfaceItem, id: string): void {
    owner.surface = owner.surface?.filter((e) => e.id !== id);
    const on = this.live.get(id);
    if (on && !owner.surface?.includes(on.entry)) {
      on.mounted.dispose();
      on.wrap.remove();
      this.live.delete(id);
    }
  }

  /**
   * A link a surface asked to open (Add to calendar, a `nxis.open` button): a phone number dials, and an https
   * address opens when it is on this page's origin or one of {@link SurfacesHost.origins}. Anything else stays shut.
   */
  open(url: string, name: string): void {
    if (/^tel:\+?[\d\s().-]{3,32}$/.test(url)) return Object.assign(document.createElement('a'), { href: url }).click();
    let to: URL;
    try {
      to = new URL(url, location.href);
    } catch {
      return;
    }
    if ((to.protocol === 'https:' || to.origin === location.origin) && [location.origin, ...this.host.origins()].includes(to.origin)) this.host.go(to.href, name);
  }

  /**
   * Save a file a surface links (a ReceiptCard's `.ics`): only from an origin its links may open (this page's, a
   * `link-origins` one or the relay's), over https. A plain download: no confirmation, no new window and no
   * navigation, since the file is served as an attachment (`Content-Disposition: attachment`), so the page stays.
   */
  download(url: string): void {
    let to: URL;
    try {
      to = new URL(url, location.href);
    } catch {
      return;
    }
    if (to.protocol !== 'https:' && to.origin !== location.origin) return;
    if (![location.origin, ...this.host.origins()].includes(to.origin)) return;
    const a = document.createElement('a');
    a.href = to.href;
    a.download = '';
    a.rel = 'noopener';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  }

  /** A choice or a press on a surface: the page's own, or sent to the target. */
  private async act(entry: SurfaceEntry, e: { name?: unknown; sourceComponentId?: unknown; context?: Record<string, unknown> }): Promise<void> {
    const name = String(e.name ?? '');
    const context = { ...(e.context ?? {}) };
    if (name === PAGE_EVENTS.back) return this.host.back();
    if (name === PAGE_EVENTS.open) return this.open(String(context.url ?? ''), String(context.label ?? ''));
    const on = this.live.get(entry.id);
    if (!name || this.busy || entry.done || !this.host.live() || !on || on.wrap.hasAttribute('data-stale')) return;
    const rows = context[COMMIT_KEY];
    // The page's keys are the page's, whatever component sent them.
    for (const k of Object.keys(context)) if (k.startsWith('nxis:')) delete context[k];
    const component = String(e.sourceComponentId ?? '');
    // A commit is a ConfirmCard's confirm button, and nothing else: read from the component, not the target's words.
    const type = on.mounted.processor.model.getSurface(entry.id)?.componentsModel.get(component)?.type;
    const commit = type === 'ConfirmCard' && Array.isArray(rows);
    const action: SurfaceAction = {
      handoff: 'action',
      surfaceId: entry.id,
      name,
      component,
      context,
      ...(commit ? { commit: true as const, consent: { rows: rows as ConfirmRow[], at: new Date().toISOString() } } : {}),
    };
    if (JSON.stringify(action).length > LIMITS.bytes) return console.warn('[nxis] a surface action is too large to send.');
    const text = (typeof context.label === 'string' && context.label.trim() ? context.label.trim() : name).slice(0, 500);
    this.busy = true;
    if (commit) entry.done = true;
    this.sync();
    this.host.save();
    if (await this.host.act(text, action)) {
      delete entry.draft;
      return this.host.save();
    }
    // Not sent: the card is the visitor's again, as it was before the press.
    this.busy = false;
    if (commit) {
      entry.done = false;
      this.host.save();
      on.mounted.dispose();
      on.wrap.replaceChildren();
      this.mount(on.wrap, entry);
    }
    this.sync();
  }
}
