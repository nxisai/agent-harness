/**
 * A handoff target's answer with inline citations: a numbered marker after each claim in the reply, and a
 * **Sources** list attached to the bubble, one numbered row per cited record.
 *
 * The element loads this with a dynamic `import()` the first time it draws an answer that has cards, so a page that
 * never hands a conversation off pays nothing for it.
 *
 * - **Where a marker goes**: after the claim's text, as the answer part gives it (`claims`, by claim index), before
 *   the sentence's closing punctuation. `cites` says which cards support which claim; a claim with several sources
 *   gets several markers. A target that sends no `claims` (an older one) gets the Sources list and no markers.
 * - **Numbering**: by first appearance in the reply. Cards no placed claim cites are numbered after, in card order.
 *   A one-source answer is numbered too, as `1`, so a reply looks the same whatever it cites.
 * - **A marker** is a button named "Source N": it moves focus to its row and highlights it.
 * - **A row** opens its source as the card's Read (or Watch, or "Open the page") would: this page's fragment in
 *   place, another page of the site in this tab with the conversation kept, another origin in a new tab. Every
 *   open goes through the guardrails' navigation check first ({@link SourcesHost.allow}).
 * - **Content stays a card**: a video or a clip (Watch, or Play with `media="play"`) and a profile are drawn as
 *   their cards under the bubble, wearing their number; an article, an FAQ, a how-to or a page is its row alone.
 *
 * Colours: the list and the markers are drawn in the bubble's own colours (the `--color-*` its utilities use), so
 * they read as part of it; a content card, outside the bubble, in the element's tokens (`--bg`, `--blue`…) as the
 * cards always were.
 *
 * Everything is data from another server: set as text, never as markup. It imports nothing at run time: what it
 * shares with the element (the cards, how a link opens) comes in {@link SourcesHost}, so the page-load code is not
 * split into one more chunk.
 *
 * @module
 */
import type { CardButton } from '../harness/cta.js';
import type { HandoffAnswer } from '../handoff/envelope.js';
import type { OpenWay } from '../harness/tools/open-target.js';
import type { AnswerHandlers, CiteView } from './result-pick.js';

/** Where an answer's claims put their markers, and how its cards are numbered. */
export interface SourceOrder {
  /** Markers to place: an offset in the reply's text (after the claim, before its closing punctuation) and the cards' indices there. */
  marks: { at: number; cards: number[] }[];
  /** Card indices, in numbered order: the first is 1. */
  order: number[];
  /** Each card's number, by card index. */
  numbers: number[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where `claim` is in `text`, from `from` on, else anywhere; whitespace may differ. */
function find(text: string, claim: string, from: number): [number, number] | null {
  for (const start of [from, 0]) {
    const i = text.indexOf(claim, start);
    if (i >= 0) return [i, i + claim.length];
  }
  const re = new RegExp(claim.split(/\s+/).map(esc).join('\\s+'), 'g');
  for (const start of [from, 0]) {
    re.lastIndex = start;
    const m = re.exec(text);
    if (m) return [m.index, m.index + m[0].length];
  }
  return null;
}

/** The card a cite names: by its record's `@id`, its own, or the one document its `@id` is in. */
function cardOf(answer: HandoffAnswer, id: string, record?: string): number {
  const ids = answer.cards.map((c) => c['@id']);
  const exact = ids.indexOf(record ?? id);
  if (exact >= 0) return exact;
  const doc = (s: string) => s.split('#')[0];
  const same = ids.flatMap((c, i) => (doc(c) === doc(id) ? [i] : []));
  return same.length === 1 ? same[0] : ids.indexOf(id);
}

/**
 * Where an answer's markers go in `text` (the reply as the bubble shows it), and the cards' numbers.
 *
 * Claims are looked for in order, each after the one before; one that only appears earlier (a claim that repeats a
 * passage already shown) is marked there. A claim not found has no marker; its cards are still listed.
 */
export function sourceOrder(answer: HandoffAnswer, text: string): SourceOrder {
  const marks: SourceOrder['marks'] = [];
  let cursor = 0;
  for (const [i, claim] of (answer.claims ?? []).entries()) {
    const cards = [...new Set(answer.cites.filter((c) => c.claim === i).map((c) => cardOf(answer, c.id, c.record)).filter((n) => n >= 0))];
    const span = claim && cards.length ? find(text, claim, cursor) : null;
    if (!span) continue;
    let at = span[1];
    while (at > span[0] && /[.!?:;,]/.test(text[at - 1])) at--;
    if (span[0] >= cursor) cursor = span[1];
    const same = marks.find((m) => m.at === at);
    if (same) same.cards = [...new Set([...same.cards, ...cards])];
    else marks.push({ at, cards });
  }
  marks.sort((a, b) => a.at - b.at);
  const order = [...new Set([...marks.flatMap((m) => m.cards), ...answer.cards.keys()])];
  const numbers: number[] = [];
  order.forEach((card, n) => (numbers[card] = n + 1));
  return { marks, order, numbers };
}

/** "step 3", "steps 3–5", "steps 2, 6": the steps of a how-to the answer cites, from the cites' paths. */
export function stepsCited(answer: HandoffAnswer, card: number): string | undefined {
  const steps = [
    ...new Set(
      answer.cites
        .filter((c) => cardOf(answer, c.id, c.record) === card)
        .map((c) => /^step\[(\d+)\]$/.exec(c.path ?? '')?.[1])
        .filter((s): s is string => !!s)
        .map((s) => Number(s) + 1),
    ),
  ].sort((a, b) => a - b);
  if (!steps.length) return undefined;
  if (steps.length === 1) return `step ${steps[0]}`;
  const run = steps.every((s, i) => !i || s === steps[i - 1] + 1);
  return `steps ${run ? `${steps[0]}–${steps[steps.length - 1]}` : steps.join(', ')}`;
}

/** A row's link: the card's first button that opens a place (a play button's own fallback link), if any. */
function linkOf(v: CiteView): Extract<CardButton, { kind: 'open' }> | undefined {
  for (const b of [v.ctas?.lead, v.ctas?.secondary]) {
    if (b?.kind === 'open') return b;
    if (b?.kind === 'play' && b.fallback) return b.fallback;
  }
  return undefined;
}

// Heroicons v2.2.0, MIT, © Tailwind Labs (https://heroicons.com). See THIRD_PARTY_NOTICES.
/** arrow-top-right-on-square, 24/outline. */
const EXTERNAL =
  '<svg class="ra-sicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/></svg>';

export const SOURCES_CSS = `
.ra-cites { width: 100%; display: flex; flex-direction: column; gap: 8px; margin-top: 6px; white-space: normal; }
.ra-cite { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; font-size: 14px; line-height: 1.5; color: var(--ink); }
.ra-focus { margin: 0; font-size: 13px; color: var(--ink-2); border-left: 2px solid var(--border-strong); padding-left: 8px; }
.msg.has-sources { overflow: hidden; --s-bg: var(--color-bg); --s-ink: var(--color-ink); --s-ink-2: var(--color-ink-2); --s-line: var(--color-border-hair); --s-blue: var(--color-blue); --s-strong: var(--color-blue-strong); }
.ra-cites { --s-bg: var(--bg); --s-ink: var(--ink); --s-ink-2: var(--ink-2); --s-line: var(--border); --s-blue: var(--blue); --s-strong: var(--blue-strong); }
.msg.has-sources, .ra-cites { --s-pill: color-mix(in srgb, var(--s-blue) 16%, var(--s-bg)); }
.ra-mark { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; margin-left: 3px; box-sizing: border-box; border: 0; border-radius: 9px; background: var(--s-pill); color: var(--s-strong); font: 600 11px/1 var(--sans); vertical-align: 1px; cursor: pointer; }
.ra-mark:hover { background: var(--s-strong); color: var(--s-bg); }
.ra-src { margin: 12px -14px -10px; padding: 12px 14px; border-top: 1px solid var(--s-line); background: var(--s-bg); white-space: normal; display: flex; flex-direction: column; gap: 6px; }
.ra-src-h { margin: 0; font: 600 11px var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--s-ink-2); }
.ra-src ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ra-srow { display: flex; align-items: flex-start; gap: 10px; margin: 0 -6px; padding: 5px 6px; border-radius: 8px; color: var(--s-ink); text-decoration: none; transition: background .2s; }
a.ra-srow:hover { background: color-mix(in srgb, var(--s-ink) 5%, var(--s-bg)); }
.ra-srow.ra-hl { background: var(--s-pill); }
.ra-snum { flex: none; min-width: 18px; height: 18px; margin-top: 1px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; background: var(--s-pill); color: var(--s-strong); font: 600 11px/18px var(--sans); text-align: center; }
.ra-srow.ra-hl .ra-snum { background: var(--s-strong); color: var(--s-bg); }
.ra-eyebrow .ra-snum { display: inline-block; margin: 0 6px 0 0; vertical-align: 1px; text-transform: none; letter-spacing: 0; }
.ra-stext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ra-stitle { font-size: 14px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.ra-smeta { font-size: 12px; line-height: 1.4; color: var(--s-ink-2); }
.ra-sicon { flex: none; width: 16px; height: 16px; margin-top: 2px; color: var(--s-ink-2); }
.ra-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ra-mark:focus-visible, .ra-srow:focus-visible { outline: 2px solid var(--s-blue); outline-offset: 2px; }
`;

/** What the Sources need of the element. */
export interface SourcesHost {
  /** The answer's cards, as the card view draws them (with Play in place of Watch where the player may play). */
  views: CiteView[];
  /** The cards' buttons: open a page keeping the conversation, or play. */
  handlers: AnswerHandlers;
  /** The guardrails' navigation check, inside the tap: whether a row may open `url` (another origin is confirmed). */
  allow(url: string): boolean;
  /** How a link opens from here: in place, in this tab, or in a new one. */
  openWay(url: string): OpenWay;
  /** The cards for an answer's sources, as the card view draws them. */
  citeCards(cards: CiteView[], handlers: AnswerHandlers): HTMLElement;
}

/** The text nodes under `root`, in order, each with where it starts in `root`'s text. */
function textNodes(root: Node, out: { node: Text; start: number }[] = [], at = { n: 0 }): { node: Text; start: number }[] {
  for (const n of root.childNodes) {
    if (n.nodeType === 3) {
      out.push({ node: n as Text, start: at.n });
      at.n += (n as Text).data.length;
    } else textNodes(n, out, at);
  }
  return out;
}

/** Move to a source's row and light it up for a moment. */
function highlight(row: HTMLElement): void {
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: 'nearest' });
  row.classList.add('ra-hl');
  clearTimeout(Number(row.dataset.hl));
  row.dataset.hl = String(setTimeout(() => row.classList.remove('ra-hl'), 1600));
}

/**
 * Draw an answer's sources: the markers in `bubble`'s text, the Sources list inside the bubble, and the cards whose
 * content is the answer (a video, a profile) after it, before the feedback controls.
 *
 * @param bubble - The reply's bubble, already in the thread, its text drawn.
 */
export function paintSources(bubble: HTMLElement, answer: HandoffAnswer, host: SourcesHost): void {
  const doc = bubble.ownerDocument;
  const root = bubble.getRootNode();
  const styles = root instanceof ShadowRoot ? root : doc.head;
  if (!styles.querySelector('style[data-src]')) {
    const style = doc.createElement('style');
    style.dataset.src = '';
    style.textContent = SOURCES_CSS;
    styles.append(style);
  }
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const { marks, order, numbers } = sourceOrder(answer, bubble.textContent ?? '');
  const rows: HTMLElement[] = [];

  // The list: one row per card, in numbered order.
  const section = el('div', 'ra-src');
  section.setAttribute('role', 'group');
  const head = el('p', 'ra-src-h', 'Sources');
  head.id = `ra-src-${Math.random().toString(36).slice(2)}`;
  section.setAttribute('aria-labelledby', head.id);
  const list = el('ol', '');
  for (const i of order) {
    const v = host.views[i];
    if (!v) continue;
    const b = linkOf(v);
    const row = b ? el('a', 'ra-srow') : el('div', 'ra-srow');
    row.dataset.n = String(numbers[i]);
    row.dataset.id = v.id;
    const meta = [v.heading, stepsCited(answer, i) ?? v.focus].filter(Boolean).join(' · ');
    const words = el('span', 'ra-stext');
    words.append(el('span', 'ra-stitle', v.title), el('span', 'ra-smeta', meta));
    row.append(el('span', 'ra-snum', String(numbers[i])), words);
    if (b && row instanceof HTMLAnchorElement) {
      const way = host.openWay(b.url);
      row.href = b.url;
      if (way === 'new-tab') {
        row.target = '_blank';
        row.rel = 'noopener noreferrer';
        words.append(el('span', 'ra-sr', '(opens in a new tab)'));
      }
      row.insertAdjacentHTML('beforeend', EXTERNAL);
      row.addEventListener('click', (e) => {
        if (e.defaultPrevented) return;
        if (!host.allow(b.url)) return e.preventDefault();
        const plain = e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
        host.handlers.opened?.(b, way === 'same-site' && !plain ? 'new-tab' : way);
        if (way === 'same-site' && plain) host.handlers.visit?.(b.url, v.title);
      });
    } else {
      row.tabIndex = -1;
    }
    rows[i] = row;
    const li = el('li', '');
    li.append(row);
    list.append(li);
  }
  section.append(head, list);

  // The markers, from the last, so the offsets before them still hold.
  const nodes = textNodes(bubble);
  for (const m of [...marks].reverse()) {
    const hit = nodes.find((t) => m.at > t.start && m.at <= t.start + t.node.data.length) ?? nodes.find((t) => m.at === t.start);
    if (!hit) continue;
    const group = el('span', 'ra-marks');
    for (const card of [...m.cards].sort((a, b) => numbers[a] - numbers[b])) {
      const row = rows[card];
      if (!row) continue;
      const n = String(numbers[card]);
      const mark = el('button', 'ra-mark', n);
      mark.type = 'button';
      mark.setAttribute('aria-label', `Source ${n}`);
      mark.addEventListener('click', () => highlight(row));
      group.append(mark);
    }
    const tail = hit.node.splitText(m.at - hit.start);
    // Never inside a link: a button in an anchor is two controls in one.
    const link = (hit.node.parentElement?.closest('a') ?? null) as HTMLElement | null;
    if (link && bubble.contains(link)) link.after(group);
    else tail.before(group);
  }
  bubble.classList.add('has-sources');
  bubble.append(section);

  // The cards that are content, not only a source: a video or a clip, and a profile, with their numbers.
  const content = order.filter((i) => host.views[i] && !host.views[i].compact && (host.views[i].archetype === 'media' || host.views[i].archetype === 'profile'));
  if (content.length) {
    const box = host.citeCards(
      content.map((i) => host.views[i]),
      host.handlers,
    );
    [...box.children].forEach((card, k) => card.querySelector('.ra-eyebrow')?.prepend(el('span', 'ra-snum', String(numbers[content[k]]))));
    bubble.after(box);
  }
}
