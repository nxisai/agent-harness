// @vitest-environment happy-dom
/**
 * Event cards in the chat, on the Wrenfield events demo's records: the answer view's
 * card and rows, what a tap on Get tickets does (the form started here, handed to its page, or the offer's link),
 * what it reports, and the element drawing them from a tool result once their module has loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import F from './fixtures/wrenfield-records.json';
import { compact } from '../src/harness/entity';
import { eventCard, type EventButton } from '../src/harness/happening';
import { answerEvents, eventSurface, eventTap, type EventHost } from '../src/ui/event-cards';
import { resultsAnswer, type AnswerCard, type AnswerHandlers } from '../src/ui/result-pick';
import { handoffUrl } from '../src/harness/tools/inbound';
import { openWay } from '../src/harness/tools/open-target';
import { samePage } from '../src/harness/tools/site-actions';
import { pageOpenReport, reportPageOpen, setPageOpenReporter, takeReportToken, type PageOpenReport } from '../src/harness/tools/report';
import { calendarBase } from '../src/harness/tools/source';
import { savePendingVisit } from '../src/harness/tools/pending-action';
import '../src/ui/agent';

type Obj = Record<string, any>;
const P = F.page as unknown as Record<string, Obj>;
const S = F.served as unknown as Record<string, Obj>;
const SITE = 'https://wrenfield.example';
const FEST_PAGE = `${SITE}/events/field-days-denver-2027/`;
const FEST_FORM = 'urn:nxis:action:bbc076b7ca296e71033d851a65ee8a3a';
const CAL = 'https://wrenfield.mcp.nxis.ai/ics/';
const variant = (r: Obj, fields: Obj): Obj => Object.assign(JSON.parse(JSON.stringify(r)), fields);

/** A host on a page of the site, recording what it was asked. */
function hostAt(here: string) {
  const calls: { openForm: string[]; go: string[]; beside: string[]; reports: { tap: Obj; leaving?: boolean }[]; tokens: [string, string][] } = {
    openForm: [], go: [], beside: [], reports: [], tokens: [],
  };
  const host: EventHost = {
    openForm: (id) => void calls.openForm.push(id),
    go: (url) => void calls.go.push(url),
    beside: (url) => void calls.beside.push(url),
    openWay: (url) => openWay(url, here),
    samePage,
    handoffUrl,
    report: (tap, opts) => void calls.reports.push({ tap, leaving: opts?.leaving }),
    remember: (id, token) => void calls.tokens.push([id, token]),
    here: () => here,
  };
  return { host, calls };
}

const ticketOf = (r: Obj): EventButton => eventCard(compact(r), { now: new Date('2026-11-16T12:00:00Z') }).buttons[0];

describe('Get tickets', () => {
  it('on the form’s own page: starts the form here, reports purchase_start, and holds the site’s token for it', () => {
    const { host, calls } = hostAt(`${FEST_PAGE}?utm=x#tickets`);
    expect(eventTap(ticketOf(P.festival), 'Field Days Denver', false, host)).toBe(true);
    expect(calls.openForm).toEqual([FEST_FORM]);
    expect(calls.go).toEqual([]);
    expect(calls.tokens).toEqual([[FEST_FORM, 'tok.tickets']]);
    expect(calls.reports).toEqual([{ tap: { outcome: 'purchase_start', actionType: 'InteractAction', actionId: FEST_FORM, reportToken: 'tok.tickets' }, leaving: undefined }]);
  });

  it('on another page of the site: hands the visitor to the form’s page, with the token, the report sent from there', () => {
    const { host, calls } = hostAt(`${SITE}/events/`);
    expect(eventTap(ticketOf(P.festival), 'Field Days Denver', true, host)).toBe(true);
    expect(calls.openForm).toEqual([]);
    expect(calls.go).toEqual([`${FEST_PAGE}?nxis_handoff=urn%3Anxis%3Aaction%3Abbc076b7ca296e71033d851a65ee8a3a&nxis_report=tok.tickets`]);
    expect(calls.reports.map((r) => [r.tap.outcome, r.leaving])).toEqual([['purchase_start', true]]);
  });

  it('with no page for the form: the offer’s link, as a link, reported as purchase_start', () => {
    const pending = variant(P.festival, {});
    const target = pending.potentialAction['https://schema.org/target'];
    delete target['https://nxis.ai/ns#pageUrl'];
    const b = ticketOf(pending);
    expect(b.url).toBe(`${FEST_PAGE}#pass-weekend`);
    const { host, calls } = hostAt(`${SITE}/events/`);
    expect(eventTap(b, 'Field Days Denver', true, host)).toBe(false);
    expect(calls.reports).toEqual([{ tap: { outcome: 'purchase_start', actionType: undefined, actionId: undefined, reportToken: undefined }, leaving: true }]);
  });

  it('a free event registers, reported as register_start', () => {
    const free = variant(P.sideRoom, { offers: [{ '@type': 'Offer', price: 0, priceCurrency: 'USD' }] });
    const { host, calls } = hostAt(`${SITE}/events/side-room-austin-2027-03-05/`);
    const b = ticketOf(free);
    expect(b.label).toBe('Register · Free');
    eventTap(b, 'Side Room Austin', false, host);
    expect(calls.reports[0].tap.outcome).toBe('register_start');
    expect(calls.openForm).toEqual(['urn:nxis:action:side-room-austin']);
  });

  it('a form on another site is opened as a link, unless that page runs its own agent', () => {
    const elsewhere = variant(P.festival, {});
    elsewhere.potentialAction['https://schema.org/target']['https://nxis.ai/ns#pageUrl'] = 'https://tickets.example/field-days/';
    const { host, calls } = hostAt(FEST_PAGE);
    expect(eventTap(ticketOf(elsewhere), 'x', false, host)).toBe(false);
    elsewhere.potentialAction['https://schema.org/target']['https://nxis.ai/ns#onPageAgent'] = true;
    expect(eventTap(ticketOf(elsewhere), 'x', false, host)).toBe(true);
    expect(calls.go).toEqual(['https://tickets.example/field-days/?nxis_handoff=urn%3Anxis%3Aaction%3Abbc076b7ca296e71033d851a65ee8a3a&nxis_report=tok.tickets']);
  });
});

describe('what a tap reports', () => {
  it('purchase_start and register_start, page_open otherwise, and nothing that isn’t one of them', () => {
    expect(pageOpenReport({ outcome: 'purchase_start', actionType: 'InteractAction', actionId: 'urn:a', reportToken: 't' })).toEqual({
      outcome: 'purchase_start', action_type: 'InteractAction', action_id: 'urn:a', report_token: 't', source: 'on_page_agent',
    });
    expect(pageOpenReport({ outcome: 'register_start' }).outcome).toBe('register_start');
    expect(pageOpenReport({ outcome: 'submitted' as never }).outcome).toBe('page_open');
  });

  it('a tap that leaves the page is sent from the next one', () => {
    sessionStorage.clear();
    reportPageOpen({ outcome: 'purchase_start', actionId: 'urn:a' }, { leaving: true });
    const sent: PageOpenReport[] = [];
    setPageOpenReporter((r) => void sent.push(r));
    expect(sent).toEqual([{ outcome: 'purchase_start', action_id: 'urn:a', source: 'on_page_agent' }]);
    setPageOpenReporter(null);
  });
});

describe('the calendar server', () => {
  it('is beside the MCP endpoint discovery found, for a server a browser can reach', () => {
    expect(calendarBase({ endpoint: 'https://wrenfield.mcp.nxis.ai/mcp', authRequired: false })).toBe(CAL);
    expect(calendarBase({ endpoint: 'https://mcp.example/tenant/wrenfield.mcp.nxis.ai/mcp/', authRequired: false })).toBe('https://mcp.example/tenant/wrenfield.mcp.nxis.ai/ics/');
    expect(calendarBase({ endpoint: 'https://x.example/mcp', authRequired: true })).toBeUndefined();
    expect(calendarBase({ endpoint: 'javascript:alert(1)', authRequired: false })).toBeUndefined();
  });
});

/** The answer view with events, as the element draws it. */
function answer(records: Obj[], here = `${SITE}/`, extra: Partial<AnswerHandlers> = {}) {
  const { host, calls } = hostAt(here);
  const cards: AnswerCard[] = records.map((r) => ({ title: String(r.name), facts: [], archetype: r['@type'] === 'Plumber' ? 'place' : 'happening', group: r['@type'] === 'Plumber' ? 'Businesses' : 'Events' }));
  const asked: string[] = [];
  const ev = answerEvents(document, cards, records.map((r) => (r['@type'] === 'Plumber' ? undefined : compact(r))), undefined, CAL, host);
  const el = resultsAnswer(ev.cards, ev.pick, { ask: (t) => void asked.push(t), ...ev.handlers, ...extra });
  document.body.append(el);
  return { el, calls, asked };
}
const text = (n: Element | null) => (n?.textContent ?? '').replace(/\s+/g, ' ');

describe('the answer view', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-16T12:00:00Z'), toFake: ['Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('draws a lone festival as its card: facts first, then Get tickets, Add to calendar and Directions, then its days', () => {
    const { el } = answer([P.festival]);
    const t = text(el);
    for (const w of ['Field Days Denver', 'Festival', 'From $48', 'Sat Jul 24 – Sun Jul 25, 2027', 'Railspur Pavilion, Denver', 'By Wrenfield Events Co.',
      'With Nightjar Assembly, Odalys Brightwater, 8 more', 'Get tickets · From $48', 'Add to calendar', 'Directions', 'Days', 'Saturday', 'Sun Jul 25, 12–10 pm']) {
      expect(t).toContain(w);
    }
    expect(t.indexOf('Railspur Pavilion')).toBeLessThan(t.indexOf('Get tickets'));
    expect(el.querySelector('.ra-date .ra-mon')!.textContent).toBe('Jul');
    expect(el.querySelector('.ra-avatar')).toBeNull();
    const links = [...el.querySelectorAll<HTMLAnchorElement>('a.ra-btn')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]);
    expect(links).toEqual([
      ['Get tickets · From $48', FEST_PAGE, null],
      ['Add to calendar', `${CAL}aHR0cHM6Ly93cmVuZmllbGQuZXhhbXBsZS9ldmVudHMvZmllbGQtZGF5cy1kZW52ZXItMjAyNyNmZXN0aXZhbA.ics`, '_blank'],
      ['Directions', 'https://www.google.com/maps/search/?api=1&query=Railspur%20Pavilion%2C%202750%20Cindertrack%20Street%2C%20Denver%2C%20CO%2080205', '_blank'],
    ]);
  });

  it('Get tickets is taken by the handoff, not followed; Add to calendar is followed and reports nothing', () => {
    const { el, calls } = answer([P.festival], `${SITE}/events/`);
    const [tickets, cal] = [...el.querySelectorAll<HTMLAnchorElement>('a.ra-btn')];
    const click = (a: HTMLElement) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      a.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(click(tickets)).toBe(true);
    expect(calls.go).toHaveLength(1);
    cal.addEventListener('click', (e) => e.preventDefault()); // happy-dom would open it
    click(cal);
    expect(calls.reports).toHaveLength(1);
  });

  it('a venue the site holds asks for its card', () => {
    const { el, asked } = answer([P.festival]);
    (el.querySelector('button.ra-inline') as HTMLButtonElement).click();
    expect(asked).toEqual(['Tell me about Railspur Pavilion']);
  });

  it('sold out is said, and is no link', () => {
    const { el } = answer([P.supper]);
    const sold = [...el.querySelectorAll('button.ra-btn')].find((b) => b.textContent === 'Sold out') as HTMLButtonElement;
    expect(sold.disabled).toBe(true);
    expect(text(el)).not.toContain('Get tickets');
  });

  it('cancelled says so, with no ticket and no price', () => {
    const { el } = answer([variant(P.sideRoom, { eventStatus: 'https://schema.org/EventCancelled' })]);
    const t = text(el);
    expect(t).toContain('Cancelled');
    expect(t).not.toContain('Get tickets');
    expect(t).not.toContain('$58');
  });

  it('rescheduled says when it was', () => {
    expect(text(answer([P.rescheduled]).el)).toContain('Moved from Fri Jun 25, 2027');
  });

  it('a conference shows three sessions, then Show all', () => {
    const { el } = answer([P.conference]);
    expect(el.querySelectorAll('.ra-parts .ra-mrow')).toHaveLength(3);
    // The visitor's zone is the machine's here, so the session's may be named after its time.
    expect(text(el.querySelector('.ra-parts .ra-mrow'))).toMatch(/^Made to LastThu Oct 7, 9:30–10:15 am( UTC−6)? · With a pass$/);
    expect(text(el)).toContain('On sale Jun 1');
    const more = el.querySelector('.ra-parts .ra-textbtn') as HTMLButtonElement;
    expect(more.textContent).toBe('Show all 10');
    more.click();
    expect(el.querySelectorAll('.ra-parts .ra-mrow')).toHaveLength(10);
  });

  it('the Festival as served draws its name and kind, and nothing it does not say', () => {
    const { el } = answer([S.festival]);
    expect([...el.querySelectorAll('.ra-event .ra-head .ra-who > *')].map((n) => n.textContent)).toEqual(['Field Days Denver', 'Festival']);
    expect(el.querySelector('.ra-event .ra-pill')).toBeNull();
    expect(el.querySelectorAll('.ra-btn')).toHaveLength(0);
    expect(text(el)).not.toMatch(/Free|Get tickets|Add to calendar/);
  });

  it('a list: events grouped, soonest first, each row with when and where and its status or access', () => {
    const { el } = answer([P.festival, { '@type': 'Plumber', name: 'Boiler Brothers' }, P.rescheduled, P.supper]);
    expect([...el.querySelectorAll('.ra-group')].map((g) => g.textContent)).toEqual(['Events', 'Businesses']);
    const rows = [...el.querySelectorAll('.ra-row strong')].map((s) => s.textContent);
    expect(rows).toEqual(['Night Table Savannah: Low Country, High Tide', 'Low Light Savannah: The Tide Clock', 'Field Days Denver', 'Boiler Brothers']);
    const first = text(el.querySelector('.ra-row'));
    expect(first).toContain('Sat Mar 20, 2027, 7–10 pm');
    expect(first).toContain('Saltbox Courtyard, Savannah');
    expect(first).toContain('Sold out');
  });

  it('the A2UI surface’s taps: Get tickets handed off, the calendar beside the page', () => {
    const { host, calls } = hostAt(`${SITE}/events/`);
    const s = eventSurface('2 results', [compact(P.festival)], CAL, host);
    const dm = (s.messages[0] as Obj).createSurface.dataModel;
    expect(dm.buttons.map((b: Obj) => b.label)).toEqual(['Get tickets · From $48', 'Add to calendar', 'Directions']);
    s.tap(dm.buttons[0]);
    s.tap(dm.buttons[1]);
    expect(calls.go[0]).toContain('nxis_handoff=');
    expect(calls.beside).toEqual([dm.buttons[1].url]);
  });
});

describe('in the element', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('draws nxis_query’s events as event cards once their module loads, with Add to calendar on the server they came from', async () => {
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    el._remoteTools = new Set(['nxis_query']);
    el._calendar = CAL;
    const item = el._buildResultsItem({ name: 'nxis_query' }, { structuredContent: { results: [P.conference, P.festival] } });
    expect(item.calendar).toBe(CAL);
    el._active().items.push(item);
    el._renderThread();
    const thread = () => el.shadowRoot.querySelector('.thread') as HTMLElement;
    await vi.waitFor(() => expect(thread().querySelector('.ra-date')).not.toBeNull(), { timeout: 5000 });
    expect(el.shadowRoot.querySelector('style[data-ev]')).not.toBeNull();
    const rows = [...thread().querySelectorAll('.ra-row strong')].map((s) => s.textContent);
    expect(rows).toEqual(['Field Days Denver', 'Open Signal Denver']);
    // Opened, the first row's buttons.
    const hrefs = [...thread().querySelectorAll<HTMLAnchorElement>('.ra-more a.ra-btn')].map((a) => a.getAttribute('href'));
    expect(hrefs[1]).toMatch(new RegExp(`^${CAL.replace(/[.]/g, '\\.')}`));
    // A page tool's results name no calendar: the server never saw those records.
    expect(el._buildResultsItem({ name: 'page_events' }, { structuredContent: { results: [P.festival] } }).calendar).toBeUndefined();
  });

  it('Get tickets on the form’s own page starts the form in this conversation', async () => {
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    const opened: unknown[] = [];
    el._openForm = async (h: unknown) => void opened.push(h);
    const host = el._eventHost() as EventHost;
    const b = ticketOf(P.festival);
    const here = vi.spyOn(host, 'here').mockReturnValue(FEST_PAGE);
    vi.spyOn(host, 'openWay').mockReturnValue('in-place');
    expect(eventTap(b, 'Field Days Denver', false, host)).toBe(true);
    expect(here).toHaveBeenCalled();
    expect(opened).toEqual([{ actionId: FEST_FORM }]);
    expect(takeReportToken(FEST_FORM)).toBe('tok.tickets');
  });
});

describe('handed to the form’s page from this chat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('opens the form in the conversation it came from, not a new one', async () => {
    localStorage.clear();
    sessionStorage.clear();
    const conv = { id: 'c-events', title: 'Events', messages: [{ role: 'user', content: 'What is on in July?' }], items: [] };
    localStorage.setItem('nxis-listings-agent-conversations', JSON.stringify([{ id: 'c-other', title: 'Other', messages: [], items: [] }, conv]));
    // The tap on another page saved the visit and went to the form's page with the handoff.
    savePendingVisit({ pageUrl: FEST_PAGE, label: 'Field Days Denver', conversationId: 'c-events' });
    (window as any).happyDOM.setURL(`${FEST_PAGE}?nxis_handoff=${encodeURIComponent(FEST_FORM)}&nxis_report=tok.tickets`);
    const opened: unknown[] = [];
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    el._openForm = async (h: unknown) => void opened.push(h);
    document.body.append(el);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened).toEqual([{ actionId: FEST_FORM, reportToken: 'tok.tickets' }]);
    expect(el._conversations.map((c: Obj) => c.id)).toEqual(['c-other', 'c-events']);
    expect(el._activeId).toBe('c-events');
    expect(location.href).toBe(FEST_PAGE);
    expect(takeReportToken(FEST_FORM)).toBe('tok.tickets');
  });
});
