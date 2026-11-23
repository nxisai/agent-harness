/**
 * The records a read tool returned, and what each one says as plain facts.
 *
 * A typed-retrieval result reaches the harness in many wrappings: structured
 * content, JSON text, or the whole response serialized again by an extension
 * in the loop. {@link extractRecords} digs the record list out of any of them.
 * {@link recordFacts} then reads one schema.org record into the facts a
 * person compares businesses by: whether it is open now, its rating, what it
 * does, what reviewers said. Those facts are what a recommendation may cite,
 * and nothing else.
 *
 * @module
 */
import type { ModelContextToolResponse } from '../types.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The records in a read tool's response, wherever they are.
 *
 * @param res - The response, or its text.
 * @returns The records, as the server sent them; empty when there are none.
 */
export function extractRecords(res: ModelContextToolResponse | string | null | undefined): Obj[] {
  const sources: unknown[] = [];
  // Every candidate payload, unwrapping response envelopes: structured
  // content and each text part, parsed as JSON, possibly encoded twice.
  const visit = (raw: unknown, depth = 0): void => {
    if (raw == null || depth > 5) return;
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (!t) return;
      try {
        visit(JSON.parse(t), depth + 1);
      } catch {
        // Plain text: nothing to extract.
      }
      return;
    }
    if (typeof raw !== 'object') return;
    sources.push(raw);
    const v = raw as Obj;
    if (v.structuredContent != null) visit(v.structuredContent, depth + 1);
    if (Array.isArray(v.content)) {
      for (const c of v.content) if (isObj(c)) visit(c.text, depth + 1);
    }
  };
  visit(res);
  for (const data of sources) {
    const items = itemsFrom(data);
    if (items.length) return items;
  }
  return [];
}

/** The record array within one parsed payload. */
function itemsFrom(data: unknown): Obj[] {
  const objs = (arr: unknown[]) => arr.filter(isObj);
  if (Array.isArray(data)) return objs(data);
  if (!isObj(data)) return [];
  for (const key of ['results', 'types', 'items', 'entities', 'data']) {
    if (Array.isArray(data[key])) return objs(data[key] as unknown[]);
  }
  if (isObj(data.result)) return [data.result];
  if (data['@id'] != null || data['@type'] != null || data.name != null) return [data];
  return [];
}

// ── Opening hours ───────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT: Record<string, number> = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };

/** Minutes after midnight: "07:30" → 450. */
function minutes(hhmm: unknown): number | null {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "7am", "5:30pm", "noon". */
function clock(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  if (h === 12 && m === 0) return 'noon';
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

/** Each day's opening spans, [opens, closes] in minutes; index 0 is Sunday. */
function weekOf(entity: Obj): [number, number][][] | null {
  const week: [number, number][][] = DAYS.map(() => []);
  let any = false;
  const spec = entity.openingHoursSpecification;
  for (const s of Array.isArray(spec) ? spec : spec ? [spec] : []) {
    if (!isObj(s)) continue;
    const opens = minutes(s.opens);
    const closes = minutes(s.closes);
    if (opens === null || closes === null) continue;
    const days = Array.isArray(s.dayOfWeek) ? s.dayOfWeek : [s.dayOfWeek];
    for (const d of days) {
      const i = DAYS.findIndex((name) => String(d ?? '').replace(/^.*[/#]/, '').toLowerCase() === name.toLowerCase());
      if (i >= 0) {
        week[i].push([opens, closes]);
        any = true;
      }
    }
  }
  // The compact form: "Mo-Fr 07:00-17:00", "Sa 08:00-13:00", "Mo-Su 00:00-23:59".
  const compact = entity.openingHours;
  for (const line of Array.isArray(compact) ? compact : compact ? String(compact).split(/[;,](?=\s*[A-Z][a-z])/) : []) {
    const m = String(line).trim().match(/^([A-Za-z]{2})(?:-([A-Za-z]{2}))?\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!m) continue;
    const from = SHORT[m[1].toLowerCase()];
    const to = m[2] ? SHORT[m[2].toLowerCase()] : from;
    if (from === undefined || to === undefined) continue;
    for (let d = from; ; d = (d + 1) % 7) {
      week[d].push([minutes(m[3])!, minutes(m[4])!]);
      any = true;
      if (d === to) break;
    }
  }
  return any ? week : null;
}

/** Whether a business is open at a time, and how a visitor should read it. */
export interface OpenStatus {
  open: boolean;
  /** "Open now · 24/7", "Open now · until 5pm", "Opens 7am", "Opens Mon 7am". */
  label: string;
  /** Open every hour of every day. */
  always: boolean;
}

/**
 * Whether a record's business is open at `now`, read from its opening hours.
 *
 * @returns Null when the record states no hours this can read.
 */
export function openStatus(entity: Obj, now: Date = new Date()): OpenStatus | null {
  const week = weekOf(entity);
  if (!week) return null;
  const always = week.every((spans) => spans.some(([o, c]) => o === 0 && c >= 23 * 60 + 59));
  if (always) return { open: true, label: 'Open now · 24/7', always: true };
  const day = now.getDay();
  const at = now.getHours() * 60 + now.getMinutes();
  const current = week[day].find(([o, c]) => at >= o && at < c);
  if (current) return { open: true, label: `Open now · until ${clock(current[1])}`, always: false };
  // The next opening, today later or on a following day.
  for (let ahead = 0; ahead < 7; ahead++) {
    const d = (day + ahead) % 7;
    const next = week[d].filter(([o]) => ahead > 0 || o > at).sort((a, b) => a[0] - b[0])[0];
    if (!next) continue;
    // Today or tomorrow reads as a time alone; further off, with the day.
    return { open: false, label: ahead <= 1 ? `Opens ${clock(next[0])}` : `Opens ${DAYS[d].slice(0, 3)} ${clock(next[0])}`, always: false };
  }
  return { open: false, label: 'Closed', always: false };
}

// ── Facts ───────────────────────────────────────────────────────────────────

/** One record, as the facts a visitor compares by. */
export interface RecordFacts {
  /** Its `@id`, else its name: what a pick refers to. */
  key: string;
  name: string;
  type?: string;
  status?: OpenStatus;
  rating?: number;
  reviewCount?: number;
  phone?: string;
  /** Services it offers, by name, with their one-line descriptions. */
  services: { name: string; description?: string }[];
  /** What it says it specializes in. */
  knows: string[];
  description?: string;
  /** What reviewers wrote, with who wrote it. */
  reviews: { text: string; author?: string }[];
  /** The year it was founded. */
  since?: number;
  /** ZIP codes or places it serves. */
  area: string[];
}

const str = (v: unknown): string => (v == null ? '' : String(Array.isArray(v) ? v[0] : v)).trim();
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** A schema.org record as plain facts. */
export function recordFacts(entity: Obj, now: Date = new Date()): RecordFacts {
  const name = str(entity.name ?? entity.title ?? entity.headline) || 'This result';
  const rating = isObj(entity.aggregateRating) ? Number(entity.aggregateRating.ratingValue) : NaN;
  const count = isObj(entity.aggregateRating) ? Number(entity.aggregateRating.reviewCount ?? entity.aggregateRating.ratingCount) : NaN;
  const services = list(entity.makesOffer)
    .map((o) => (isObj(o) && isObj(o.itemOffered) ? o.itemOffered : isObj(o) ? o : null))
    .filter(isObj)
    .map((s) => ({ name: str(s.name), description: str(s.description) || undefined }))
    .filter((s) => s.name);
  const reviews = list(entity.review)
    .filter(isObj)
    .map((r) => ({ text: str(r.reviewBody ?? r.description), author: isObj(r.author) ? str(r.author.name) || undefined : str(r.author) || undefined }))
    .filter((r) => r.text);
  const founded = str(entity.foundingDate).match(/^(\d{4})/);
  const status = openStatus(entity, now) ?? undefined;
  return {
    key: str(entity['@id']) || name,
    name,
    type: str(entity['@type']).replace(/^.*[/#]/, '') || undefined,
    ...(status ? { status } : {}),
    ...(Number.isFinite(rating) ? { rating } : {}),
    ...(Number.isFinite(count) ? { reviewCount: count } : {}),
    ...(str(entity.telephone) ? { phone: str(entity.telephone) } : {}),
    services,
    knows: list(entity.knowsAbout).map(str).filter(Boolean),
    ...(str(entity.description) ? { description: str(entity.description) } : {}),
    reviews,
    ...(founded ? { since: Number(founded[1]) } : {}),
    area: list(entity.areaServed).map((a) => (isObj(a) ? str(a.name ?? a.postalCode) : str(a))).filter(Boolean),
  };
}

/** The facts as lines a model reads, and a recommendation is checked against. */
export function factLines(f: RecordFacts): string[] {
  const lines: string[] = [];
  if (f.type) lines.push(f.type);
  if (f.status) lines.push(f.status.label);
  if (f.rating !== undefined) lines.push(`Rated ${f.rating}${f.reviewCount !== undefined ? ` from ${f.reviewCount} reviews` : ''}`);
  if (f.since) lines.push(`In business since ${f.since}`);
  if (f.services.length) lines.push(`Services: ${f.services.map((s) => (s.description ? `${s.name} (${s.description})` : s.name)).join('; ')}`);
  if (f.knows.length) lines.push(`Specializes in: ${f.knows.join(', ')}`);
  if (f.description) lines.push(f.description);
  for (const r of f.reviews.slice(0, 2)) lines.push(`Review: "${r.text}"${r.author ? ` (${r.author})` : ''}`);
  if (f.area.length) lines.push(`Serves: ${f.area.join(', ')}`);
  if (f.phone) lines.push(`Phone: ${f.phone}`);
  return lines;
}
