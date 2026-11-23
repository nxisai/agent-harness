/**
 * Events as A2UI surfaces: a list of rows, and one event's card with its days or sessions.
 *
 * As the Hub draws them (and `ui/event-cards.ts` for the answer view): a row says when and where under the name, with
 * its status or access and its lead; the card leads with when and where, then Get tickets, Add to calendar and
 * Directions, then its parts, three until "Show all". The basic catalog has no date tile or pill, so the date and
 * the status are words. A closed lead ("Sold out", "On sale Jun 1") is drawn as words, never as a button.
 *
 * @module
 */
import type { A2uiMessage } from './emit.js';
import { EVENT_PARTS_SHOWN, eventFacts, eventLine, eventPill, showAllParts, type EventButton, type EventCard } from '../harness/happening.js';

const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

interface Component { id: string; component: string; [prop: string]: unknown }

/** A button as the event surfaces bind it. A tap sends `nxis.event` with these, and the host opens or starts it. */
export interface EventButtonData {
  label: string;
  url: string;
  /** The event's name, for the conversation to say where it went. */
  name: string;
  kind: EventButton['kind'];
  outcome: string;
  actionType: string;
  actionId: string;
  /** The ticket form's own page, when the button opens one; empty otherwise. */
  formPage: string;
}

/** A tap on an event's button. The host opens `url`, or starts the ticket form on `formPage` (see `ui/agent.ts`). */
const EVENT_TAP = {
  event: {
    name: 'nxis.event',
    context: { url: '${url}', name: '${name}', kind: '${kind}', outcome: '${outcome}', actionType: '${actionType}', actionId: '${actionId}', formPage: '${formPage}' },
  },
};
const MORE_EVENT = { event: { name: 'nxis.more', context: {} } };

const buttonData = (b: EventButton, name: string): EventButtonData => ({
  label: b.label,
  url: b.url ?? '',
  name,
  kind: b.kind,
  outcome: b.outcome ?? '',
  actionType: b.actionType ?? '',
  actionId: b.actionId ?? '',
  formPage: b.form?.pageUrl ?? '',
});

/** A card's buttons as data: the ones that open something, and a closed lead as words. */
function buttonsOf(c: EventCard) {
  return {
    buttons: c.buttons.filter((b) => b.kind !== 'closed').map((b) => buttonData(b, c.title)),
    closed: c.buttons.filter((b) => b.kind === 'closed').map((b) => ({ label: b.label })),
  };
}

const dateOf = (c: EventCard) => (c.when ? `${c.when.mon} ${c.when.day}` : '');
const pillOf = (c: EventCard) => eventPill(c)?.label ?? '';

/** Rows shown before "Show all", as the answer view's list shows them. */
const ROWS_SHOWN = 5;

/**
 * Events as rows: the date, the name, "Festival · Sat Jul 24 – Sun Jul 25, 2027 · Railspur Pavilion, Denver", its
 * status or access, and its lead. Past five, the rest wait behind "Show all N".
 *
 * @param events - In the order to show them (`arrangeEvents`).
 */
export function emitEventsSurface(heading: string, events: EventCard[], surfaceId = 'results'): A2uiMessage[] {
  const rows = events.map((c) => {
    // The row's lead is the card's: a closed one is its words, and nothing else stands in for it.
    const lead = c.buttons[0];
    return {
      date: dateOf(c), title: c.title, line: eventLine(c), pill: pillOf(c),
      lead: lead && lead.kind !== 'closed' ? [buttonData(lead, c.title)] : [],
      closed: lead?.kind === 'closed' ? [{ label: lead.label }] : [],
    };
  });
  const fits = rows.length <= ROWS_SHOWN + 1;
  const components: Component[] = [
    { id: 'root', component: 'Column', children: ['heading', 'events', 'more'] },
    { id: 'heading', component: 'Text', text: heading, variant: 'body' },
    { id: 'events', component: 'List', children: { path: '/events', componentId: 'ev_row' }, direction: 'vertical' },
    { id: 'ev_row', component: 'Row', children: ['ev_date', 'ev_who', 'ev_lead', 'ev_closed'], align: 'center', justify: 'spaceBetween' },
    { id: 'ev_date', component: 'Text', text: '${date}', variant: 'caption' },
    { id: 'ev_who', component: 'Column', children: ['ev_title', 'ev_line', 'ev_pill'], weight: 1 },
    { id: 'ev_title', component: 'Text', text: '${title}', variant: 'body' },
    { id: 'ev_line', component: 'Text', text: '${line}', variant: 'caption' },
    { id: 'ev_pill', component: 'Text', text: '${pill}', variant: 'caption' },
    { id: 'ev_lead', component: 'List', children: { path: 'lead', componentId: 'ev_btn' }, direction: 'horizontal' },
    { id: 'ev_btn', component: 'Button', child: 'ev_btn_label', action: EVENT_TAP },
    { id: 'ev_btn_label', component: 'Text', text: '${label}', variant: 'body' },
    { id: 'ev_closed', component: 'List', children: { path: 'closed', componentId: 'ev_closed_label' }, direction: 'horizontal' },
    { id: 'ev_closed_label', component: 'Text', text: '${label}', variant: 'caption' },
    { id: 'more', component: 'List', children: { path: '/more', componentId: 'more_btn' }, direction: 'vertical' },
    { id: 'more_btn', component: 'Button', child: 'more_label', variant: 'borderless', action: MORE_EVENT },
    { id: 'more_label', component: 'Text', text: '${label}', variant: 'body' },
  ];
  return [{
    version: 'v1.0',
    createSurface: {
      surfaceId, catalogId: CATALOG, components,
      dataModel: { events: fits ? rows : rows.slice(0, ROWS_SHOWN), more: fits ? [] : [{ label: showAllParts(rows.length) }], all: { events: rows } },
    },
  }];
}

/**
 * One event as its card: the date, its name and kind, its status or access; when, where, who runs it and who's on;
 * Get tickets (or "Sold out"), Add to calendar, Directions; then its days or sessions, three until "Show all".
 */
export function emitEventSurface(c: EventCard, surfaceId = 'results'): A2uiMessage[] {
  const parts = c.parts.map((p) => ({ title: p.title, line: [p.when, p.access?.label].filter(Boolean).join(' · ') }));
  const fits = parts.length <= EVENT_PARTS_SHOWN;
  const components: Component[] = [
    { id: 'root', component: 'Card', child: 'event' },
    { id: 'event', component: 'Column', children: ['ev_head', 'ev_facts', 'ev_actions', 'ev_closed', 'ev_parts_label', 'parts', 'more'] },
    { id: 'ev_head', component: 'Row', children: ['ev_date', 'ev_who', 'ev_pill'], align: 'center' },
    { id: 'ev_date', component: 'Text', text: '${/date}', variant: 'caption' },
    { id: 'ev_who', component: 'Column', children: ['ev_title', 'ev_kind'], weight: 1 },
    { id: 'ev_title', component: 'Text', text: '${/title}', variant: 'body' },
    { id: 'ev_kind', component: 'Text', text: '${/kind}', variant: 'caption' },
    { id: 'ev_pill', component: 'Text', text: '${/pill}', variant: 'caption' },
    { id: 'ev_facts', component: 'List', children: { path: '/facts', componentId: 'ev_fact' }, direction: 'vertical' },
    { id: 'ev_fact', component: 'Text', text: '${label}', variant: 'caption' },
    { id: 'ev_actions', component: 'List', children: { path: '/buttons', componentId: 'ev_btn' }, direction: 'horizontal' },
    { id: 'ev_btn', component: 'Button', child: 'ev_btn_label', action: EVENT_TAP },
    { id: 'ev_btn_label', component: 'Text', text: '${label}', variant: 'body' },
    { id: 'ev_closed', component: 'List', children: { path: '/closed', componentId: 'ev_closed_label' }, direction: 'horizontal' },
    { id: 'ev_closed_label', component: 'Text', text: '${label}', variant: 'body' },
    { id: 'ev_parts_label', component: 'List', children: { path: '/partsLabel', componentId: 'ev_parts_label_text' }, direction: 'vertical' },
    { id: 'ev_parts_label_text', component: 'Text', text: '${label}', variant: 'caption' },
    { id: 'parts', component: 'List', children: { path: '/parts', componentId: 'part_row' }, direction: 'vertical' },
    { id: 'part_row', component: 'Column', children: ['part_title', 'part_line'] },
    { id: 'part_title', component: 'Text', text: '${title}', variant: 'body' },
    { id: 'part_line', component: 'Text', text: '${line}', variant: 'caption' },
    { id: 'more', component: 'List', children: { path: '/more', componentId: 'more_btn' }, direction: 'vertical' },
    { id: 'more_btn', component: 'Button', child: 'more_label', variant: 'borderless', action: MORE_EVENT },
    { id: 'more_label', component: 'Text', text: '${label}', variant: 'body' },
  ];
  const { buttons, closed } = buttonsOf(c);
  return [{
    version: 'v1.0',
    createSurface: {
      surfaceId, catalogId: CATALOG, components,
      dataModel: {
        date: dateOf(c),
        title: c.title,
        kind: c.kind,
        pill: pillOf(c),
        facts: eventFacts(c).map((label) => ({ label })),
        buttons,
        closed,
        partsLabel: parts.length ? [{ label: c.partsLabel }] : [],
        parts: fits ? parts : parts.slice(0, EVENT_PARTS_SHOWN),
        more: fits ? [] : [{ label: showAllParts(parts.length) }],
        all: { parts },
      },
    },
  }];
}
