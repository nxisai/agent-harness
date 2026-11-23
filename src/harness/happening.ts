/**
 * Events as the cards draw them: when and where, what a ticket costs and whether any are left, and how to get one.
 *
 * The NxisAI app's rules (the Hub widget's `happeningCard`, `eventAccess` and `arrange`), read from the same renderer
 * spec and worded by its `happening` block. Every value comes from the record: a record that gives no dates, place or
 * offers shows none, and one with no offers is never "Free".
 *
 * Renderer-free, like `media.ts`: the answer view (`ui/event-cards.ts`) and the A2UI surface (`a2ui/events.ts`) draw
 * from these. Both load on demand, with the first event a result holds.
 *
 * @module
 */
import { entityLabel, nameOf, prop, readableType, SPEC, typesOf, type AccessState } from './entity.js';
import { targetUrl } from './cta.js';
import { RENDERER_SPEC } from './renderer-spec.js';

type Obj = Record<string, unknown>;

/** The words an event card uses: kinds, statuses, access and buttons. */
export const HAPPENING = RENDERER_SPEC.happening;
const HP = HAPPENING;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const short = (t: unknown): string => (typeof t === 'string' ? t.replace(/^(?:https?:\/\/schema\.org\/|schema:)/, '') : '');
/** An nxis extension property, by compact term or expanded IRI. */
const nx = (o: unknown, key: string): unknown => (isObj(o) ? o[`nxis:${key}`] ?? o[`https://nxis.ai/ns#${key}`] : undefined);
const yes = (v: unknown) => v === true || v === 'true' || v === 'True';
const fill = (s: string, vars: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
const pad2 = (n: number) => String(n).padStart(2, '0');
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/** What drawing an event needs beyond the record. */
export interface EventOptions {
  /** The moment the card is drawn for: what is past, and what is on sale. Now by default. */
  now?: Date;
  /** Where the site's MCP server builds calendar files (`…/ics/`), for an event that names no file of its own. */
  calendar?: string;
  /** Minutes east of UTC where the visitor is, at an instant. The browser's by default. */
  visitorOffset?: (at: number) => number;
}

/** A Date or DateTime as written: its wall clock in the event's own zone, the zone's offset when it names one, and
 * the instant it is. */
interface When {
  y: number;
  mo: number;
  d: number;
  hh: number;
  mi: number;
  hasTime: boolean;
  /** Minutes east of UTC; none for a time that names no zone. */
  offset?: number;
  at: number;
  wall: number;
}

/**
 * A schema.org Date or DateTime: a time with no offset is the visitor's local time; anything else (prose a page left
 * in a date field) is undefined, so nothing is shown.
 */
function when(v: unknown): When | undefined {
  const m = ISO.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const hasTime = m[4] !== undefined;
  const hh = hasTime ? Number(m[4]) : 0;
  const mi = hasTime ? Number(m[5]) : 0;
  const ss = Number(m[6] || 0);
  let offset: number | undefined;
  if (m[7]) {
    const z = m[7].replace(':', '');
    offset = /^z$/i.test(z) ? 0 : (z[0] === '-' ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5) || 0));
  }
  const wall = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const at = offset !== undefined ? wall - offset * 60000 : new Date(y, mo - 1, d, hh, mi, ss).getTime();
  return Number.isFinite(at) ? { y, mo, d, hh, mi, hasTime, offset, at, wall } : undefined;
}

const dateOf = (record: unknown, key: string) => when(str(first(prop(record, key))));
const sameDay = (a: When, b: When) => a.y === b.y && a.mo === b.mo && a.d === b.d;
const dayText = (t: When, withYear: boolean) => `${WD[new Date(t.wall).getUTCDay()]} ${MON[t.mo - 1]} ${t.d}${withYear ? `, ${t.y}` : ''}`;
const clockOf = (t: When) => ({ text: `${t.hh % 12 || 12}${t.mi ? ':' + pad2(t.mi) : ''}`, half: t.hh < 12 ? 'am' : 'pm' });

/** "6–10 pm", "11 am – 1 pm", "8:30 am". */
function hours(a: When, b?: When): string {
  const x = clockOf(a);
  if (!b) return `${x.text} ${x.half}`;
  const y = clockOf(b);
  return x.half === y.half ? `${x.text}–${y.text} ${y.half}` : `${x.text} ${x.half} – ${y.text} ${y.half}`;
}

const visitorOffset = (at: number, opts: EventOptions) => (opts.visitorOffset ? opts.visitorOffset(at) : -new Date(at).getTimezoneOffset());

/**
 * The event's zone, named only when it differs from the visitor's at that moment: by the record's own schedule zone
 * when it gives one ("EDT"), else by its offset ("UTC−4"). A time with no offset has no zone to name.
 */
function zoneOf(record: Obj, t: When, opts: EventOptions): string | undefined {
  if (!t.hasTime || t.offset === undefined || visitorOffset(t.at, opts) === t.offset) return undefined;
  const iana = str(prop(first(prop(record, 'eventSchedule')), 'scheduleTimezone'));
  if (iana && typeof Intl !== 'undefined') {
    try {
      const part = new Intl.DateTimeFormat('en-US', { timeZone: iana, timeZoneName: 'short' }).formatToParts(new Date(t.at)).find((p) => p.type === 'timeZoneName');
      if (part?.value) return part.value;
    } catch {
      // An unknown zone: named by its offset instead.
    }
  }
  const h = Math.floor(Math.abs(t.offset) / 60);
  const mm = Math.abs(t.offset) % 60;
  return `UTC${t.offset < 0 ? '−' : '+'}${h}${mm ? ':' + pad2(mm) : ''}`;
}

/** When an event is, as a card says it. */
export interface EventWhen {
  /** "Sat Mar 20, 7–10 pm", "Sat Jul 24 – Sun Jul 25, 2027", with the zone when it differs from the visitor's. */
  text: string;
  zone?: string;
  /** Its start and end, as instants. */
  start: number;
  end?: number;
  /** For the date tile: "Jul", 24. */
  mon: string;
  day: number;
}

/**
 * When, in one line, in the event's own time zone. The year is said when it isn't this one, and the zone with a
 * time. A part of an event (`inner`) leaves out the year, and its zone when its event's line already names it.
 */
function whenOf(record: Obj, opts: EventOptions, inner?: { zoned: boolean }): (EventWhen & { s: When; e?: When }) | undefined {
  const s = dateOf(record, 'startDate');
  if (!s) return undefined;
  const e0 = dateOf(record, 'endDate');
  const e = e0 && e0.at >= s.at ? e0 : undefined;
  const thisYear = (opts.now ?? new Date()).getFullYear();
  const showYear = !inner && (s.y !== thisYear || (!!e && e.y !== thisYear));
  // Ending in the small hours of the next day is still one night out.
  const overnight = !!e && !sameDay(s, e) && e.hasTime && e.at - s.at < 86400000 && e.hh < 6;
  const days = !!e && !sameDay(s, e) && !overnight;
  const text = days
    ? `${dayText(s, showYear && s.y !== e!.y)} – ${dayText(e!, showYear)}`
    : s.hasTime
    ? `${dayText(s, showYear)}, ${hours(s, e?.hasTime ? e : undefined)}`
    : dayText(s, showYear);
  const zone = !days && !inner?.zoned ? zoneOf(record, s, opts) : undefined;
  return { text: zone ? `${text} ${zone}` : text, ...(zone ? { zone } : {}), start: s.at, ...(e ? { end: e.at } : {}), mon: MON[s.mo - 1], day: s.d, s, e };
}

/** Over: its end has passed, or its start when it names no end (a date alone lasts the day). */
function pastOf(w: { s: When; e?: When } | undefined, now: Date): boolean {
  if (!w) return false;
  const last = w.e ?? w.s;
  return last.at + (last.hasTime ? 0 : 86400000) < now.getTime();
}

/** A name on a card, and, when the site's records hold it (it has an `@id`), what to ask to see its card. */
export interface EventRef {
  label: string;
  /** "Tell me about Railspur Pavilion". */
  prompt?: string;
}

const ref = (o: unknown, label?: string): EventRef | undefined => {
  const name = label ?? nameOf(o);
  if (!name) return undefined;
  const id = isObj(o) ? str(o['@id']) : undefined;
  return id ? { label: name, prompt: `Tell me about ${nameOf(o) ?? name}` } : { label: name };
};

const isVirtual = (l: unknown) => isObj(l) && short(first(l['@type'])) === 'VirtualLocation';
const STATUS_OF: Record<string, keyof typeof HP.status> = {
  EventCancelled: 'cancelled',
  EventPostponed: 'postponed',
  EventRescheduled: 'rescheduled',
  EventMovedOnline: 'movedOnline',
};

/**
 * Where: the venue by name and city, "Online", or both. `eventAttendanceMode` decides, and a record that doesn't say
 * is read from its locations. A venue the site holds asks for its card; Directions needs its street address.
 */
function whereOf(record: Obj, status: string | undefined) {
  const locs = list(prop(record, 'location')).filter(Boolean);
  const mode = short(String(first(prop(record, 'eventAttendanceMode')) ?? ''));
  const places = locs.filter((l) => (typeof l === 'string' ? !/^https?:\/\//i.test(l) : !isVirtual(l)));
  const movedOnline = status === 'movedOnline';
  const inPerson = !movedOnline && (/^(Offline|Mixed)EventAttendanceMode$/.test(mode) || (!mode && places.length > 0));
  const online = movedOnline || /^(Online|Mixed)EventAttendanceMode$/.test(mode) || (!mode && locs.some(isVirtual));
  const p = first(places);
  let place: (EventRef & { name?: string; address?: string; url?: string }) | undefined;
  if (inPerson && p) {
    const o: Obj = isObj(p) ? p : { name: p };
    const a = first(prop(o, 'address'));
    const addr = isObj(a) ? a : undefined;
    const city = str(prop(addr, 'addressLocality'));
    const name = str(prop(o, 'name'));
    const street = addr
      ? [str(prop(addr, 'streetAddress')), city, [str(prop(addr, 'addressRegion')), str(prop(addr, 'postalCode'))].filter(Boolean).join(' ')].filter(Boolean).join(', ')
      : str(a);
    const r = ref(o, [name, city].filter(Boolean).join(', ') || street || undefined);
    if (r) place = { ...r, name: name ?? city, address: street, url: str(prop(o, 'url')) };
  }
  const lines: EventRef[] = [...(place ? [{ label: place.label, ...(place.prompt ? { prompt: place.prompt } : {}) }] : []), ...(online ? [{ label: HP.online }] : [])];
  return { place, online, inPerson: inPerson && !!place, lines };
}

/** An event's access: free, a price or "From" the lowest, sold out, or on sale from a date. */
export interface EventAccess {
  state: AccessState | 'soldout' | 'onsale' | 'included';
  label: string;
}

const availabilityOf = (o: unknown) => short(String(first(prop(o, 'availability')) ?? ''));

function price(o: unknown): { value: number; text: string; range?: boolean } | undefined {
  const v = num(first(prop(o, 'price')));
  if (v === undefined) return undefined;
  const cur = str(prop(o, 'priceCurrency'));
  return { value: v, text: v === 0 ? SPEC.access.free : !cur || cur === 'USD' ? `$${v}` : `${v} ${cur}` };
}

/** What one offer costs: its price, else an aggregate's low price, else its price specification's. */
function offerPrice(o: unknown) {
  const own = price(o);
  if (own) return own;
  const low = prop(o, 'lowPrice');
  if (num(first(low)) !== undefined) {
    const p = price({ price: low, priceCurrency: prop(o, 'priceCurrency') });
    return p ? { ...p, range: true } : undefined;
  }
  return list(prop(o, 'priceSpecification')).map((p) => (isObj(p) ? price(p) : undefined)).find(Boolean);
}

const offersOf = (record: unknown): Obj[] => list(prop(record, 'offers')).filter(isObj);

/**
 * Whether a ticket can be had, from offers: free (a price of 0, or `isAccessibleForFree`), a price or "From" the
 * lowest, sold out (every offer SoldOut), or not on sale yet (every open offer's `validFrom` ahead). No offers is
 * unknown, never free.
 */
export function eventAccess(record: Obj, now: Date = new Date()): EventAccess | undefined {
  if (yes(prop(record, 'isAccessibleForFree'))) return { state: 'free', label: SPEC.access.free };
  const offers = offersOf(record);
  if (!offers.length) return undefined;
  const t = now.getTime();
  const opensAt = (o: unknown) => {
    const v = when(str(prop(o, 'validFrom')));
    return v && v.at > t ? v : undefined;
  };
  const unsold = offers.filter((o) => availabilityOf(o) !== 'SoldOut');
  if (!unsold.length) return { state: 'soldout', label: HP.access.soldOut };
  const open = unsold.filter((o) => !opensAt(o));
  if (!open.length) {
    const next = unsold.map(opensAt).sort((a, b) => a!.at - b!.at)[0]!;
    return { state: 'onsale', label: fill(HP.access.onSale, { date: `${MON[next.mo - 1]} ${next.d}` }) };
  }
  const prices = open.map(offerPrice).filter((p): p is NonNullable<typeof p> => !!p);
  if (!prices.length) return undefined;
  const low = prices.reduce((a, b) => (b.value < a.value ? b : a));
  if (low.value === 0) return { state: 'free', label: SPEC.access.free };
  const several = low.range || prices.some((p) => p.value !== low.value);
  return { state: 'purchase', label: several ? fill(HP.access.from, { price: low.text }) : low.text };
}

/** One of an event card's buttons. */
export interface EventButton {
  label: string;
  /**
   * - `ticket`: Get tickets or Register, reported as `outcome` when tapped;
   * - `calendar`: a calendar file, opened beside the page and reported as nothing;
   * - `directions`, `venue`, `page`: places to go;
   * - `closed`: "Sold out" or "On sale Apr 1", shown but not a button.
   */
  kind: 'ticket' | 'calendar' | 'directions' | 'venue' | 'page' | 'closed';
  /** Where a tap goes. None for `closed`. */
  url?: string;
  /** Drawn filled: the first of a card's buttons. */
  primary?: boolean;
  /** What a tap reports, with the action and the site's token when it came from one. */
  outcome?: 'purchase_start' | 'register_start' | 'page_open';
  actionType?: string;
  actionId?: string;
  reportToken?: string;
  /**
   * The site's ticket form, on its own page (`nxis:targetKind: selfPage`): opened here when it is this page, and
   * handed to there otherwise. `onPageAgent`: the form's page runs its own agent, so a page on another site can take
   * the handoff too.
   */
  form?: { pageUrl: string; actionId: string; onPageAgent?: boolean };
}

const TICKET_TYPES = ['BuyAction', 'OrderAction', 'RegisterAction', 'RsvpAction'];
/** The actions a card's funnel button asks the agent to start (cta.ts); a ticket form is none of them. */
const FUNNEL = ['QuoteAction', 'AskAction', 'ReserveAction', 'ScheduleAction', 'ApplyAction'];
const targetOf = (a: unknown) => first(prop(a, 'target'));
const pageOf = (a: unknown): string | undefined => {
  const t = targetOf(a);
  const u = isObj(t) ? str(nx(t, 'pageUrl')) : undefined;
  return u && /^https?:\/\//i.test(u) ? u : undefined;
};
const typeOfAction = (a: Obj) => short(first(a['@type']));

/**
 * Where a ticket is had. A declared BuyAction or RegisterAction first, by the page its form is on or its target;
 * then the site's own ticket form bound to the event, which runs on its page (`nxis:pageUrl`); then an offer's url.
 * A form whose page isn't known yet (it posts to the site's server, before its page is recorded) and that names no
 * target opens nothing: never the endpoint it posts to.
 */
function ticketSource(record: Obj, now: Date): { a?: Obj; type?: string; page: string; form: boolean } | undefined {
  const acts = list(prop(record, 'potentialAction')).filter(isObj);
  for (const a of acts.filter((x) => TICKET_TYPES.includes(typeOfAction(x)))) {
    const p = pageOf(a);
    const u = p ?? targetUrl(a);
    if (u) return { a, type: typeOfAction(a), page: u, form: !!p };
  }
  for (const a of acts.filter((x) => !FUNNEL.includes(typeOfAction(x)) && !(typeOfAction(x) in SPEC.actions))) {
    const p = pageOf(a);
    if (p) return { a, type: typeOfAction(a), page: p, form: true };
  }
  const t = now.getTime();
  const offer = offersOf(record)
    .filter((o) => availabilityOf(o) !== 'SoldOut')
    .map((o) => ({ u: str(first(prop(o, 'url'))), v: when(str(prop(o, 'validFrom'))) }))
    .find((x) => x.u && /^https?:\/\//i.test(x.u) && !(x.v && x.v.at > t));
  return offer ? { page: offer.u!, form: false } : undefined;
}

/**
 * The lead while tickets are on sale, worded by access: "Get tickets · From $35", "Register · Free"; and, when none can
 * be had, "Sold out" or "On sale Apr 1", shown but not a button. A tap reports the intent (`purchase_start` or
 * `register_start`) with the site's token; only the site's own confirmation counts as a conversion.
 */
function ticketButton(record: Obj, acc: EventAccess | undefined, now: Date): EventButton | undefined {
  if (acc && (acc.state === 'soldout' || acc.state === 'onsale')) return { label: acc.label, kind: 'closed' };
  const src = ticketSource(record, now);
  if (!src) return undefined;
  const t = src.type;
  const register = t === 'RegisterAction' || t === 'RsvpAction' || (acc?.state === 'free' && t !== 'BuyAction' && t !== 'OrderAction');
  const word = register ? HP.actions.register : HP.actions.tickets;
  const label = acc && (acc.state === 'free' || acc.state === 'purchase') ? `${word} · ${acc.label}` : word;
  const id = src.a ? str(src.a['@id']) : undefined;
  const token = src.a ? str(nx(src.a, 'reportToken')) : undefined;
  const onPageAgent = isObj(targetOf(src.a)) && nx(targetOf(src.a), 'onPageAgent') === true;
  return {
    label,
    kind: 'ticket',
    url: src.page,
    outcome: register ? 'register_start' : 'purchase_start',
    ...(t ? { actionType: t } : {}),
    ...(id ? { actionId: id } : {}),
    ...(id && token ? { reportToken: token } : {}),
    ...(src.form && id ? { form: { pageUrl: src.page, actionId: id, ...(onPageAgent ? { onPageAgent } : {}) } } : {}),
  };
}

/** A record's `@id` as one path segment: base64url of its UTF-8, no padding. The calendar route decodes it. */
export function recordKey(id: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(id)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isIcs = (u: string | undefined): u is string => !!u && /^https:\/\/\S+\.ics(?:[?#]\S*)?$/i.test(u);

/**
 * Add to calendar's file: the site's own when the record gives one (an `.ics` in `url` or `sameAs`, or an action's
 * target), else the one the site's MCP server builds from the record (`<calendar><base64url(@id)>.ics`), else none.
 */
export function calendarUrl(record: Obj, calendar?: string): string | undefined {
  const acts = list(prop(record, 'potentialAction')).filter(isObj);
  const own = [first(prop(record, 'url')), ...list(prop(record, 'sameAs')), ...acts.map(targetUrl)].map(str).find(isIcs);
  if (own) return own;
  const base = str(calendar);
  const id = str(record['@id']);
  return base && id && /^https?:\/\//i.test(base) ? `${base.replace(/\/?$/, '/')}${recordKey(id)}.ics` : undefined;
}

/** One of an event's parts: a festival's day, a conference's session. */
export interface EventPart {
  title: string;
  when?: string;
  access?: EventAccess;
  start?: number;
}

/** An event, as its card draws it. */
export interface EventCard {
  title: string;
  /** "Festival", "Conference", "Event". */
  kind: string;
  when?: EventWhen;
  past: boolean;
  /** Cancelled, postponed, rescheduled, moved online, or past. */
  status?: { state: string; label: string };
  access?: EventAccess;
  /** The venue and city, "Online", or both. */
  where: EventRef[];
  online: boolean;
  /** "Moved from Fri Jun 25, 2027". */
  rescheduledFrom?: string;
  organizer: EventRef[];
  performer: EventRef[];
  partOf?: EventRef;
  /** Its days or sessions, soonest first, and what they are called: "Days", "Sessions", "Schedule". */
  parts: EventPart[];
  partsLabel: string;
  /** At most three, the lead first. */
  buttons: EventButton[];
}

/** Three names, or two and "8 more". */
const names = (xs: EventRef[]) => (xs.length > 3 ? [...xs.slice(0, 2), { label: fill(HP.more, { n: xs.length - 2 }) }] : xs);

/**
 * An event as its card. Its facts lead: when, where, and its status when it isn't on as planned; who runs it and
 * who's on; its access; its parts and what it's part of. Tickets only while it is on as planned and ahead.
 */
export function eventCard(record: Obj, opts: EventOptions = {}): EventCard {
  const now = opts.now ?? new Date();
  const type = typesOf(record)[0] ?? '';
  const statusKey = STATUS_OF[short(String(first(prop(record, 'eventStatus')) ?? ''))];
  const w = whenOf(record, opts);
  const past = pastOf(w, now);
  const where = whereOf(record, statusKey);
  const prev = statusKey === 'rescheduled' ? dateOf(record, 'previousStartDate') : undefined;
  const gone = statusKey === 'cancelled' || statusKey === 'postponed';
  const acc = gone ? undefined : eventAccess(record, now);
  const status = past ? { state: 'past', label: HP.status.past } : statusKey ? { state: statusKey, label: HP.status[statusKey] } : undefined;
  const refs = (k: string) => list(prop(record, k)).map((o) => ref(o)).filter((r): r is EventRef => !!r);
  const sup = first(prop(record, 'superEvent'));
  const supName = nameOf(sup);
  const partOf = sup ? ref(sup, supName ? fill(HP.partOf, { name: supName }) : undefined) : undefined;
  const ticket = !past && (!statusKey || statusKey === 'movedOnline') ? ticketButton(record, acc, now) : undefined;
  const buttons: (EventButton & { rank: number })[] = [];
  if (ticket) buttons.push({ ...ticket, rank: 0 });
  const cal = !past && !gone && w ? calendarUrl(record, opts.calendar) : undefined;
  if (cal) buttons.push({ label: HP.actions.calendar, kind: 'calendar', url: cal, rank: 1 });
  const place = where.place;
  if (!past && !gone && place) {
    if (place.address && /\d/.test(place.address)) {
      const q = encodeURIComponent([place.name, place.address].filter(Boolean).join(', '));
      buttons.push({ label: HP.actions.directions, kind: 'directions', url: `https://www.google.com/maps/search/?api=1&query=${q}`, rank: 2 });
    } else if (place.url && /^https?:\/\//i.test(place.url)) {
      buttons.push({ label: HP.actions.venue, kind: 'venue', url: place.url, rank: 2 });
    }
  }
  const page = str(first(prop(record, 'url')));
  const bare = (u: string | undefined) => u?.split('#')[0];
  if (page && /^https?:\/\//i.test(page) && !buttons.some((b) => b.url && bare(b.url) === bare(page))) {
    buttons.push({ label: 'Their page', kind: 'page', url: page, outcome: 'page_open', rank: 3 });
  }
  // A part with no offers of its own is had with the event's pass.
  const inherited: EventAccess | undefined = acc && (acc.state === 'free' ? { state: 'free', label: SPEC.access.free } : { state: 'included', label: HP.access.included });
  const parts: EventPart[] = list(prop(record, 'subEvent'))
    .filter(isObj)
    .map((p) => {
      const pw = whenOf(p, opts, { zoned: !!w?.zone });
      const a = eventAccess(p, now) ?? inherited;
      return { title: entityLabel(p), ...(pw ? { when: pw.text, start: pw.start } : {}), ...(a ? { access: a } : {}) };
    })
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  const kinds = HP.kinds as Record<string, string>;
  const partsLabels = HP.parts as Record<string, string>;
  const kind = kinds[type] ?? (type && type !== 'Event' ? readableType(type)! : 'Event');
  return {
    title: entityLabel(record),
    kind,
    ...(w ? { when: { text: w.text, ...(w.zone ? { zone: w.zone } : {}), start: w.start, ...(w.end !== undefined ? { end: w.end } : {}), mon: w.mon, day: w.day } } : {}),
    past,
    ...(status ? { status } : {}),
    ...(acc ? { access: acc } : {}),
    where: where.lines,
    online: where.online,
    ...(prev ? { rescheduledFrom: fill(HP.rescheduledFrom, { date: dayText(prev, prev.y !== now.getFullYear()) }) } : {}),
    organizer: names(refs('organizer')),
    performer: names(refs('performer')),
    ...(partOf ? { partOf } : {}),
    parts,
    partsLabel: partsLabels[type] ?? HP.parts.default,
    buttons: buttons
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 3)
      .map(({ rank: _, ...b }, i) => ({ ...b, ...(i === 0 ? { primary: true } : {}) })),
  };
}

/** The lines under an event's name: when, the date it moved from, where, who runs it and who's on, what it's part of. */
export function eventFacts(c: EventCard, opts: { withWhen?: boolean } = {}): string[] {
  const lead = (s: string) => s.split('{names}')[0];
  const joined = (xs: EventRef[]) => xs.map((x) => x.label).join(', ');
  return [
    opts.withWhen === false ? undefined : c.when?.text,
    c.rescheduledFrom,
    c.where.length ? c.where.map((x) => x.label).join(' · ') : undefined,
    c.organizer.length ? lead(HP.by) + joined(c.organizer) : undefined,
    c.performer.length ? lead(HP.with) + joined(c.performer) : undefined,
    c.partOf?.label,
  ].filter((l): l is string => !!l);
}

/** What a card says of itself in a word: its status when it isn't on as planned, else its access. */
export const eventPill = (c: EventCard): { state: string; label: string } | undefined => c.status ?? c.access;

/** "Festival · Sat Jul 24 – Sun Jul 25, 2027 · Railspur Pavilion, Denver": what a row says under the name. */
export const eventLine = (c: EventCard): string => [c.kind, c.when?.text, c.where.map((x) => x.label).join(' · ')].filter(Boolean).join(' · ');

/** How many of an event's parts show before "Show all", as the Hub draws it. */
export const EVENT_PARTS_SHOWN = 3;

/** "Show all 10". */
export const showAllParts = (n: number): string => fill(HP.showAll, { n });

/**
 * Results in the order a list shows them: events go upcoming first, soonest first, then past ones, latest first; an
 * event with no date goes after the dated upcoming ones. Everything else keeps its place.
 *
 * @param eventOf - The event a result is, if it is one.
 * @returns The results' indices, in that order.
 */
export function arrangeEvents<T>(items: T[], eventOf: (t: T) => EventCard | undefined): number[] {
  const key = (c: EventCard) => [c.past ? 1 : 0, c.when ? 0 : 1, c.past ? -(c.when?.start ?? 0) : c.when?.start ?? 0];
  const events = items
    .map((t, i) => ({ c: eventOf(t), i }))
    .filter((x): x is { c: EventCard; i: number } => !!x.c)
    .sort((a, b) => {
      const x = key(a.c);
      const y = key(b.c);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  let n = 0;
  return items.map((t, i) => (eventOf(t) ? events[n++].i : i));
}
