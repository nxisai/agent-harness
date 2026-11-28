/**
 * Search results as an answer: a recommended pick with its reasons, the
 * others to compare against, or, when there is nothing to recommend, a short
 * list that opens up per result.
 *
 * The pick comes from the harness (`recommend`): the model chose it and wrote
 * the lead and reasons, and only reasons the record backs survived. Those are
 * the only lines marked with a tick. Comparing another result shows that
 * result's own facts, plainly, without a tick: the agent did not recommend it.
 *
 * Plain DOM, every string set as text.
 *
 * @module
 */
import { telHref, type Archetype, type MediaKind } from '../harness/entity.js';
import type { ResultPick } from '../harness/recommend.js';
import type { CardButton, CardCtas } from '../harness/cta.js';
import { mediaLine, seriesHeadings, SERIES_PARTS_SHOWN, type MediaRow, type SeriesCard } from '../harness/media.js';
import { openWay, type OpenWay } from '../harness/tools/open-target.js';
import type { FigureModel, ImageModel } from '../harness/playable.js';
import type { EventButton, EventCard } from '../harness/happening.js';

/** One result, as the answer shows it. */
export interface AnswerCard {
  title: string;
  stars?: number;
  reviews?: number;
  status?: { open: boolean; label: string };
  phone?: string;
  page?: { url: string; label: string };
  /** What the record states, short: hours, rating, services, since when. */
  facts: string[];
  /** A site form that can be sent to it, and what to ask the agent to start it. */
  form?: { label: string; message: string };
  /** How it draws, from the renderer spec; a card without one draws as a business did before. */
  archetype?: Archetype;
  /** The heading a list shows it under, when the results are of more than one kind. */
  group?: string;
  /** The line under the name: "Plumber · Royal Oak". */
  byline?: string;
  /** What access costs, when the record says so: "Free preview", "$49". */
  badge?: string;
  /** An article that opens on its free preview. */
  preview?: boolean;
  /** What a review reviews, by name. */
  about?: string;
  /** A review's author and words, drawn as they are rather than as facts. */
  author?: string;
  quote?: string;
  /** A media item, as its row draws it: no avatar, "Lantern Hours · Episode 2 · 0:10 · Free",
   * its lead always on show. */
  media?: MediaRow;
  /** A series with its parts: drawn as its card when it is the only result, and as a row among others. */
  series?: SeriesCard;
  /** Buttons that open places on the site (Listen, Subscribe, Their page), in place of the ones drawn from `form`,
   * `phone` and `page`. */
  ctas?: CardCtas;
  /** What kind of media the record is or holds: its tile's mark when it has no picture. */
  kind?: MediaKind;
  /** The record's own picture, https only: its tile. */
  image?: string;
  /** A picture record (an ImageObject) drawn as its figure: the picture, its caption and credit, License. */
  figure?: FigureModel;
  /** An event: drawn by {@link AnswerHandlers.events} when given, else as any other card. */
  event?: EventCard;
}

/** How events draw: `ui/event-cards.ts`, loaded with the first result that is one. */
export interface EventViews {
  /** One event, open: its facts, its buttons, its days or sessions. */
  detail(c: AnswerCard & { event: EventCard }, handlers: AnswerHandlers): HTMLElement;
  /** An event in a list: its date, name and line, opening to its facts and buttons. */
  row(c: AnswerCard & { event: EventCard }, handlers: AnswerHandlers, expanded: boolean, toggle: () => void): HTMLElement;
  /** Its date tile. */
  tile(c: AnswerCard & { event: EventCard }, size: 'lg' | 'sm'): HTMLElement;
}

/** What the answer can ask the conversation to do. */
export interface AnswerHandlers {
  /** Send a message as the visitor: "Get a quote from Hatzel & Sons Plumbing". */
  ask(text: string): void;
  /**
   * The visitor is following a Listen, Subscribe or "Their page" link to another page on this site, in this tab:
   * the place to keep the conversation for the page it lands on. A link to this page (an episode's `#player`) or to
   * another origin (opened in a new tab) never calls it; nothing leaves.
   *
   * @param name - What it opens is called: the episode's or show's name.
   */
  visit?(url: string, name: string): void;
  /**
   * The visitor tapped a button that opens a page (Listen, Subscribe, "Their page"): count it. Called before the
   * browser follows the link; `way` says whether this tab is leaving.
   */
  opened?(button: Extract<CardButton, { kind: 'open' }>, way: OpenWay): void;
  /**
   * In-chat playback (`media="play"`): whether a play button may play now (the gate, run again on a card saved
   * with the conversation; a host blocked this session). Without it, or when it says no, the button is its fallback
   * link, as it would be without the option.
   */
  canPlay?(button: Extract<CardButton, { kind: 'play' }>): boolean;
  /** A play button was tapped: play it in the docked player, or pause it. Runs inside the tap. */
  play?(button: Extract<CardButton, { kind: 'play' }>, name: string): void;
  /** A play button was pointed at or focused: the player may load ahead of the tap. */
  warm?(): void;
  /** How events draw, once their module has loaded. */
  events?: EventViews;
  /**
   * An event's button was tapped: report it, and take it when it is the site's ticket form (started here, or handed to
   * its page). Called before the browser follows the link.
   *
   * @param leaving - This tab is leaving for another page of the site.
   * @returns Whether it was taken: the link is then not followed.
   */
  eventTap?(button: EventButton, name: string, leaving: boolean): boolean;
}

/** A card the event views draw. */
const eventOf = (c: AnswerCard, handlers: AnswerHandlers): (AnswerCard & { event: EventCard }) | undefined =>
  c.event && handlers.events ? (c as AnswerCard & { event: EventCard }) : undefined;

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const PALETTE = ['#0E4F5C', '#1D4ED8', '#6D28D9', '#9A3412', '#0F766E', '#B45309', '#334155'];

/** Up to two letters, and a colour that stays the same for a name. */
function avatar(name: string, size: 'lg' | 'sm'): HTMLElement {
  const words = name.split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  const ini = (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const el = h('span', { class: `ra-avatar ${size}`, 'aria-hidden': 'true' }, ini);
  el.style.background = PALETTE[hash % PALETTE.length];
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS: Record<'play' | 'pause' | 'lock' | 'mic' | 'image', { fill?: boolean; rect?: number[]; d: string[] }> = {
  play: { fill: true, d: ['M7 4v16l13-8z'] },
  pause: { fill: true, d: ['M6 4h4v16H6zM14 4h4v16h-4z'] },
  image: { rect: [3, 3, 18, 18, 2], d: ['M21 15l-5-5L5 21', 'M8.5 7.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z'] },
  lock: { rect: [4, 11, 16, 10, 2], d: ['M8 11V7a4 4 0 0 1 8 0v4'] },
  mic: { d: ['M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v4'] },
};

/** A line icon, drawn inline: the play mark, a lock, a microphone. */
function icon(name: keyof typeof ICONS, size: number): SVGElement {
  const spec = ICONS[name];
  const set = <E extends Element>(el: E, attrs: Record<string, string | number>): E => {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  const svg = set(document.createElementNS(SVG_NS, 'svg'), {
    width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: spec.fill ? 'currentColor' : 'none',
    stroke: spec.fill ? 'none' : 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
  if (spec.rect) {
    const [x, y, width, height, rx] = spec.rect;
    svg.append(set(document.createElementNS(SVG_NS, 'rect'), { x, y, width, height, rx }));
  }
  for (const d of spec.d) svg.append(set(document.createElementNS(SVG_NS, 'path'), { d }));
  return svg;
}

/** The mark a kind of media wears on its tile: a microphone for audio, the play mark for video, a picture. */
const KIND_ICON: Record<MediaKind, keyof typeof ICONS> = { audio: 'mic', video: 'play', image: 'image' };

/**
 * A picture standing in for a tile. Decorative (`alt=""`): the name beside it says what it is. A picture that fails
 * to load gives way to the tile it stands in for, so a broken cover never shows the browser's broken-image mark.
 */
function tileImage(src: string, cls: string, fallback: () => HTMLElement): HTMLElement {
  const img = h('img', { class: cls, src, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'strict-origin-when-cross-origin' });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

/**
 * A media tile: its art when it has an https image (the harness runs on the site, so the site's own cover loads
 * where the NxisAI app's sandbox cannot), else its kind's mark (a microphone, the play mark, a picture) on the
 * show's colour, picked as avatars pick theirs.
 */
function artTile(name: string, size: 'lg' | 'sm', art?: string, kind: MediaKind = 'audio'): HTMLElement {
  const mark = (): HTMLElement => {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const el = h('span', { class: `ra-art ${size}`, 'aria-hidden': 'true' });
    el.append(icon(KIND_ICON[kind], size === 'lg' ? 26 : 18));
    el.style.background = PALETTE[hash % PALETTE.length];
    return el;
  };
  return art ? tileImage(art, `ra-art ${size}`, mark) : mark();
}

/** A card that draws as media: an episode, or a series. */
const isMedia = (c: AnswerCard): boolean => !!(c.media || c.series);

/** The tile at the head of a card: media wears its own picture, else its show's art, else its kind's mark; the rest
 * their picture (a product's photo, a place's), else their initials. */
const tile = (c: AnswerCard, size: 'lg' | 'sm'): HTMLElement =>
  isMedia(c) || c.archetype === 'media'
    ? artTile(c.media?.series ?? c.title, size, c.image ?? c.series?.art, c.kind)
    : c.image
    ? tileImage(c.image, `ra-avatar ${size}`, () => avatar(c.title, size))
    : avatar(c.title, size);

/**
 * A picture at its own proportions, its space kept before it loads (its `width` and `height`, and the same as
 * `aspect-ratio`), so nothing below it moves. One that fails to load gives way to a plain frame of the same size.
 */
function picture(img: ImageModel, alt: string): HTMLElement {
  const dims = img.width && img.height ? { width: String(img.width), height: String(img.height) } : {};
  const el = h('img', { src: img.url, alt, loading: 'lazy', decoding: 'async', referrerpolicy: 'strict-origin-when-cross-origin', ...dims });
  el.style.aspectRatio = img.width && img.height ? `${img.width} / ${img.height}` : '4 / 3';
  el.addEventListener('error', () => {
    const frame = h('span', { class: 'ra-noimg', role: 'img', 'aria-label': alt });
    frame.style.aspectRatio = el.style.aspectRatio;
    frame.append(icon('image', 28));
    el.replaceWith(frame);
  }, { once: true });
  return el;
}

/**
 * A picture record as a figure: the picture (only its thumbnail when it isn't free), its caption and credit, then
 * License (its `acquireLicensePage`) and its page. A licence is shown, never enforced.
 */
function figureView(c: AnswerCard, f: FigureModel, handlers: AnswerHandlers): HTMLElement {
  const box = h('div', { class: 'ra-figcard' });
  const fig = h('figure', { class: 'ra-figure' });
  if (f.image) fig.append(picture(f.image, f.image.alt ?? f.caption ?? c.title));
  const caption = f.caption && f.caption !== c.title ? f.caption : undefined;
  fig.append(h('figcaption', {}, h('strong', {}, c.title), caption ? h('span', {}, caption) : null, f.credit ? h('span', { class: 'ra-credit' }, f.credit) : null));
  box.append(fig);
  const row = h('div', { class: 'ra-actions' });
  if (f.licensePage) row.append(openButton({ kind: 'open', label: 'License', url: f.licensePage, intent: 'navigate' }, c.title, handlers));
  if (c.ctas) {
    row.append(...[ctaButton(c.ctas.lead, c.title, handlers), c.ctas.secondary && ctaButton(c.ctas.secondary, c.title, handlers)].filter((b): b is HTMLElement => !!b));
  } else if (f.page) row.append(openButton({ kind: 'open', label: 'Their page', url: f.page, intent: 'navigate' }, c.title, handlers));
  if (row.childNodes.length) box.append(row);
  return box;
}

/**
 * A button that opens a place: an ordinary link, so a middle-click or a long-press does what it does anywhere.
 * This page's `#player` moves the page; another page on the site goes there in this tab, the conversation kept
 * ({@link AnswerHandlers.visit}); another origin opens in a new tab, with no opener and no referrer. Listen wears the play mark; a button that
 * takes paying, a lock.
 */
function openButton(b: Extract<CardButton, { kind: 'open' }>, name: string, handlers: AnswerHandlers, cls = ''): HTMLElement {
  const way = openWay(b.url);
  const play = b.intent === 'consume' && (b.actionType === 'ListenAction' || b.actionType === 'WatchAction');
  const mark = play ? icon('play', 12) : b.locked ? icon('lock', 13) : null;
  const a = h(
    'a',
    {
      class: `ra-btn ${cls}${b.locked ? ' locked' : ''}`.trim(),
      href: b.url,
      // No referrer to another origin either: the page the visitor is on is theirs, not the destination's to know.
      ...(way === 'new-tab' ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
      'aria-label': mark ? `${b.label}: ${name}` : undefined,
    },
    mark,
    b.label,
  );
  a.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    // A plain click on a link to another page of the site leaves this tab; anything else opens beside it.
    const leaving = way === 'same-site' && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
    handlers.opened?.(b, leaving ? 'same-site' : way === 'same-site' ? 'new-tab' : way);
    if (way !== 'same-site' || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    handlers.visit?.(b.url, name);
  });
  return a;
}

/**
 * A button that plays in the chat: the play mark and its words, or, while it plays, the pause mark and "Pause"
 * ({@link syncPlayButtons}). `aria-pressed` says which.
 */
function playButton(b: Extract<CardButton, { kind: 'play' }>, name: string, handlers: AnswerHandlers, cls: string): HTMLElement {
  const el = h('button', { type: 'button', class: `ra-btn ra-play ${cls}`.trim(), 'aria-pressed': 'false', 'data-media-id': b.mediaId, 'data-label': b.label, 'aria-label': `${b.label}: ${name}` });
  el.append(icon('play', 12), icon('pause', 12), h('span', { class: 'ra-plabel' }, b.label));
  el.addEventListener('click', () => handlers.play!(b, name));
  for (const ev of ['pointerenter', 'focus']) el.addEventListener(ev, () => handlers.warm?.(), { once: true });
  return el;
}

/** Every play button under `root` says whether its item is the one playing: "Pause" and pressed, or its words. */
export function syncPlayButtons(root: ParentNode, id: string | null, playing: boolean): void {
  for (const el of root.querySelectorAll<HTMLElement>('.ra-play[data-media-id]')) {
    const on = playing && el.dataset.mediaId === id;
    el.setAttribute('aria-pressed', String(on));
    el.querySelector('.ra-plabel')!.textContent = on ? 'Pause' : el.dataset.label ?? '';
    el.setAttribute('aria-label', (el.getAttribute('aria-label') ?? '').replace(/^[^:]*/, on ? 'Pause' : el.dataset.label ?? ''));
  }
}

/** One of a card's buttons, whichever kind it is. A play button that can't play is its fallback link, or nothing. */
function ctaButton(b: CardButton, name: string, handlers: AnswerHandlers, cls = ''): HTMLElement | null {
  if (b.kind === 'play') {
    if (handlers.play && handlers.canPlay?.(b)) return playButton(b, name, handlers, cls);
    return b.fallback ? openButton(b.fallback, name, handlers, cls) : null;
  }
  if (b.kind === 'open') return openButton(b, name, handlers, cls);
  const el = h('button', { type: 'button', class: `ra-btn ${cls}`.trim() }, b.label);
  el.addEventListener('click', () => handlers.ask(b.message));
  return el;
}

/** The name, the line under it, and the meta line. */
function who(c: AnswerCard, tag: 'div' | 'span'): HTMLElement {
  return h(tag, { class: 'ra-who' }, h('strong', {}, c.title), c.byline ? h('span', { class: 'ra-byline' }, c.byline) : null, meta(c));
}

/** "★ 4.7 (412) · Open now · 24/7 · Free preview". */
function meta(c: AnswerCard): HTMLElement {
  const line = h('span', { class: 'ra-meta' });
  if (c.stars !== undefined) {
    line.append(h('span', {}, `★ `, h('strong', {}, String(c.stars))));
    if (c.reviews !== undefined) line.append(h('span', { class: 'ra-faint' }, ` (${c.reviews})`));
  }
  if (c.status) {
    if (line.childNodes.length) line.append(' · ');
    line.append(h('span', { class: c.status.open ? 'ra-open' : '' }, c.status.label));
  }
  if (c.badge) {
    if (line.childNodes.length) line.append(' · ');
    line.append(h('span', { class: 'ra-badge' }, c.badge));
  }
  return line;
}

/**
 * The card's buttons, the lead first, at most three. Which leads follows the archetype, as in the NxisAI app:
 * a business leads with Call, the quickest way to reach it; an article with Read; anything else with the
 * record's own action. A review links to what it reviews and has no page of its own to offer.
 */
function actions(c: AnswerCard, handlers: AnswerHandlers, primary: boolean): HTMLElement {
  const row = h('div', { class: 'ra-actions' });
  // Media: its own lead and the one beside it, as the NxisAI app draws them; nothing else is added.
  const ctas = c.series?.ctas ?? c.ctas;
  if (ctas) {
    const name = c.series?.latest && ctas.lead.kind === 'open' && ctas.lead.actionType === 'ListenAction' ? c.series.latest : c.title;
    row.append(...[ctaButton(ctas.lead, name, handlers, primary ? 'primary' : ''), ctas.secondary && ctaButton(ctas.secondary, c.title, handlers)].filter((b): b is HTMLElement => !!b));
    return row;
  }
  const tel = telHref(c.phone);
  const arch = c.archetype ?? 'place';
  const ask = (label: string, message: string) => {
    const b = h('button', { type: 'button', class: 'ra-btn' }, label);
    b.addEventListener('click', () => handlers.ask(message));
    return b;
  };
  const buttons: HTMLElement[] = [];
  const call: HTMLElement | null = tel ? h('a', { class: 'ra-btn', href: tel }, `Call ${c.phone}`) : null;
  const form: HTMLElement | null = c.form ? ask(c.form.label, c.form.message) : null;
  if (arch === 'opinion') {
    if (c.about) buttons.push(ask(`More about ${c.about}`, `Tell me about ${c.about}`));
  } else if (arch === 'readable' && c.page) {
    buttons.push(h('a', { class: 'ra-btn', href: c.page.url }, c.preview ? 'Read the preview' : 'Read'));
    if (form) buttons.push(form);
    if (call) buttons.push(call);
  } else {
    // A business is reached quickest by phone; anything else by what it offers.
    buttons.push(...(arch === 'place' ? [call, form] : [form, call]).filter((b): b is HTMLElement => !!b));
    if (c.page) buttons.push(h('a', { class: 'ra-btn', href: c.page.url }, 'Their page'));
  }
  buttons.slice(0, 3).forEach((b, i) => {
    if (primary && i === 0) b.classList.add('primary');
    row.append(b);
  });
  return row;
}

/**
 * Draw the answer.
 *
 * @param cards - The results, in order.
 * @param pick - The recommendation, when the harness made one.
 */
export function resultsAnswer(cards: AnswerCard[], pick: ResultPick | undefined, handlers: AnswerHandlers): HTMLElement {
  const wrap = h('div', { class: 'msg assistant results-answer' });
  const valid = pick && cards[pick.index] ? pick : undefined;
  // A lone series that lists its parts: its card, as the Podcast board draws it. A lone picture: its figure.
  if (cards.length === 1 && cards[0].series) {
    wrap.append(seriesView(cards[0], cards[0].series, handlers));
    return wrap;
  }
  if (cards.length === 1 && cards[0].figure) {
    wrap.append(figureView(cards[0], cards[0].figure, handlers));
    return wrap;
  }
  // A lone event: its card, days or sessions and all.
  const lone = cards.length === 1 ? eventOf(cards[0], handlers) : undefined;
  if (lone) {
    wrap.append(handlers.events!.detail(lone, handlers));
    return wrap;
  }
  if (!valid) {
    // An episode's row has its lead on show, so none opens by default; other lists open their first.
    wrap.append(list(cards, handlers, cards[0] && isMedia(cards[0]) ? null : 0));
    return wrap;
  }

  let showing = valid.index;
  const body = h('div', { class: 'ra-body' });
  const draw = () => {
    const c = cards[showing];
    const mine = showing === valid.index;
    const box = h('div', { class: `ra-pick ${mine ? 'is-pick' : ''}` });
    const ev = eventOf(c, handlers);
    const head = h('div', { class: 'ra-head' }, tile(c, 'lg'), who(c, 'div'));
    box.append(ev ? handlers.events!.detail(ev, handlers) : c.figure ? figureView(c, c.figure, handlers) : head);
    // Ticks only for what the agent recommended, and could back from the record.
    const lines = mine ? valid.reasons : c.facts;
    if (lines.length) {
      const ul = h('ul', { class: `ra-reasons ${mine ? 'ticked' : ''}` });
      lines.forEach((l) => ul.append(h('li', {}, h('span', { class: 'ra-mark', 'aria-hidden': 'true' }, mine ? '✓' : '•'), h('span', {}, l))));
      box.append(ul);
    }
    // An event's card carries its own buttons.
    if (!ev) box.append(actions(c, handlers, true));

    const lead = mine ? h('p', { class: 'ra-lead' }, valid.lead) : h('p', { class: 'ra-lead' }, `Comparing ${c.title} with my pick, ${cards[valid.index].title}. `);
    if (!mine) {
      const back = h('button', { type: 'button', class: 'ra-link' }, 'Back to my pick');
      back.addEventListener('click', () => {
        showing = valid.index;
        draw();
      });
      lead.append(back);
    }

    const others = cards.map((o, i) => ({ o, i })).filter(({ i }) => i !== showing).slice(0, 3);
    const also = h('div', { class: 'ra-also' }, h('div', { class: 'ra-eyebrow' }, mine ? 'Also good · tap to compare' : 'Others'));
    for (const { o, i } of others) {
      const oe = eventOf(o, handlers);
      const row = h('button', { type: 'button', class: 'ra-row' }, oe ? handlers.events!.tile(oe, 'sm') : tile(o, 'sm'), who(o, 'span'), h('span', { class: 'ra-chev', 'aria-hidden': 'true' }, '›'));
      row.addEventListener('click', () => {
        showing = i;
        draw();
      });
      also.append(row);
    }
    body.replaceChildren(lead, box, ...(others.length ? [also] : []));
    if (cards.length > 4) {
      const all = h('button', { type: 'button', class: 'ra-link' }, `Show all ${cards.length}`);
      all.addEventListener('click', () => body.replaceChildren(list(cards, handlers, valid.index)));
      body.append(all);
    }
  };
  draw();
  wrap.append(body);
  return wrap;
}

/**
 * A record a remote agent's answer cites, as {@link citeCards} draws it: an {@link AnswerCard} with its buttons in
 * `ctas` (Read or Watch, and "Their page"; never an action CTA), the heading it is drawn under, and the passage it
 * cites.
 */
export interface CiteView extends AnswerCard {
  /** The record's `@id` and first type, kept on the card as `data-id` and `data-type`. */
  id: string;
  type: string;
  /** The line above the card: what kind of record it is, or "From the page". */
  heading: string;
  /** The passage it cites, with a clip's time: "2:14 · Replacing the filter". */
  focus?: string;
  /** `page`: a page cited by its description alone. */
  citation: 'typed' | 'page';
  /** Drawn already in this conversation: listed in the Sources, its card not drawn again. */
  compact?: boolean;
}

/**
 * The cards for an answer's sources that are content as well as a source (a video, a profile), each open, with its
 * heading, its name and the line under it, the passage it cites and its links. The answer's Sources list
 * (./sources.ts) draws every source as a numbered row; these are drawn under the reply beside it. Every string is
 * set as text.
 */
export function citeCards(cards: CiteView[], handlers: AnswerHandlers): HTMLElement {
  const box = h('div', { class: 'ra-cites' });
  for (const c of cards) {
    const card = h('div', { class: 'ra-cite', 'data-id': c.id, 'data-type': c.type, 'data-citation': c.citation });
    card.append(h('div', { class: 'ra-eyebrow' }, c.heading), h('div', { class: 'ra-head' }, tile(c, 'sm'), who(c, 'div')));
    if (c.focus) card.append(h('p', { class: 'ra-focus' }, c.focus));
    const row = h('div', { class: 'ra-actions' });
    for (const b of [c.ctas?.lead, c.ctas?.secondary]) {
      const el = b && ctaButton(b, c.title, handlers);
      if (el) row.append(el);
    }
    if (row.childNodes.length) card.append(row);
    box.append(card);
  }
  return box;
}

/** "★★★★☆" for a rating out of five, read out as "4 out of 5 stars". */
function starRow(stars: number): HTMLElement {
  const n = Math.max(0, Math.min(5, Math.round(stars)));
  return h('span', { class: 'ra-stars', role: 'img', 'aria-label': `${stars} out of 5 stars` }, '★'.repeat(n), h('span', { class: 'ra-faint' }, '★'.repeat(5 - n)));
}

/**
 * A review, open, as the NxisAI app draws it: what it reviews with its own stars, who wrote it, what they said,
 * and the way to what it reviews. No avatar: a review is no business, and its initials would only spell "RO".
 */
function reviewItem(c: AnswerCard, handlers: AnswerHandlers): HTMLElement {
  const item = h('div', { class: 'ra-item ra-review' });
  item.append(h('div', { class: 'ra-rv-head' }, h('strong', {}, c.title), c.stars !== undefined ? starRow(c.stars) : null));
  if (c.author) item.append(h('span', { class: 'ra-byline' }, `By ${c.author}`));
  if (c.quote) item.append(h('p', { class: 'ra-quote' }, `\u201c${c.quote}\u201d`));
  const row = actions(c, handlers, false);
  if (row.childNodes.length) item.append(row);
  return item;
}

/**
 * The results of more than one kind, each kind together under its heading, in the order the kinds first came;
 * within a kind, the order they came in. One kind, or cards without one, keep their order and get no headings.
 */
export function grouped(cards: AnswerCard[]): { card: AnswerCard; index: number; heading?: string }[] {
  const order: string[] = [];
  for (const c of cards) if (c.group && !order.includes(c.group)) order.push(c.group);
  const rows = cards.map((card, index) => ({ card, index }));
  if (order.length < 2) return rows;
  const rank = (c: AnswerCard) => (c.group ? order.indexOf(c.group) : order.length);
  const sorted = rows.sort((a, b) => rank(a.card) - rank(b.card) || a.index - b.index);
  return sorted.map((r, i) => (i === 0 || sorted[i - 1].card.group !== r.card.group ? { ...r, heading: r.card.group ?? 'Other' } : r));
}

/** What a media row shows: its title, its line, its access, its buttons and what it says. */
interface RowView {
  title: string;
  line: string;
  access?: { state: string; label: string };
  ctas?: CardCtas;
  description?: string;
  /** A video's or a picture's tile; an episode's row has none, as the Podcast board draws it. */
  kind?: MediaKind;
  image?: string;
}

/** An episode as a row, or a series among other results as one. */
function rowView(c: AnswerCard, opts: { withSeries?: boolean; inSeries?: boolean }): RowView {
  if (c.media) {
    const looks = c.kind && c.kind !== 'audio' ? { kind: c.kind, ...(c.image ? { image: c.image } : {}) } : {};
    return { title: c.media.title, line: mediaLine(c.media, opts), access: c.media.access, ctas: c.media.ctas, description: c.media.description, ...looks };
  }
  const s = c.series;
  return { title: c.title, line: (s?.subtitle ?? c.byline) || '', access: s?.badge, ctas: s?.ctas ?? c.ctas };
}

/** "Lantern Hours · Episode 2 · 0:10 · Free": the access in its colour. */
function mediaLineEl(r: RowView): HTMLElement | null {
  if (!r.line && !r.access) return null;
  const line = h('span', { class: 'ra-byline' }, r.line);
  if (r.access) {
    if (r.line) line.append(' · ');
    line.append(h('span', { class: `ra-acc ${r.access.state}` }, r.access.label));
  }
  return line;
}

/**
 * An episode as a row, as the Podcast board draws it: no avatar, its title and line, and its lead always on the
 * right. What else there is (what it's about, the button beside the lead) opens under it, the lead staying put. In a
 * series' card (`compact`) the row is just its title, line and button.
 */
function mediaRowEl(
  r: RowView,
  handlers: AnswerHandlers,
  opts: { compact?: boolean; expanded?: boolean; toggle?: () => void } = {},
): HTMLElement {
  const lead = r.ctas?.lead;
  const row = h(
    'div',
    { class: 'ra-mrow' },
    r.kind ? artTile(r.title, 'sm', r.image, r.kind) : null,
    h('span', { class: 'ra-who' }, h('strong', {}, r.title), mediaLineEl(r)),
    lead ? ctaButton(lead, r.title, handlers, 'cta') : null,
  );
  if (opts.compact) return row;
  const item = h('div', { class: 'ra-item' }, row);
  const more = !!r.description || !!r.ctas?.secondary;
  if (more) {
    const id = `ra-m-${Math.random().toString(36).slice(2, 7)}`;
    const chev = h('button', { type: 'button', class: 'ra-chev ra-mchev', 'aria-expanded': String(!!opts.expanded), 'aria-controls': id, 'aria-label': `More about ${r.title}` }, opts.expanded ? '−' : '+');
    chev.addEventListener('click', () => opts.toggle?.());
    row.append(chev);
    if (opts.expanded) {
      const box = h('div', { class: 'ra-mmore', id });
      if (r.description) box.append(h('p', { class: 'ra-desc' }, r.description));
      if (r.ctas?.secondary) box.append(h('div', { class: 'ra-actions' }, ctaButton(r.ctas.secondary, r.title, handlers)));
      item.append(box);
    }
  }
  return item;
}

/**
 * A series (the Podcast board): its tile, name, "Podcast · publisher · N episodes" and badge; "Listen to the
 * latest" and Subscribe; then its episodes, three until "Show all episodes", each with its own button.
 */
function seriesView(c: AnswerCard, s: SeriesCard, handlers: AnswerHandlers): HTMLElement {
  const box = h('div', { class: 'ra-series' });
  box.append(
    h(
      'div',
      { class: 'ra-head' },
      artTile(s.title, 'lg', s.art),
      h('div', { class: 'ra-who' }, h('strong', { class: 'ra-title-lg' }, s.title), s.subtitle ? h('span', { class: 'ra-byline' }, s.subtitle) : null),
      s.badge ? h('span', { class: `ra-pill ra-acc ${s.badge.state}` }, s.badge.label) : null,
    ),
  );
  box.append(actions(c, handlers, true));
  const parts = h('div', { class: 'ra-parts' });
  let all = s.parts.length <= SERIES_PARTS_SHOWN;
  const draw = () => {
    parts.replaceChildren(h('div', { class: 'ra-eyebrow' }, 'Episodes'));
    s.parts.slice(0, all ? s.parts.length : SERIES_PARTS_SHOWN).forEach((p) => parts.append(mediaRowEl(rowView({ title: p.title, facts: [], media: p }, { inSeries: true }), handlers, { compact: true })));
    if (!all) {
      const more = h('button', { type: 'button', class: 'ra-link ra-textbtn' }, 'Show all episodes');
      more.addEventListener('click', () => {
        all = true;
        draw();
      });
      parts.append(more);
    }
  };
  draw();
  box.append(parts);
  return box;
}

/** The plain list: one line per result, each opening to its facts and actions. */
function list(cards: AnswerCard[], handlers: AnswerHandlers, open: number | null): HTMLElement {
  const box = h('div', { class: 'ra-list' });
  // Reviews are read in full, so fewer show before "Show more".
  const SHOWN = cards.every((c) => c.archetype === 'opinion') ? 3 : 5;
  const allMedia = cards.every(isMedia);
  let all = cards.length <= SHOWN + 1;
  let openIndex = open;
  // Episodes from more than one show are grouped by show, under "Lantern Hours · 2", and their rows leave it out.
  const { bySeries, counts } = seriesHeadings(cards.filter((c) => c.media).map((c) => c.media!.series));
  const keyed = bySeries ? cards.map((c) => (c.media ? { ...c, group: c.media.series ?? 'Other episodes' } : c)) : cards;
  const rows = grouped(keyed).map((r) => (r.heading && r.card.media && bySeries ? { ...r, heading: counts.get(r.heading) ?? r.heading } : r));
  const draw = () => {
    box.replaceChildren();
    rows.slice(0, all ? rows.length : SHOWN).forEach(({ card: c, index: i, heading }) => {
      if (heading) box.append(h('div', { class: 'ra-group ra-eyebrow' }, heading));
      if (c.archetype === 'opinion') return void box.append(reviewItem(c, handlers));
      if (c.figure) return void box.append(h('div', { class: 'ra-item ra-figitem' }, figureView(c, c.figure, handlers)));
      const ev = eventOf(c, handlers);
      if (ev) {
        const expanded = openIndex === i;
        return void box.append(
          handlers.events!.row(ev, handlers, expanded, () => {
            openIndex = expanded ? null : i;
            draw();
          }),
        );
      }
      if (isMedia(c)) {
        const expanded = openIndex === i;
        return void box.append(
          mediaRowEl(rowView(c, { withSeries: !(bySeries && c.media) }), handlers, {
            expanded,
            toggle: () => {
              openIndex = expanded ? null : i;
              draw();
            },
          }),
        );
      }
      const expanded = openIndex === i;
      const item = h('div', { class: 'ra-item' });
      const id = `ra-${i}-${Math.random().toString(36).slice(2, 7)}`;
      const row = h('button', { type: 'button', class: 'ra-row plain', 'aria-expanded': String(expanded), 'aria-controls': id }, tile(c, 'sm'), who(c, 'span'), h('span', { class: 'ra-chev', 'aria-hidden': 'true' }, expanded ? '−' : '+'));
      row.addEventListener('click', () => {
        openIndex = expanded ? null : i;
        draw();
      });
      item.append(row);
      if (expanded) {
        const more = h('div', { class: 'ra-more', id });
        if (c.facts.length) {
          const ul = h('ul', { class: 'ra-reasons' });
          c.facts.forEach((f) => ul.append(h('li', {}, h('span', { class: 'ra-mark', 'aria-hidden': 'true' }, '•'), h('span', {}, f))));
          more.append(ul);
        }
        more.append(actions(c, handlers, false));
        item.append(more);
      }
      box.append(item);
    });
    if (!all) {
      const more = h('button', { type: 'button', class: 'ra-showmore' }, allMedia ? `Show all ${cards.length} episodes` : `Show ${cards.length - SHOWN} more`);
      more.addEventListener('click', () => {
        all = true;
        draw();
      });
      box.append(more);
    }
  };
  draw();
  return box;
}

/** Styles, on the widget's tokens. */
export const RESULTS_ANSWER_CSS = `
      .results-answer { align-self: flex-start; width: min(100%, 440px); box-sizing: border-box; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 16px 16px 16px 4px; font-size: 14px; line-height: 1.5; color: var(--ink); white-space: normal; }
      .ra-body { display: flex; flex-direction: column; gap: 12px; }
      .ra-lead { margin: 0; }
      .ra-pick { background: var(--bg); border: 1px solid var(--border-strong); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
      .ra-pick.is-pick { border: 1.5px solid var(--blue); box-shadow: 0 0 0 4px var(--blue-tint); }
      .ra-head { display: flex; align-items: center; gap: 10px; }
      .ra-avatar { flex-shrink: 0; display: grid; place-items: center; color: #fff; font-weight: 700; letter-spacing: .02em; }
      .ra-avatar.lg { width: 40px; height: 40px; border-radius: 12px; font-size: 13px; }
      .ra-avatar.sm { width: 30px; height: 30px; border-radius: 9px; font-size: 11px; }
      .ra-who { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex-grow: 1; text-align: left; }
      .ra-who strong { font-size: 14.5px; font-weight: 650; }
      .ra-meta { font-size: 12.5px; color: var(--ink-2); }
      .ra-byline { font-size: 12.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ra-badge { color: var(--ink); font-weight: 600; }
      .ra-group { padding: 10px 12px 2px; }
      .ra-review { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
      .ra-rv-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
      .ra-rv-head strong { font-size: 14.5px; font-weight: 650; }
      .ra-stars { color: #E8A33D; white-space: nowrap; letter-spacing: 1px; font-size: 13px; }
      .ra-quote { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--ink); }
      .ra-group:not(:first-child) { border-top: 1px solid var(--border); }
      .ra-meta strong { color: var(--ink); font-size: 12.5px; font-weight: 600; }
      .ra-faint { color: var(--ink-3); }
      .ra-open { color: var(--green-strong); font-weight: 600; }
      .ra-reasons { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--ink-2); }
      .ra-reasons li { display: flex; gap: 8px; align-items: flex-start; }
      .ra-mark { width: 18px; height: 18px; flex-shrink: 0; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: var(--ink-3); }
      .ra-reasons.ticked .ra-mark { background: var(--green-tint); color: var(--green-strong); }
      .ra-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .ra-btn { min-height: 40px; padding: 0 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--bg); color: var(--ink); font: 600 13.5px var(--sans); display: inline-flex; align-items: center; justify-content: center; text-decoration: none; cursor: pointer; }
      .ra-btn.primary { flex-grow: 1; border: 0; background: var(--blue); color: #fff; }
      .ra-btn.primary:hover { background: var(--blue-strong); }
      .ra-also { display: flex; flex-direction: column; gap: 6px; }
      .ra-eyebrow { font-family: var(--mono); font-size: 10.5px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
      .ra-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--ink); font: inherit; cursor: pointer; }
      .ra-row:hover { border-color: var(--border-strong); }
      .ra-row.plain { border: 0; border-radius: 0; padding: 10px 12px; }
      .ra-chev { color: var(--ink-3); font-size: 17px; line-height: 1; }
      .ra-link { align-self: flex-start; border: 0; background: none; padding: 0; font: 600 13px var(--sans); color: var(--blue-strong); cursor: pointer; }
      .ra-list { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
      .ra-item + .ra-item { border-top: 1px solid var(--border); }
      .ra-more { padding: 0 12px 12px 52px; display: flex; flex-direction: column; gap: 8px; }
      .ra-showmore { width: 100%; min-height: 40px; border: 0; border-top: 1px solid var(--border); background: var(--bg); color: var(--blue-strong); font: 600 13px var(--sans); cursor: pointer; }
      .ra-art { flex-shrink: 0; display: grid; place-items: center; color: #fff; object-fit: cover; }
      .ra-art.lg { width: 56px; height: 56px; border-radius: 12px; }
      .ra-art.sm { width: 30px; height: 30px; border-radius: 9px; }
      .ra-title-lg { font-size: 18px; font-weight: 700; }
      .ra-acc.free, .ra-acc.mixed { color: var(--green-strong); }
      .ra-acc.preview, .ra-acc.registration { color: var(--blue-strong); }
      .ra-acc.subscription, .ra-acc.purchase { color: var(--ink-2); }
      .ra-pill { align-self: center; flex-shrink: 0; white-space: nowrap; font-size: 12px; font-weight: 600; padding: 2px 10px; border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--bg); }
      .ra-btn svg { flex-shrink: 0; margin-right: 6px; }
      .ra-btn.cta { flex-shrink: 0; flex-grow: 0; padding: 0 12px; }
      .ra-btn.locked:not(.primary) { color: var(--ink-2); border-style: dashed; }
      /* A media line carries its access last: it wraps rather than lose it to an ellipsis. */
      .ra-mrow .ra-byline, .ra-series .ra-byline { white-space: normal; }
      /* One layout per list, from the list's own width: wide, title | button | + on one line; narrow (the window
         view), every row stacks, button and + under the title, rather than crushing the title to a word per line or
         mixing the two layouts in one list. */
      .ra-item, .ra-parts { container-type: inline-size; }
      .ra-mrow { display: flex; align-items: center; gap: 8px 10px; padding: 10px 12px; }
      .ra-mrow .ra-who { flex: 1 1 auto; }
      .ra-mrow .ra-btn { flex: 0 0 auto; }
      @container (max-width: 420px) {
        .ra-mrow { flex-wrap: wrap; }
        .ra-mrow .ra-who { flex-basis: 100%; }
        .ra-mrow .ra-mchev { margin-left: auto; }
      }
      .ra-mrow .ra-who strong { font-weight: 600; }
      .ra-mchev { flex-shrink: 0; width: 28px; min-height: 40px; border: 0; background: none; cursor: pointer; }
      .ra-mmore { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; }
      .ra-desc { margin: 0; font-size: 13px; color: var(--ink-2); }
      .ra-series { display: flex; flex-direction: column; gap: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 14px; padding: 14px; container-type: inline-size; }
      /* Tile | name | badge on one row; in a narrow card the badge goes under the name, beside the tile, so the name
         and "Podcast · publisher · N episodes" keep the width instead of breaking a word per line. */
      .ra-series > .ra-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 12px; row-gap: 6px; }
      @container (max-width: 380px) {
        .ra-series > .ra-head { grid-template-columns: auto minmax(0, 1fr); }
        .ra-series > .ra-head > :first-child { grid-row: span 2; align-self: start; }
        .ra-series > .ra-head .ra-pill { grid-column: 2; justify-self: start; }
      }
      .ra-parts { display: flex; flex-direction: column; border-top: 1px solid var(--border); padding-top: 10px; }
      .ra-parts .ra-mrow { padding: 10px 0; }
      .ra-parts .ra-mrow + .ra-mrow { border-top: 1px solid var(--border); }
      .ra-textbtn { min-height: 38px; }
      img.ra-avatar { object-fit: cover; padding: 0; }
      .ra-figcard { display: flex; flex-direction: column; gap: 10px; }
      .ra-figitem { padding: 12px; }
      .ra-figure { margin: 0; display: flex; flex-direction: column; gap: 8px; }
      .ra-figure img, .ra-noimg { display: block; width: 100%; height: auto; max-height: 360px; object-fit: contain; border-radius: 10px; background: var(--surface); border: 1px solid var(--border); box-sizing: border-box; }
      .ra-noimg { display: grid; place-items: center; color: var(--ink-3); }
      .ra-figure figcaption { display: flex; flex-direction: column; gap: 2px; font-size: 13px; color: var(--ink-2); }
      .ra-figure figcaption strong { font-size: 14.5px; font-weight: 650; color: var(--ink); }
      .ra-credit { font-size: 12px; color: var(--ink-3); }
      .ra-play[aria-pressed="true"] svg:first-child, .ra-play:not([aria-pressed="true"]) svg:nth-child(2) { display: none; }
      .ra-mchev:focus-visible, .ra-btn:focus-visible, .ra-row:focus-visible, .ra-link:focus-visible, .ra-showmore:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
`;
