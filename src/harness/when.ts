/**
 * Dates a visitor names ("this weekend", "tonight", "in July"), as a range of time, and whether a dated record falls
 * in one.
 *
 * The site's records hold an event's `startDate` and `endDate`, and its search compares only numbers, so a range is
 * applied here, to what the search returned. A phrase is read on the visitor's own clock: a small model can name the
 * weekend far more reliably than it can work out which dates it covers.
 *
 * @module
 */

import type { CallResult } from './tools/bridge.js';

/** A span of time, both ends inclusive, in epoch milliseconds. */
export interface DateRange {
  from: number;
  to: number;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const endOf = (d: Date): number => addDays(d, 1).getTime() - 1;

/**
 * A date as the visitor means it: a bare day (`2026-07-04`) is that day on their clock, not midnight in London.
 *
 * @returns Epoch milliseconds, or NaN when it isn't a date.
 */
export function parseWhen(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const day = ISO_DAY.exec(value.trim());
  return day ? new Date(+day[1], +day[2] - 1, +day[3]).getTime() : Date.parse(value);
}

/** A phrase with its small words and punctuation taken out: "on the weekend" is "weekend". */
const plain = (phrase: string): string =>
  phrase.toLowerCase().replace(/[^a-z0-9-]+/g, ' ').replace(/\b(?:in|on|the|for|during|of)\b/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The range a phrase names, on the visitor's clock.
 *
 * Understood: today, tonight, tomorrow, this weekend, next weekend, this week, next week, this month, next month, a
 * month by name ("July", "in July": the next one that has not ended), and a day as `YYYY-MM-DD`.
 *
 * @param phrase - What the visitor said, or the model passed on.
 * @param now - The visitor's clock.
 * @returns The range, or null for a phrase this doesn't know.
 */
export function rangeFor(phrase: string, now: Date = new Date()): DateRange | null {
  const p = plain(phrase);
  const today = startOfDay(now);
  const span = (from: Date | number, to: Date): DateRange => ({ from: typeof from === 'number' ? from : from.getTime(), to: endOf(to) });

  if (ISO_DAY.test(p)) {
    const d = new Date(parseWhen(p));
    return span(d, d);
  }
  if (p === 'today') return span(today, today);
  if (p === 'tonight' || p === 'this evening') return span(Math.max(now.getTime(), new Date(today).setHours(17)), today);
  if (p === 'tomorrow') return span(addDays(today, 1), addDays(today, 1));

  // Weeks run Monday to Sunday; a weekend is Friday evening to Sunday night.
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const sunday = addDays(monday, 6);
  if (p === 'this weekend' || p === 'weekend') {
    // Once it has begun, what is left of it.
    return span(Math.max(now.getTime(), new Date(addDays(monday, 4)).setHours(17)), sunday);
  }
  if (p === 'next weekend') return span(new Date(addDays(monday, 11)).setHours(17), addDays(sunday, 7));
  if (p === 'this week') return span(today, sunday);
  if (p === 'next week') return span(addDays(sunday, 1), addDays(sunday, 7));
  if (p === 'this month') return span(today, new Date(today.getFullYear(), today.getMonth() + 1, 0));
  if (p === 'next month') return span(new Date(today.getFullYear(), today.getMonth() + 1, 1), new Date(today.getFullYear(), today.getMonth() + 2, 0));

  const month = MONTHS.findIndex((m) => p === m || (m.length > 3 && p === m.slice(0, 3)));
  if (month >= 0) {
    // This year's, unless it has already ended.
    const year = month < today.getMonth() ? today.getFullYear() + 1 : today.getFullYear();
    const first = new Date(year, month, 1);
    return span(month === today.getMonth() ? today : first, new Date(year, month + 1, 0));
  }
  return null;
}

/**
 * The range a query asks for: a phrase (`when`), or days from and to (`from`, `to`, either may be left open).
 *
 * @returns The range, or null when the query asks for none or names one this can't read.
 */
export function queryRange(input: Record<string, unknown>, now: Date = new Date()): DateRange | null {
  const when = typeof input.when === 'string' ? input.when.trim() : '';
  if (when) {
    const named = rangeFor(when, now);
    if (named) return named;
  }
  const from = parseWhen(input.from);
  const toStart = parseWhen(input.to);
  if (Number.isNaN(from) && Number.isNaN(toStart)) return null;
  // A bare day for `to` means all of that day.
  const to = Number.isNaN(toStart) ? Infinity : ISO_DAY.test(String(input.to).trim()) ? endOf(new Date(toStart)) : toStart;
  return { from: Number.isNaN(from) ? -Infinity : from, to };
}

type Obj = Record<string, unknown>;
const field = (o: Obj, key: string): unknown => {
  const v = o[key] ?? o[`https://schema.org/${key}`];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Whether a dated record is on during a range: it starts before the range ends, and ends (or, with no end, starts)
 * after it begins. An exhibition that opened last week is still on this weekend.
 *
 * @param record - A record with a `startDate`, and perhaps an `endDate`.
 * @returns False for a record with no start date it can read.
 */
export function onDuring(record: unknown, range: DateRange): boolean {
  if (!record || typeof record !== 'object') return false;
  const o = record as Obj;
  const startRaw = field(o, 'startDate');
  const start = parseWhen(startRaw);
  if (Number.isNaN(start)) return false;
  const endRaw = field(o, 'endDate');
  let end = parseWhen(endRaw);
  if (Number.isNaN(end)) end = start;
  // A bare day lasts all day.
  const raw = Number.isNaN(parseWhen(endRaw)) ? startRaw : endRaw;
  if (typeof raw === 'string' && ISO_DAY.test(raw.trim())) end = endOf(new Date(end));
  return start <= range.to && end >= range.from;
}

/** How many pages of records a dated search reads at most: each one counts against the site's rate limit. */
const DATED_PAGES = 3;

/** A result's JSON body, structured or as text. */
function bodyOf(res: CallResult): Record<string, unknown> | null {
  if (res.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent as Record<string, unknown>;
  const text = (Array.isArray(res.content) ? res.content : []).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('');
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const day = (ms: number): string => {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A day in words, with its year only when it isn't this one: `Saturday, November 21`. */
const dayWords = (ms: number, now: Date, weekday = false): string => {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', {
    ...(weekday ? { weekday: 'long' } : {}),
    month: 'long',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
};

/**
 * The time a query asked for, in words that follow "Nothing's on": `this weekend`, `in July`,
 * `Saturday, November 21`, `between November 21 and November 30`.
 */
export function rangeWords(input: Record<string, unknown>, range: DateRange, now: Date = new Date()): string {
  const when = typeof input.when === 'string' ? input.when : '';
  if (when && rangeFor(when, now)) {
    const p = plain(when);
    if (ISO_DAY.test(p)) return dayWords(range.from, now, true);
    const month = MONTHS.findIndex((m) => p === m || p === m.slice(0, 3));
    if (month >= 0) return `in ${MONTHS[month][0].toUpperCase()}${MONTHS[month].slice(1)}`;
    return p === 'weekend' ? 'this weekend' : p;
  }
  const from = Number.isFinite(range.from), to = Number.isFinite(range.to);
  if (from && to && day(range.from) === day(range.to)) return dayWords(range.from, now, true);
  if (from && to) return `between ${dayWords(range.from, now)} and ${dayWords(range.to, now)}`;
  return from ? `from ${dayWords(range.from, now)} on` : `through ${dayWords(range.to, now)}`;
}

/** How many of the next records a search that found nothing in its time shows instead. */
const NEXT = 5;

/**
 * A search for records on during a time: "what's on this weekend".
 *
 * The server compares only numbers, and dates are text, so the range is applied here. Records are read soonest first,
 * a page at a time, until a page starts after the range or enough are found.
 *
 * When nothing is on then, it says so (`notice`, first, so it leads what the model reads) and searches again from now
 * on, soonest first, returning the next few marked `upcoming`. With nothing coming up either, it says that and offers
 * past records or everything the site lists. It never comes back empty without a word.
 */
export async function datedQuery(
  input: Record<string, unknown>,
  call: (args: Record<string, unknown>) => Promise<CallResult>,
  mapArgs: (input: Record<string, unknown>) => Record<string, unknown>,
): Promise<CallResult> {
  const range = queryRange(input);
  if (!range) return call(mapArgs(input));
  const want = Math.min(Math.max(Number(input.limit) || 10, 1), 100);
  const sorted = input.sort == null || String(input.sort).trim() === '';

  // Reads soonest first (or in the order asked), keeping what is on during `within`.
  const collect = async (within: DateRange, max: number, soonest: boolean) => {
    const args = mapArgs({ ...input, sort: soonest ? 'startDate' : input.sort, limit: 100 });
    const found: unknown[] = [];
    let body: Record<string, unknown> | null = null;
    let token: unknown;
    for (let page = 0; page < DATED_PAGES; page++) {
      const res = await call(token ? { ...args, page_token: token } : args);
      body = bodyOf(res);
      if (res.isError || !body) return { res };
      const results = Array.isArray(body.results) ? body.results : [];
      found.push(...results.filter((r) => onDuring(r, within)));
      token = body.next_page_token;
      const last = results[results.length - 1] as Record<string, unknown> | undefined;
      if (!token || found.length >= max || (soonest && parseWhen(last?.startDate) > within.to)) break;
    }
    return { body, results: found.slice(0, max) };
  };

  const first = await collect(range, want, sorted);
  if (!first.results) return first.res;
  const said = {
    // Said back, so the model words the answer for the days it searched.
    date_range: [day(range.from), day(range.to)].filter(Boolean).join(' to '),
  };
  let out: Record<string, unknown> = { ...first.body, results: first.results, total: first.results.length, next_page_token: null, ...said };

  if (!first.results.length) {
    const now = new Date();
    const events = /event|festival/i.test(String(input.schema_type ?? 'event'));
    const what = events ? 'events' : 'ones';
    const nothing = `Nothing's on ${rangeWords(input, range, now)}`;
    // A range that already runs from now on has nothing further to find.
    const ahead = range.to === Infinity && range.from <= now.getTime() ? null : await collect({ from: now.getTime(), to: Infinity }, NEXT, true);
    const next = ahead?.results;
    out = next?.length
      ? {
          notice: `${nothing}. The next ${next.length === 1 ? what.slice(0, -1) + ' is' : what + ' are'}:`,
          ...ahead!.body,
          results: next,
          total: next.length,
          next_page_token: null,
          upcoming: true,
          ...said,
        }
      : {
          notice: ahead && !next
            ? `${nothing}.`
            : `${nothing}, and there are no upcoming ${what}. I can show past ${what}, or everything the site lists.`,
          ...out,
          upcoming: false,
        };
  }
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
}
