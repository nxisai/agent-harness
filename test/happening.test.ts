/**
 * Event cards: the Hub's states, from the Wrenfield events demo's records
 * (fixtures/wrenfield-records.json, as the MCP server's tests carry them): `served` as its MCP server returns them today,
 * `page` as its pages state them, with the ticket form in the shape the autofill runner records.
 *
 * The same cases, and the same words, as the MCP server's widget tests: the two surfaces draw one card.
 */
import { describe, expect, it } from 'vitest';
import F from './fixtures/wrenfield-records.json';
import { archetype, compact, groupOf } from '../src/harness/entity';
import { arrangeEvents, calendarUrl, eventAccess, eventCard, eventFacts, recordKey, type EventCard, type EventOptions } from '../src/harness/happening';
import { emitResultsSurface } from '../src/a2ui/results';
import { RENDERER_SPEC } from '../src/harness/renderer-spec';

type Obj = Record<string, unknown>;
const P = F.page as unknown as Record<string, Obj>;
const S = F.served as unknown as Record<string, Obj>;
const now = new Date('2026-11-16T12:00:00Z');
const CAL = 'https://wrenfield.mcp.nxis.ai/ics/';
/** A visitor at a fixed offset (minutes east of UTC): -360 is the festival's own (Denver in summer). */
const at = (min: number, more: EventOptions = {}): EventOptions => ({ calendar: CAL, visitorOffset: () => min, ...more });
/** As the harness reads it: compacted first, as `_entityCard` does. */
const card = (r: Obj, o: EventOptions = at(-360), when: Date = now): EventCard => eventCard(compact(r), { now: when, ...o });
const labels = (c: EventCard) => c.buttons.map((b) => (b.primary ? '*' : '') + b.label + (b.kind === 'closed' ? ' (disabled)' : ''));
const variant = (r: Obj, fields: Obj): Obj => Object.assign(JSON.parse(JSON.stringify(r)), fields);

describe('the spec', () => {
  it('draws events as their own archetype, in phase 1, with CourseInstance deferred', () => {
    expect(archetype({ '@type': 'Event' })).toBe('happening');
    expect(archetype({ '@type': 'https://schema.org/Festival' })).toBe('happening');
    expect(archetype({ '@type': 'ConferenceEvent' })).toBe('happening');
    expect(archetype({ '@type': 'CourseInstance' })).toBe('thing');
    expect(groupOf('happening')).toBe('Events');
    expect(RENDERER_SPEC.happening.actions).toMatchObject({ tickets: 'Get tickets', register: 'Register', calendar: 'Add to calendar', directions: 'Directions' });
  });
});

describe('on sale: a Wrenfield festival', () => {
  const fest = card(P.festival);

  it('says when, where and what it costs, from its lowest price', () => {
    expect(archetype(P.festival)).toBe('happening');
    expect(fest.title).toBe('Field Days Denver');
    expect(fest.kind).toBe('Festival');
    expect(fest.when?.text).toBe('Sat Jul 24 – Sun Jul 25, 2027');
    expect(fest.where).toEqual([{ label: 'Railspur Pavilion, Denver', prompt: 'Tell me about Railspur Pavilion' }]);
    expect(fest.access).toEqual({ state: 'purchase', label: 'From $48' });
    expect(eventFacts(fest)).toEqual([
      'Sat Jul 24 – Sun Jul 25, 2027',
      'Railspur Pavilion, Denver',
      'By Wrenfield Events Co.',
      'With Nightjar Assembly, Odalys Brightwater, 8 more',
    ]);
    expect(fest.organizer.map((x) => [x.label, !!x.prompt])).toEqual([['Wrenfield Events Co.', true]]);
    expect(fest.performer.map((x) => [x.label, !!x.prompt])).toEqual([['Nightjar Assembly', true], ['Odalys Brightwater', false], ['8 more', false]]);
  });

  it('leads with Get tickets on the form’s own page, then Add to calendar and Directions', () => {
    expect(labels(fest)).toEqual(['*Get tickets · From $48', 'Add to calendar', 'Directions']);
    const t = fest.buttons[0];
    expect(t).toMatchObject({
      kind: 'ticket',
      url: 'https://wrenfield.example/events/field-days-denver-2027/',
      outcome: 'purchase_start',
      actionType: 'InteractAction',
      actionId: 'urn:nxis:action:bbc076b7ca296e71033d851a65ee8a3a',
      reportToken: 'tok.tickets',
      form: { pageUrl: 'https://wrenfield.example/events/field-days-denver-2027/', actionId: 'urn:nxis:action:bbc076b7ca296e71033d851a65ee8a3a' },
    });
    // Never the endpoint the form posts to.
    expect(fest.buttons.every((b) => !String(b.url).includes('/api/checkout'))).toBe(true);
    expect(fest.buttons[2].url).toBe('https://www.google.com/maps/search/?api=1&query=Railspur%20Pavilion%2C%202750%20Cindertrack%20Street%2C%20Denver%2C%20CO%2080205');
    expect(fest.buttons[1].outcome).toBeUndefined();
    expect(fest.buttons[2].outcome).toBeUndefined();
  });

  it('lists its days with their times and access', () => {
    expect(fest.partsLabel).toBe('Days');
    expect(fest.parts.map((p) => [p.title, p.when, p.access?.label])).toEqual([
      ['Saturday', 'Sat Jul 24, 12–10 pm', '$88'],
      ['Sunday', 'Sun Jul 25, 12–10 pm', '$88'],
    ]);
  });

  it('reads the records as served, in expanded IRIs, the same way', () => {
    expect(eventCard(P.festival, { now, ...at(-360) }).buttons.map((b) => b.label)).toEqual(labels(fest).map((l) => l.replace('*', '')));
  });

  it('marks a form whose page runs its own agent', () => {
    const agent = variant(P.festival, {});
    (agent.potentialAction as Obj)['https://schema.org/target'] = { ...((agent.potentialAction as Obj)['https://schema.org/target'] as Obj), 'https://nxis.ai/ns#onPageAgent': true };
    expect(card(agent).buttons[0].form?.onPageAgent).toBe(true);
  });
});

describe('Get tickets: the form’s page, else the offer’s, else none', () => {
  it('shows no button, no badge and no dates for the Festival as the index serves it today', () => {
    const served = card(S.festival);
    expect(archetype(S.festival)).toBe('happening');
    expect(labels(served)).toEqual([]);
    expect(served.access).toBeUndefined();
    expect(served.when).toBeUndefined();
    expect(served.where).toEqual([]);
    // Prose a page left in previousStartDate is not a date, and the event isn't rescheduled.
    expect(served.rescheduledFrom).toBeUndefined();
    expect(served.status).toBeUndefined();
    expect(JSON.stringify(served)).not.toContain('Free');
  });

  it('opens the first offer on sale when the form names no page yet', () => {
    const pending = variant(P.festival, {});
    const target = (pending.potentialAction as Obj)['https://schema.org/target'] as Obj;
    delete target['https://nxis.ai/ns#pageUrl'];
    delete target['https://nxis.ai/ns#targetKind'];
    const p = card(pending);
    expect(labels(p)).toEqual(['*Get tickets · From $48', 'Add to calendar', 'Directions']);
    expect(p.buttons[0]).toEqual({
      label: 'Get tickets · From $48', kind: 'ticket', url: 'https://wrenfield.example/events/field-days-denver-2027/#pass-weekend', outcome: 'purchase_start', primary: true,
    });
  });

  it('opens a declared BuyAction’s target', () => {
    const buy = card(variant(P.sideRoom, { potentialAction: { '@type': 'BuyAction', '@id': 'urn:buy', target: 'https://tickets.example/side-room' } }));
    expect([buy.buttons[0].label, buy.buttons[0].url, buy.buttons[0].actionType, buy.buttons[0].form]).toEqual(['Get tickets · $58', 'https://tickets.example/side-room', 'BuyAction', undefined]);
  });

  it('shows none with neither a form page nor an offer link', () => {
    const none = variant(P.sideRoom, { offers: [{ '@type': 'Offer', price: 32, priceCurrency: 'USD' }] });
    const target = (none.potentialAction as Obj)['https://schema.org/target'] as Obj;
    delete target['https://nxis.ai/ns#pageUrl'];
    expect(labels(card(none))).toEqual(['*Add to calendar', 'Directions', 'Their page']);
  });

  it('says not yet on sale for the served conference, and gives no directions without a street', () => {
    const conf = card(S.conference);
    expect(conf.when?.text).toBe('Thu Oct 7, 2027');
    expect(conf.where.map((w) => w.label)).toEqual(['Railspur Pavilion, Denver']);
    expect(labels(conf)).toEqual(['*On sale Jun 1 (disabled)', 'Add to calendar']);
  });
});

describe('cancelled, postponed, rescheduled, sold out, on sale from a date, past', () => {
  it('cancelled and postponed say so and replace tickets', () => {
    const cancelled = card(variant(P.sideRoom, { eventStatus: 'https://schema.org/EventCancelled' }));
    expect(cancelled.status).toEqual({ state: 'cancelled', label: 'Cancelled' });
    expect(cancelled.access).toBeUndefined();
    expect(labels(cancelled)).toEqual(['*Their page']);
    const postponed = card(variant(P.sideRoom, { eventStatus: 'EventPostponed' }));
    expect([postponed.status?.label, labels(postponed)]).toEqual(['Postponed', ['*Their page']]);
  });

  it('rescheduled says when it was, and keeps its new date for the calendar', () => {
    const moved = card(P.rescheduled);
    expect(moved.status).toEqual({ state: 'rescheduled', label: 'Rescheduled' });
    expect(moved.rescheduledFrom).toBe('Moved from Fri Jun 25, 2027');
    expect(labels(moved)).toEqual(['*Add to calendar', 'Directions', 'Their page']);
    expect(eventFacts(moved).slice(0, 2)).toEqual(['Fri Jul 9, 2027, 8–10 pm UTC−4', 'Moved from Fri Jun 25, 2027']);
  });

  it('sold out is said, and is no button', () => {
    const sold = card(P.supper);
    expect(sold.access).toEqual({ state: 'soldout', label: 'Sold out' });
    expect(sold.buttons[0]).toEqual({ label: 'Sold out', kind: 'closed', primary: true });
  });

  it('on sale from a date, until that date has passed', () => {
    const later = card(P.conference);
    expect(later.access).toEqual({ state: 'onsale', label: 'On sale Jun 1' });
    expect(later.buttons[0]).toEqual({ label: 'On sale Jun 1', kind: 'closed', primary: true });
    expect(card(P.conference, at(-360), new Date('2027-06-02T12:00:00Z')).buttons[0].label).toBe('Get tickets · From $60');
  });

  it('a past event is shown as past, with no ticket and no calendar', () => {
    const past = card(P.sideRoom, at(-360), new Date('2027-04-01T12:00:00Z'));
    expect(past.status).toEqual({ state: 'past', label: 'Past' });
    expect(labels(past)).toEqual(['*Their page']);
  });
});

describe('online and mixed', () => {
  it('a mixed one says both, with directions', () => {
    const mixed = card(P.conference);
    expect(mixed.where.map((w) => w.label)).toEqual(['Railspur Pavilion, Denver', 'Online']);
    expect(labels(mixed)).toContain('Directions');
  });

  it('an online one says Online and has no directions', () => {
    const online = card(variant(P.conference, { eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode' }));
    expect(online.where.map((w) => w.label)).toEqual(['Online']);
    expect(labels(online)).not.toContain('Directions');
  });

  it('moved online is still on: tickets stay, directions go', () => {
    const moved = card(variant(P.sideRoom, { eventStatus: 'https://schema.org/EventMovedOnline' }));
    expect([moved.status?.label, moved.where.map((w) => w.label)]).toEqual(['Moved online', ['Online']]);
    expect(labels(moved)).not.toContain('Directions');
    expect(moved.buttons[0].label).toBe('Get tickets · $58');
  });

  it('a record that names no mode is read from its locations', () => {
    const bare = card({ '@type': 'Event', name: 'Webinar', startDate: '2027-01-12T17:00Z', location: { '@type': 'VirtualLocation', url: 'https://x.example/live' } });
    expect(bare.where.map((w) => w.label)).toEqual(['Online']);
  });
});

describe('times, in the event’s own zone', () => {
  it('names the zone only when it differs from the visitor’s', () => {
    expect(card(P.supper, at(-240)).when?.text).toBe('Sat Mar 20, 2027, 7–10 pm');
    expect(card(P.supper, at(-300)).when?.text).toBe('Sat Mar 20, 2027, 7–10 pm UTC−4');
    const zoned = variant(P.supper, { eventSchedule: { '@type': 'Schedule', scheduleTimezone: 'America/New_York' } });
    expect(card(zoned, at(-300)).when?.text).toBe('Sat Mar 20, 2027, 7–10 pm EDT');
  });

  it('leaves out this year, shows half hours, and keeps a late set to one night', () => {
    const soon = { '@type': 'MusicEvent', name: 'x', startDate: '2026-12-04T11:30-05:00', endDate: '2026-12-04T13:00-05:00' };
    expect(card(soon, at(-300)).when?.text).toBe('Fri Dec 4, 11:30 am – 1 pm');
    const late = { '@type': 'MusicEvent', name: 'x', startDate: '2026-12-04T21:00-05:00', endDate: '2026-12-05T01:00-05:00' };
    expect(card(late, at(-300)).when?.text).toBe('Fri Dec 4, 9 pm – 1 am');
  });

  it('as served: a time with no offset names no zone; a date alone has no time', () => {
    expect(card(S.floating, at(0)).when?.text).toBe('Fri Mar 5, 2027, 9 pm');
    expect(card(S.conference, at(0)).when?.text).toBe('Thu Oct 7, 2027');
  });
});

describe('sessions, and records with gaps', () => {
  it('a conference lists its sessions, had with a pass', () => {
    const conf = card(P.conference, at(-360), new Date('2027-06-02T12:00:00Z'));
    expect(conf.kind).toBe('Conference');
    expect(conf.partsLabel).toBe('Sessions');
    expect(conf.parts).toHaveLength(10);
    expect(conf.parts.slice(0, 3).map((p) => [p.title, p.when, p.access?.label])).toEqual([
      ['Made to Last', 'Thu Oct 7, 9:30–10:15 am', 'With a pass'],
      ['Listening as a Design Tool', 'Thu Oct 7, 10:45–11:30 am', 'With a pass'],
      ['A Newsletter Is a Business', 'Thu Oct 7, 11:45 am – 12:30 pm', 'With a pass'],
    ]);
  });

  it('a part names what it is part of', () => {
    const session = card({ '@type': 'Event', name: 'Made to Last', startDate: '2027-10-07T09:30-06:00', superEvent: { '@type': 'ConferenceEvent', '@id': P.conference['@id'], name: 'Open Signal Denver' } });
    expect(session.partOf).toEqual({ label: 'Part of Open Signal Denver', prompt: 'Tell me about Open Signal Denver' });
  });

  it('no offers is no price, and never Free', () => {
    const c = card(variant(P.sideRoom, { offers: undefined, isAccessibleForFree: undefined }));
    expect(c.access).toBeUndefined();
    expect(labels(c)).toEqual(['*Get tickets', 'Add to calendar', 'Directions']);
    expect(JSON.stringify(c)).not.toContain('Free');
    expect(eventAccess(compact(S.floating), now)).toBeUndefined();
  });

  it('free is a price of 0 or isAccessibleForFree, and a free form registers', () => {
    const free = card(variant(P.sideRoom, { offers: [{ '@type': 'Offer', price: 0, priceCurrency: 'USD' }] }));
    expect([free.access, free.buttons[0].label, free.buttons[0].outcome]).toEqual([{ state: 'free', label: 'Free' }, 'Register · Free', 'register_start']);
    expect(card(variant(P.sideRoom, { offers: undefined, isAccessibleForFree: true })).buttons[0].label).toBe('Register · Free');
    const reg = card(variant(P.sideRoom, { potentialAction: { '@type': 'RegisterAction', '@id': 'urn:reg', target: { '@type': 'EntryPoint', url: 'https://x.example/register' } } }));
    expect([reg.buttons[0].label, reg.buttons[0].outcome, reg.buttons[0].actionType, reg.buttons[0].actionId]).toEqual(['Register · $58', 'register_start', 'RegisterAction', 'urn:reg']);
    expect(eventAccess({ offers: { '@type': 'AggregateOffer', lowPrice: 35, highPrice: 90, priceCurrency: 'USD' } }, now)?.label).toBe('From $35');
  });

  it('a record with a name and nothing else draws its name and kind, and nothing it does not say', () => {
    const c = card({ '@type': 'Festival', '@id': 'https://x.example/f', name: 'Somefest' });
    expect([c.title, c.kind, c.when, c.where, c.access, c.buttons, eventFacts(c)]).toEqual(['Somefest', 'Festival', undefined, [], undefined, [], []]);
  });
});

describe('Add to calendar', () => {
  it('opens the file the site’s MCP server builds, named by the record’s @id', () => {
    expect(card(P.festival).buttons[1].url).toBe(`${CAL}aHR0cHM6Ly93cmVuZmllbGQuZXhhbXBsZS9ldmVudHMvZmllbGQtZGF5cy1kZW52ZXItMjAyNyNmZXN0aXZhbA.ics`);
    expect(recordKey('https://x.example/é#a')).toBe('aHR0cHM6Ly94LmV4YW1wbGUvw6kjYQ');
    // The endpoint as discovery gives it, with or without a slash.
    expect(calendarUrl(compact(P.festival), CAL.slice(0, -1))).toBe(card(P.festival).buttons[1].url);
  });

  it('prefers the site’s own https .ics', () => {
    const own = card(variant(P.festival, { sameAs: ['https://wrenfield.example/events/field-days-denver-2027/event.ics'] }));
    expect(own.buttons.find((b) => b.kind === 'calendar')?.url).toBe('https://wrenfield.example/events/field-days-denver-2027/event.ics');
    const http = card(variant(P.festival, { sameAs: ['http://x.example/e.ics', 'https://x.example/e.html'] }));
    expect(http.buttons.find((b) => b.kind === 'calendar')?.url.startsWith(CAL)).toBe(true);
  });

  it('offers none without a server to build it, or an @id to name it by', () => {
    expect(labels(card(P.festival, { visitorOffset: () => -360 }))).not.toContain('Add to calendar');
    expect(labels(card(variant(P.festival, { '@id': undefined })))).not.toContain('Add to calendar');
  });
});

describe('lists', () => {
  it('events go upcoming soonest first, then past ones, latest first; the rest keep their place', () => {
    const when = new Date('2027-04-01T12:00:00Z');
    const records = [P.festival, { '@type': 'Plumber', name: 'Boiler Brothers' }, P.sideRoom, P.rescheduled, P.supper, S.festival];
    const cards = records.map((r) => (archetype(r) === 'happening' ? card(r, at(-360), when) : { title: String((r as Obj).name), past: false }));
    const order = arrangeEvents(records, (r) => (archetype(r) === 'happening' ? (cards[records.indexOf(r)] as EventCard) : undefined)).map((i) => {
      const c = cards[i] as EventCard;
      return c.title + (c.past ? ' (past)' : '');
    });
    expect(order).toEqual([
      'Low Light Savannah: The Tide Clock', 'Boiler Brothers', 'Field Days Denver', 'Field Days Denver',
      'Night Table Savannah: Low Country, High Tide (past)', 'Side Room Austin: Tamsin Roe (past)',
    ]);
  });

  it('the A2UI surface draws a lone event as its card, and several as rows', () => {
    const one = emitResultsSurface('nxis_query', [P.conference])[0] as { createSurface: { dataModel: Obj } };
    const dm = one.createSurface.dataModel;
    expect(dm.title).toBe('Open Signal Denver');
    expect((dm.parts as unknown[]).length).toBe(3);
    expect(dm.more).toEqual([{ label: 'Show all 10' }]);
    expect(((dm.all as Obj).parts as unknown[]).length).toBe(10);
    const many = emitResultsSurface('nxis_query', [P.festival, P.supper, P.rescheduled])[0] as { createSurface: { dataModel: { events: Obj[] } } };
    expect(many.createSurface.dataModel.events.map((e) => e.title)).toEqual(['Night Table Savannah: Low Country, High Tide', 'Low Light Savannah: The Tide Clock', 'Field Days Denver']);
    expect(many.createSurface.dataModel.events[0].closed).toEqual([{ label: 'Sold out' }]);
    expect(many.createSurface.dataModel.events[0].lead).toEqual([]);
  });
});

describe('visitor-facing words', () => {
  it('hold no issue references', () => {
    const text = JSON.stringify([RENDERER_SPEC.happening, ...Object.values(P).map((r) => card(r)), ...Object.values(S).map((r) => card(r))]);
    expect(text).not.toMatch(/#\d{2,}|nxisai\//);
  });
});
