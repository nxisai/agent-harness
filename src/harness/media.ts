/**
 * Podcast episodes and series as the cards draw them: an episode as a row, a series as a card with its parts.
 *
 * The NxisAI app's rules (the "Podcast" board), read from the
 * same renderer spec. Every value comes from the record: a row says what it is ("Lantern Hours · Episode 2 ·
 * 0:10 · Free") and carries its lead button, always on show; a series says who makes it and how many parts it has,
 * its badge is said from its parts, and it leads with the latest free episode.
 *
 * Renderer-free: the answer view (`ui/result-pick.ts`) and the A2UI surface (`a2ui/cards.ts`) draw from these.
 *
 * @module
 */
import { access, accessAction, archetype, entityLabel, nameOf, runtime, SPEC, subtitle, type AccessState } from './entity.js';
import { mediaCtas, seriesAccess, seriesCtas, seriesParts, type CardCtas } from './cta.js';

type Obj = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** An episode (any media item) as a row. */
export interface MediaRow {
  title: string;
  /** The show it is part of, by name. */
  series?: string;
  episode?: number;
  /** "0:10", from its ISO 8601 duration. */
  duration?: string;
  /** Its access in the row's words: "Free", "Preview", "Subscribers", "Free with sign-up", "$5". */
  access?: { state: AccessState; label: string };
  /** Its lead, always on show, and the button beside it, shown when the row opens. */
  ctas?: CardCtas;
  /** What there is to read when the row opens. */
  description?: string;
  published?: string;
}

/** A series with its parts. */
export interface SeriesCard {
  title: string;
  /** "Podcast · Brackwater Audio · 12 episodes". */
  subtitle?: string;
  /** Said from the parts: "Free", "Free · some for subscribers", "Subscribers". */
  badge?: { state: 'free' | 'mixed' | 'subscription'; label: string };
  /** "Listen to the latest" · Subscribe, or "Subscribe to listen" · Their page. */
  ctas?: CardCtas;
  parts: MediaRow[];
  /** The show's art: an https image only. */
  art?: string;
  /** The latest free episode, by title: what "Listen to the latest" opens. */
  latest?: string;
}

/** A record's access in a part row's words. */
function rowAccess(record: Obj): MediaRow['access'] {
  const acc = access(record, accessAction(record));
  if (!acc) return undefined;
  return { state: acc.state, label: acc.state === 'purchase' ? acc.label : SPEC.partAccess[acc.state] };
}

/** One media item as a row. */
export function mediaRow(record: Obj): MediaRow {
  const acc = access(record, accessAction(record));
  const description = str(record.description);
  const series = nameOf(record.partOfSeries);
  const episode = num(record.episodeNumber);
  const duration = runtime(record);
  const published = str(record.datePublished);
  const ctas = mediaCtas(record, acc, 'media');
  const shown = rowAccess(record);
  return {
    title: entityLabel(record),
    ...(series ? { series } : {}),
    ...(episode !== undefined ? { episode } : {}),
    ...(duration ? { duration } : {}),
    ...(shown ? { access: shown } : {}),
    ...(ctas ? { ctas } : {}),
    ...(description ? { description: description.length > 160 ? description.slice(0, 157).trimEnd() + '…' : description } : {}),
    ...(published ? { published } : {}),
  };
}

/**
 * A row's second line, without its access (drawn after it, in its colour): "Lantern Hours · Episode 2 · 0:10".
 *
 * @param opts.withSeries - Name the show; left out under a heading that already does.
 * @param opts.inSeries - In a series' own card: no show and no "Episode N", as the board draws it ("0:10").
 */
export function mediaLine(row: MediaRow, opts: { withSeries?: boolean; inSeries?: boolean } = {}): string {
  const withSeries = opts.withSeries ?? !opts.inSeries;
  return [withSeries ? row.series : undefined, row.episode !== undefined && !opts.inSeries ? `Episode ${row.episode}` : undefined, row.duration]
    .filter(Boolean)
    .join(' · ');
}

/** The whole second line as text: "Lantern Hours · Episode 2 · 0:10 · Free". */
export function mediaLineText(row: MediaRow, opts: { withSeries?: boolean; inSeries?: boolean } = {}): string {
  return [mediaLine(row, opts), row.access?.label].filter(Boolean).join(' · ');
}

/** A series as its card, or undefined when it lists no parts: then it draws as any other card, with its own Listen
 * and Subscribe. */
export function seriesCard(record: Obj): SeriesCard | undefined {
  if (archetype(record) !== 'series') return undefined;
  const parts = seriesParts(record);
  if (!parts.length) return undefined;
  const rows = parts.map(mediaRow);
  const ctas = seriesCtas(record);
  const badge = seriesAccess(parts);
  const line = subtitle(record, 'series');
  const art = [first(record.image)]
    .map((i) => str(i && typeof i === 'object' ? (i as Obj).url ?? (i as Obj).contentUrl : i))
    .find((u) => u && /^https:\/\//i.test(u));
  // What "Listen to the latest" opens, by the row whose Listen it is.
  const latest = ctas?.lead.kind === 'open' && ctas.lead.actionType === 'ListenAction'
    ? rows.find((r) => r.ctas?.lead.kind === 'open' && r.ctas.lead.url === (ctas.lead as { url: string }).url)?.title
    : undefined;
  return {
    title: entityLabel(record),
    ...(line ? { subtitle: line } : {}),
    ...(badge ? { badge } : {}),
    ...(ctas ? { ctas } : {}),
    parts: rows,
    ...(art ? { art } : {}),
    ...(latest ? { latest } : {}),
  };
}

/** How many of a series' parts show before "Show all episodes", as the board draws it. */
export const SERIES_PARTS_SHOWN = 3;

/**
 * Episodes from more than one show, grouped by show under a heading ("Lantern Hours · 2"), in the order each show
 * first came; the row then leaves the show out, since the heading says it. Episodes from one show stay one list, with
 * no heading.
 */
/**
 * For a results list: whether its episodes span more than one show, and each show's heading ("Lantern Hours · 2")
 * keyed by show. A list with no episodes at all (businesses, or a lone series) has none, and isn't grouped.
 */
export function seriesHeadings(episodeSeries: (string | undefined)[]): { bySeries: boolean; counts: Map<string, string | undefined> } {
  const shows = groupBySeries(episodeSeries.map((series) => ({ series })));
  return {
    bySeries: shows.length > 1,
    counts: new Map(shows.filter((g) => g.rows.length).map((g) => [g.rows[0].series ?? 'Other episodes', g.heading]))
  };
}

export function groupBySeries<T extends { series?: string }>(rows: T[]): { heading?: string; rows: T[] }[] {
  const shows = [...new Set(rows.map((r) => r.series ?? 'Other episodes'))];
  if (shows.length < 2) return [{ rows }];
  return shows.map((s) => {
    const mine = rows.filter((r) => (r.series ?? 'Other episodes') === s);
    return { heading: `${s} · ${mine.length}`, rows: mine };
  });
}
