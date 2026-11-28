/**
 * The business's opening hours as its owner keeps them, from the model proxy's policy copy (`openingHours`): its time
 * zone, the open ranges per weekday, and dates it is closed. When a site's proxy sends them, the results card's open
 * status for the business's own records reads them rather than each record's hours, in the business's time zone
 * rather than the visitor's. An emergency service keeps its own round-the-clock hours.
 *
 * @module
 */
import { clock, type OpenStatus } from './records.js';

/** Open ranges per weekday ("HH:MM" to "HH:MM", the business's local time), its zone, and dates it is closed. */
export interface OpeningHours {
  /** IANA: "America/Chicago". */
  timeZone: string;
  /** `{ mon: [['07:00', '18:00']] }`. A day not listed is closed. */
  weekly: Partial<Record<Day, [string, string][]>>;
  /** Dates closed, YYYY-MM-DD in its zone. */
  closed?: string[];
}

type Day = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
const DAYS: Day[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** The copy's `openingHours`, read strictly; null when absent or not of this shape. */
export function readOpeningHours(v: unknown): OpeningHours | null {
  const h = v as OpeningHours;
  try {
    new Intl.DateTimeFormat('en', { timeZone: h.timeZone });
    const days = Object.entries(h.weekly);
    if (
      days.length &&
      days.every(([d, r]) => DAYS.includes(d as Day) && r!.every(([a, b]) => HHMM.test(a) && HHMM.test(b) && a < b)) &&
      (h.closed ?? []).every((d) => typeof d == 'string')
    )
      return h;
  } catch {
    // Not of this shape.
  }
  return null;
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The wall clock in a zone: its date, weekday and minute of the day. */
function wall(now: Date, timeZone: string): { date: string; day: number; at: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, day: SHORT.indexOf(p.weekday), at: Number(p.hour) * 60 + Number(p.minute) };
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Open or not at `now` by these hours, in their zone: "Open now · until 6pm", "Opens 7am", "Opens Mon 7am". */
export function hoursStatus(h: OpeningHours, now: Date = new Date()): OpenStatus {
  const w = wall(now, h.timeZone);
  const spans = (d: number, date: string) => (h.closed?.includes(date) ? [] : (h.weekly[DAYS[d]] ?? []).map(([a, b]) => [mins(a), mins(b)] as [number, number]));
  const current = spans(w.day, w.date).find(([o, c]) => w.at >= o && w.at < c);
  if (current) return { open: true, label: `Open now · until ${clock(current[1])}`, always: false };
  for (let ahead = 0; ahead < 8; ahead++) {
    const d = (w.day + ahead) % 7;
    const next = spans(d, addDays(w.date, ahead))
      .filter(([o]) => ahead > 0 || o > w.at)
      .sort((a, b) => a[0] - b[0])[0];
    if (next) return { open: false, label: ahead <= 1 ? `Opens ${clock(next[0])}` : `Opens ${SHORT[d]} ${clock(next[0])}`, always: false };
  }
  return { open: false, label: 'Closed', always: false };
}

/** An emergency service's record (by its type or name): it keeps its own hours. */
export function isEmergencyRecord(entity: Record<string, unknown>): boolean {
  const types = [entity['@type']].flat().map((t) => String(t ?? '').replace(/^.*[/#]/, ''));
  return types.includes('EmergencyService') || /\b(emergency|24[- ]hour)\b/i.test(String(entity.name ?? ''));
}
