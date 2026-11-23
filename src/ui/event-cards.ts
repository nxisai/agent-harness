/**
 * Event cards in the answer view, as the NxisAI Hub draws them, on this element's styles.
 *
 * Loaded with the first result that is an event (a dynamic `import()` in `agent.ts`), so a site whose results are
 * never events never downloads it. It brings the event model (`harness/happening.ts`), the views
 * {@link resultsAnswer} draws events with, their styles, and the A2UI surfaces for `a2ui="a2ui-results"`.
 *
 * - **A lone event**: its date tile, name and kind, its status or access; when, where, who runs it and who's on (a
 *   venue or person the site holds asks for its card); Get tickets (or "Sold out", not a button), Add to calendar,
 *   Directions; then its days or sessions, three until "Show all".
 * - **In a list**: its date, name and "Festival · Sat Jul 24 – Sun Jul 25, 2027 · Railspur Pavilion, Denver", its
 *   status or access; opening, its facts and buttons.
 *
 * Every string is set as text.
 *
 * What it needs of the element's own modules (opening a link, reporting a tap, the handoff address) comes in the
 * {@link EventHost}, as the Sources panel's does: imported here, they would be split out of the page-load bundle into
 * a chunk of their own, and every name the two share would cost the page bytes.
 *
 * @module
 */
import type { AnswerCard, AnswerHandlers, EventViews } from './result-pick.js';
import type { ResultPick } from '../harness/recommend.js';
import type { A2uiMessage } from '../a2ui/emit.js';
import type { OpenWay } from '../harness/tools/open-target.js';
import type { PageOpenTap } from '../harness/tools/report.js';
import {
  arrangeEvents,
  eventCard,
  EVENT_PARTS_SHOWN,
  eventPill,
  eventLine,
  HAPPENING,
  showAllParts,
  type EventButton,
  type EventCard,
  type EventRef,
} from '../harness/happening.js';
import { emitEventSurface, emitEventsSurface } from '../a2ui/events.js';

type Card = AnswerCard & { event: EventCard };
type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) k === 'class' ? (el.className = v) : el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

/** The date tile: "JUL" over "24". An event with no date has a blank one, so its name lines up with the rest. */
function tile(c: Card, size: 'lg' | 'sm'): HTMLElement {
  const w = c.event.when;
  return h('span', { class: `ra-date ${size}`, 'aria-hidden': 'true' }, w ? h('span', { class: 'ra-mon' }, w.mon) : null, w ? h('span', { class: 'ra-day' }, String(w.day)) : null);
}

/** Its status when it isn't on as planned, else its access: "Cancelled", "Sold out", "From $48". */
function pill(c: EventCard): HTMLElement | null {
  const p = eventPill(c);
  return p ? h('span', { class: `ra-pill ra-ev ${p.state}` }, p.label) : null;
}

/** Names, each one the site holds a link that asks for its card. */
function named(refs: EventRef[], sep: string, handlers: AnswerHandlers): (Node | string)[] {
  return refs.flatMap((r, i) => {
    const el: Node | string = r.prompt ? ask(r.label, r.prompt, handlers) : r.label;
    return i ? [sep, el] : [el];
  });
}

const ask = (label: string, prompt: string, handlers: AnswerHandlers): HTMLElement => {
  const b = h('button', { type: 'button', class: 'ra-link ra-inline' }, label);
  b.addEventListener('click', () => handlers.ask(prompt));
  return b;
};

/** When and where lead; then who runs it and who's on, and what it's part of. */
function facts(c: EventCard, handlers: AnswerHandlers, withWhen: boolean): HTMLElement | null {
  const ul = h('ul', { class: 'ra-reasons ra-evfacts' });
  const li = (...parts: (Node | string)[]) => ul.append(h('li', {}, h('span', { class: 'ra-mark', 'aria-hidden': 'true' }, '•'), h('span', {}, ...parts)));
  const lead = (s: string) => s.split('{names}')[0];
  if (withWhen && c.when) li(h('span', { class: 'ra-when' }, c.when.text));
  if (c.rescheduledFrom) li(c.rescheduledFrom);
  if (c.where.length) li(...named(c.where, ' · ', handlers));
  if (c.organizer.length) li(lead(HAPPENING.by), ...named(c.organizer, ', ', handlers));
  if (c.performer.length) li(lead(HAPPENING.with), ...named(c.performer, ', ', handlers));
  if (c.partOf) li(...named([c.partOf], '', handlers));
  return ul.childNodes.length ? ul : null;
}

/**
 * One button. "Sold out" and "On sale Jun 1" are said, not offered. The rest are links, so a middle-click or a
 * long-press does what it does anywhere: a calendar file and another site open beside the page; another page of this
 * site opens in this tab, the conversation kept; Get tickets on the site's own form opens it here.
 */
function button(b: EventButton, name: string, handlers: AnswerHandlers, openWay: EventHost['openWay']): HTMLElement {
  const cls = `ra-btn${b.primary ? ' primary' : ''}`;
  if (b.kind === 'closed' || !b.url) return h('button', { type: 'button', class: cls, disabled: '' }, b.label);
  const url = b.url;
  const way = openWay(url);
  const beside = way === 'new-tab' || b.kind === 'calendar';
  const a = h('a', { class: cls, href: url, ...(beside ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, b.label);
  a.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const plain = e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
    const leaving = !beside && way === 'same-site' && plain;
    if (handlers.eventTap?.(b, name, leaving) && plain) return void e.preventDefault();
    if (leaving) handlers.visit?.(url, name);
  });
  return a;
}

function actions(c: Card, handlers: AnswerHandlers, openWay: EventHost['openWay']): HTMLElement | null {
  if (!c.event.buttons.length) return null;
  return h('div', { class: 'ra-actions' }, ...c.event.buttons.map((b) => button(b, c.title, handlers, openWay)));
}

/** A festival's days or a conference's sessions: each with its time and access, three until "Show all". */
function parts(c: EventCard): HTMLElement {
  const box = h('div', { class: 'ra-parts' });
  let all = c.parts.length <= EVENT_PARTS_SHOWN;
  const draw = () => {
    box.replaceChildren(h('div', { class: 'ra-eyebrow' }, c.partsLabel));
    for (const p of c.parts.slice(0, all ? c.parts.length : EVENT_PARTS_SHOWN)) {
      const line = h('span', { class: 'ra-byline' }, p.when ?? '');
      if (p.access) line.append(p.when ? ' · ' : '', h('span', { class: `ra-acc ${p.access.state}` }, p.access.label));
      box.append(h('div', { class: 'ra-mrow' }, h('span', { class: 'ra-who' }, h('strong', {}, p.title), line)));
    }
    if (!all) {
      const more = h('button', { type: 'button', class: 'ra-link ra-textbtn' }, showAllParts(c.parts.length));
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

/** The views {@link resultsAnswer} draws events with. */
export const eventViews = (openWay: EventHost['openWay']): EventViews => ({
  tile,
  detail(c, handlers) {
    const e = c.event;
    const box = h('div', { class: 'ra-event' });
    box.append(
      h('div', { class: 'ra-head' }, tile(c, 'lg'), h('div', { class: 'ra-who' }, h('strong', { class: 'ra-title-lg' }, c.title), h('span', { class: 'ra-byline' }, e.kind)), pill(e)),
      ...[facts(e, handlers, true), actions(c, handlers, openWay), e.parts.length ? parts(e) : null].filter((x): x is HTMLElement => !!x),
    );
    return box;
  },
  row(c, handlers, expanded, toggle) {
    const e = c.event;
    const item = h('div', { class: 'ra-item' });
    const id = `ra-e-${Math.random().toString(36).slice(2, 7)}`;
    const line = eventLine(e);
    const row = h(
      'button',
      { type: 'button', class: 'ra-row plain ra-evrow', 'aria-expanded': String(expanded), 'aria-controls': id },
      tile(c, 'sm'),
      h('span', { class: 'ra-who' }, h('strong', {}, c.title), line ? h('span', { class: 'ra-byline ra-wrap' }, line) : null),
      pill(e),
      h('span', { class: 'ra-chev', 'aria-hidden': 'true' }, expanded ? '−' : '+'),
    );
    row.addEventListener('click', toggle);
    item.append(row);
    if (expanded) {
      const more = h('div', { class: 'ra-more', id });
      const f = facts(e, handlers, false);
      if (f) more.append(f);
      const a = actions(c, handlers, openWay);
      if (a) more.append(a);
      item.append(more);
    }
    return item;
  },
});

/** Styles, on the widget's tokens, beside the answer view's. */
export const EVENT_CARDS_CSS = `
      .ra-event { display: flex; flex-direction: column; gap: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 14px; padding: 14px; container-type: inline-size; }
      .ra-pick .ra-event { border: 0; padding: 0; background: none; }
      .ra-event > .ra-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 12px; row-gap: 6px; }
      @container (max-width: 380px) {
        .ra-event > .ra-head { grid-template-columns: auto minmax(0, 1fr); }
        .ra-event > .ra-head > :first-child { grid-row: span 2; align-self: start; }
        .ra-event > .ra-head .ra-pill { grid-column: 2; justify-self: start; }
      }
      .ra-date { flex-shrink: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px solid var(--border); background: var(--surface); line-height: 1.1; box-sizing: border-box; }
      .ra-date.lg { width: 48px; height: 52px; border-radius: 12px; }
      .ra-date.sm { width: 34px; height: 38px; border-radius: 9px; }
      .ra-mon { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--blue-strong); }
      .ra-day { font-size: 17px; font-weight: 700; color: var(--ink); }
      .ra-date.sm .ra-day { font-size: 14px; }
      .ra-evfacts .ra-when { color: var(--ink); font-weight: 600; }
      .ra-inline { display: inline; font: inherit; font-weight: 600; text-align: left; }
      .ra-byline.ra-wrap { white-space: normal; }
      .ra-btn[disabled] { opacity: .65; cursor: default; }
      .ra-btn.primary[disabled] { background: var(--ink-3); }
      .ra-ev.cancelled, .ra-ev.postponed, .ra-ev.soldout, .ra-acc.soldout { color: var(--red); }
      .ra-ev.rescheduled, .ra-ev.movedOnline, .ra-ev.onsale, .ra-acc.onsale { color: #B45309; }
      .ra-ev.past, .ra-acc.included { color: var(--ink-3); }
      .ra-ev.free { color: var(--green-strong); }
      .ra-ev.purchase { color: var(--ink); }
      /* A row: tile | name and line | pill | +. Narrow (the window view), the pill goes under the line, so the name
         keeps the width. */
      .ra-evrow { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; column-gap: 10px; row-gap: 4px; text-align: left; }
      @container (max-width: 400px) {
        .ra-evrow { grid-template-columns: auto minmax(0, 1fr) auto; }
        .ra-evrow > .ra-date { grid-row: span 2; align-self: start; }
        .ra-evrow > .ra-pill { grid-column: 2; grid-row: 2; justify-self: start; }
        .ra-evrow > .ra-chev { grid-column: 3; grid-row: 1 / span 2; }
      }
`;

/** Add the event styles to the root the answer view draws in, once. */
export function styleEvents(root: ShadowRoot | Document): void {
  const doc = root.ownerDocument ?? (root as Document);
  const into = root.nodeType === 9 ? (root as Document).head : root;
  if (into.querySelector('style[data-ev]')) return;
  const style = doc.createElement('style');
  style.dataset.ev = '';
  style.textContent = EVENT_CARDS_CSS;
  into.append(style);
}

// ── What the element asks of this module ─────────────────────────────────────────────────────────────────────────

/** What an event's buttons need from the element. */
export interface EventHost {
  /** Start one of the site's forms in the chat, by its action's `@id`, as a handoff link does. */
  openForm(actionId: string): void;
  /** Go to a page, keeping the conversation (the element's guardrails first). */
  go(url: string, name: string): void;
  /** Open a file beside the page: a calendar file. */
  beside(url: string): void;
  /** How a link opens from this page (`harness/tools/open-target.ts`). */
  openWay(url: string): OpenWay;
  /** Whether two addresses are the same page, query and fragment aside (`harness/tools/site-actions.ts`). */
  samePage(a: string, b: string): boolean;
  /** The address that hands someone to an action's form on its page (`harness/tools/inbound.ts`). */
  handoffUrl(pageUrl: string, actionId: string, intent?: string, reportToken?: string): string;
  /** Report a tap that opens a page, and hold the site's token for a form (`harness/tools/report.ts`). */
  report(tap: PageOpenTap, opts?: { leaving?: boolean }): void;
  remember(actionId: string, token: string): void;
  /** The page now open. */
  here(): string;
}

/**
 * An event's button was tapped. Get tickets on the site's own form starts it: here, when the form is on this page, as
 * a handoff link would; on another page of the site, by handing the visitor to it, the conversation going along.
 * Every tap with an outcome is reported: `purchase_start` and `register_start` say the visitor meant to, and only the
 * site's own confirmation counts as a conversion.
 *
 * @param leaving - The browser is about to leave this tab for another page of the site.
 * @returns Whether the tap was taken here, so its link is not followed.
 */
export function eventTap(b: EventButton, name: string, leaving: boolean, host: EventHost): boolean {
  const tap = { outcome: b.outcome, actionType: b.actionType, actionId: b.actionId, reportToken: b.reportToken };
  const form = b.kind === 'ticket' ? b.form : undefined;
  const ours = !!form && host.openWay(form.pageUrl) !== 'new-tab';
  // An offer's own page, a declared target, or a form on another site that runs no agent: the link as it is.
  if (!form || (!ours && !form.onPageAgent)) {
    if (b.outcome) host.report(tap, { leaving });
    return false;
  }
  if (host.samePage(form.pageUrl, host.here())) {
    host.report(tap);
    if (b.reportToken) host.remember(form.actionId, b.reportToken);
    host.openForm(form.actionId);
    return true;
  }
  host.report(tap, { leaving: ours });
  host.go(host.handoffUrl(form.pageUrl, form.actionId, undefined, b.reportToken), name);
  return true;
}

/**
 * Results with events, ready for the answer view: each event's card (as of now, so "past" is said as of the moment it
 * is drawn), upcoming soonest first and past ones last, the pick following its card, and the views and tap handler.
 *
 * @param records - Each result's event record, where it is one.
 * @param calendar - Where the server the results came from builds calendar files.
 */
export function answerEvents(
  root: ShadowRoot | Document,
  cards: AnswerCard[],
  records: (Record<string, unknown> | undefined)[],
  pick: ResultPick | undefined,
  calendar: string | undefined,
  host: EventHost,
): { cards: AnswerCard[]; pick: ResultPick | undefined; handlers: Pick<AnswerHandlers, 'events' | 'eventTap'> } {
  styleEvents(root);
  const drawn = cards.map((c, i) => {
    const r = records[i];
    if (!r) return c;
    const event = eventCard(r, calendar ? { calendar } : {});
    return { ...c, event, byline: eventLine(event), badge: eventPill(event)?.label };
  });
  const order = arrangeEvents(drawn, (c) => c.event);
  return {
    cards: order.map((i) => drawn[i]),
    pick: pick && { ...pick, index: order.indexOf(pick.index) },
    handlers: { events: eventViews(host.openWay), eventTap: (b, name, leaving) => eventTap(b, name, leaving, host) },
  };
}

/**
 * Events as an A2UI surface (`a2ui="a2ui-results"`): a lone one as its card, several as rows. `tap` takes the
 * surface's `nxis.event`: its ticket form started or handed to, a calendar file opened beside the page, anything else
 * gone to.
 */
export function eventSurface(heading: string, records: Record<string, unknown>[], calendar: string | undefined, host: EventHost): { messages: A2uiMessage[]; tap(ctx: Record<string, unknown>): void } {
  const events = records.map((r) => eventCard(r, calendar ? { calendar } : {}));
  const messages = events.length === 1 ? emitEventSurface(events[0]) : emitEventsSurface(heading, arrangeEvents(events, (e) => e).map((i) => events[i]));
  return {
    messages,
    tap(ctx) {
      const found = events.flatMap((e) => e.buttons.map((b) => ({ b, name: e.title }))).find((x) => x.b.url && x.b.url === ctx.url && x.b.kind === ctx.kind);
      if (!found) return;
      const { b, name } = found;
      const url = b.url!;
      if (b.kind === 'calendar') return host.beside(url);
      if (!eventTap(b, name, host.openWay(url) === 'same-site', host)) host.go(url, name);
    },
  };
}
