/**
 * What a record is, as a card draws it: its archetype, its name, the line under the name, and whether it can
 * be had for free.
 *
 * The same rules as the NxisAI app's widgets, read from the same renderer spec
 * ({@link RENDERER_SPEC}, version 1): a schema.org type takes its nearest ancestor's archetype, and archetypes of
 * a later phase draw as Thing until they ship, as do the types an archetype defers (CourseInstance). Every value comes from the record; nothing is made up, and a
 * record that says nothing about access gets no badge rather than "Free".
 *
 * @module
 */
import { RENDERER_SPEC } from './renderer-spec.js';

type Obj = Record<string, unknown>;

/** How a card draws: a business, a person, a product, a review, an article, or anything else. */
export type Archetype = 'place' | 'profile' | 'offerable' | 'opinion' | 'media' | 'series' | 'happening' | 'opportunity' | 'readable' | 'thing';

/** What a button is for; an archetype lists them in the order its lead is chosen by. */
export type Intent = 'consume' | 'transact' | 'contact' | 'navigate';

/** One access state, and the badge that says it. */
export interface Access {
  state: AccessState;
  label: string;
}

/** Free, a free preview, a free sign-up, a subscription, or a price. */
export type AccessState = 'free' | 'preview' | 'registration' | 'subscription' | 'purchase';

interface ArchetypeSpec {
  id: string;
  group: string;
  phase: number;
  lead: readonly string[];
  /** Types that wait for a later phase though they map to it: a CourseInstance, a dated session of its course. */
  deferred?: readonly string[];
}

interface Spec {
  version: number;
  archetypes: readonly ArchetypeSpec[];
  actions: Readonly<Record<string, { intent: string; label?: string }>>;
  access: Readonly<Record<AccessState, string>>;
  /** The words a series' part row uses for its access: "Subscribers" rather than "Subscription". */
  partAccess: Readonly<Record<AccessState, string>>;
  /** A series' badge, said from its parts: all free, some, none. */
  seriesAccess: Readonly<Record<'all' | 'some' | 'none', string>>;
  types: Readonly<Record<string, string>>;
}

/** The spec, typed loosely enough to read any key the generated `as const` holds. */
export const SPEC: Spec = RENDERER_SPEC;

/** The phase every archetype of which is built; later ones draw as Thing until their phase ships. */
export const RENDERER_PHASE = 1;

const built = (a: ArchetypeSpec): boolean => a.phase <= RENDERER_PHASE;

/** The spec version these cards follow; the same number on every surface draws the same card. */
export const RENDERER_SPEC_VERSION = SPEC.version;

const ARCH = new Map(SPEC.archetypes.map((a, rank) => [a.id, { ...a, rank }]));
const DEFERRED = new Set(SPEC.archetypes.flatMap((a) => a.deferred ?? []));

/** schema.org's namespace, however a record spells it: `https://schema.org/`, `http://schema.org/` or `schema:`. */
const SCHEMA_NS = /^(?:https?:\/\/schema\.org\/|schema:)/;
const short = (t: unknown): string => (typeof t === 'string' ? t.replace(SCHEMA_NS, '') : '');
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** A value object's value (`{"@value": "x"}` → "x"); anything else as it is. */
const valueOf = (v: unknown): unknown => (isObj(v) && '@value' in v ? v['@value'] : v);
/** Expanded JSON-LD holds every value in a list of value objects: one becomes the value, more stay a list. */
const expanded = (v: unknown): unknown => {
  const vs = list(v).map(valueOf);
  return vs.length === 1 ? vs[0] : vs;
};

/**
 * A property by its short name or by its IRI, however the record spells it: `name`, `https://schema.org/name`,
 * `http://schema.org/name` or `schema:name`. Expanded JSON-LD's `[{"@value": …}]` reads as the value; a reference,
 * `{"@id": …}`, stays one (resolve it with {@link idIndex} and {@link deref}).
 */
export const prop = (o: unknown, key: string): unknown => {
  if (!isObj(o)) return undefined;
  if (o[key] != null) return Array.isArray(o[key]) ? (o[key] as unknown[]).map(valueOf) : valueOf(o[key]);
  for (const k of [`https://schema.org/${key}`, `http://schema.org/${key}`, `schema:${key}`]) if (o[k] != null) return expanded(o[k]);
  return undefined;
};

/** A record's types, short: `["PodcastEpisode"]`, from `@type` however it is spelled. */
export const typesOf = (record: unknown): string[] => (isObj(record) ? list(record['@type']).map(short).filter(Boolean) : []);

/** Whether a value is only a reference to a node defined elsewhere: `{"@id": "…#audio"}`. */
const isRef = (v: unknown): v is { '@id': string } => isObj(v) && typeof v['@id'] === 'string' && Object.keys(v).length === 1;

/**
 * Every node a record (or a whole `@graph`) defines, by `@id`: what a reference such as `audio: {"@id": "…#audio"}`
 * points at. Where a node appears more than once, the fullest copy wins; a bare reference never defines one.
 */
export function idIndex(...roots: unknown[]): Map<string, Obj> {
  const index = new Map<string, Obj>();
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Obj;
    const id = o['@id'];
    if (typeof id === 'string' && !isRef(o)) {
      const had = index.get(id);
      if (!had || Object.keys(o).length > Object.keys(had).length) index.set(id, o);
    }
    for (const [k, x] of Object.entries(o)) if (k !== '@context') walk(x, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return index;
}

/** A value with its references resolved one level: `{"@id": "…#audio"}` → the AudioObject the index holds for it.
 * A reference the index doesn't hold stays as it is. */
export function deref(v: unknown, index: ReadonlyMap<string, Obj>): unknown {
  if (Array.isArray(v)) return v.map((x) => deref(x, index));
  return isRef(v) ? index.get(v['@id']) ?? v : v;
}

/**
 * A record as compact JSON-LD, whatever form it came in: `http://schema.org/name: [{"@value": "x"}]` becomes
 * `name: "x"`, and `@type`s lose their namespace. A compact record comes back as it was (copied), so the cards read
 * one shape. References stay references.
 */
export function compact(record: Obj, depth = 0): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(record)) {
    const key = k.startsWith('@') ? k : short(k);
    const iri = key !== k;
    const each = (x: unknown): unknown => {
      const y = valueOf(x);
      return isObj(y) && depth < 8 ? compact(y, depth + 1) : Array.isArray(y) ? y.map(each) : y;
    };
    let value: unknown = k === '@type' ? (Array.isArray(v) ? v.map(short) : short(v)) : Array.isArray(v) ? v.map(each) : each(v);
    if (iri && Array.isArray(value) && value.length === 1) value = value[0];
    if (!(key in out) || !iri) out[key] = value;
  }
  return out;
}

/** What kind of media a record is, or holds: audio, video, or an image. */
export type MediaKind = 'audio' | 'video' | 'image';

/** Each kind's schema.org types and file extensions, space-separated: a table this small costs less as words. */
const KINDS: readonly [MediaKind, string, string][] = [
  ['audio', 'AudioObject AudioObjectSnapshot Audiobook MusicRecording MusicAlbum PodcastEpisode PodcastSeries PodcastSeason RadioEpisode RadioSeries RadioClip', 'mp3 m4a aac oga ogg opus wav flac weba'],
  ['video', 'VideoObject VideoObjectSnapshot Movie MovieClip MovieSeries TVEpisode TVSeries TVSeason TVClip Clip', 'mp4 m4v webm mov ogv m3u8 mpd'],
  ['image', 'ImageObject ImageObjectSnapshot Photograph Barcode', 'jpg jpeg png gif webp avif svg'],
];
const kindBy = (col: 1 | 2): Map<string, MediaKind> => new Map(KINDS.flatMap((k) => k[col].split(' ').map((w) => [w, k[0]] as [string, MediaKind])));
const KIND_BY_TYPE = kindBy(1);
const KIND_BY_EXT = kindBy(2);

/** A media type (`audio/mpeg`, `image/webp`; HLS and DASH as video) as a kind. */
export function kindOfFormat(format: unknown): MediaKind | undefined {
  const f = typeof format === 'string' ? format.trim().toLowerCase() : '';
  const top = f.split('/')[0];
  if (top === 'audio' || top === 'video' || top === 'image') return top;
  return /mpegurl|dash\+xml/.test(f) ? 'video' : undefined;
}

/** A URL's file extension as a kind: `…/02.mp3?x=1` → audio. */
export function kindOfUrl(url: unknown): MediaKind | undefined {
  if (typeof url !== 'string') return undefined;
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url.split(/[?#]/)[0] + '#');
  return m ? KIND_BY_EXT.get(m[1].toLowerCase()) : undefined;
}

/**
 * What kind of media a record is: from its `@type` (an AudioObject, a TVEpisode, a Photograph), then its
 * `encodingFormat`, then its `contentUrl`'s extension, then the media it carries (`associatedMedia`, `audio`,
 * `video`, `encoding`). Undefined for anything that is no media at all.
 */
export function mediaKind(record: unknown, index: ReadonlyMap<string, Obj> = idIndex(record)): MediaKind | undefined {
  if (!isObj(record)) return undefined;
  for (const t of typesOf(record)) if (KIND_BY_TYPE.has(t)) return KIND_BY_TYPE.get(t);
  const own = kindOfFormat(first(prop(record, 'encodingFormat'))) ?? kindOfUrl(first(prop(record, 'contentUrl')));
  if (own) return own;
  if (prop(record, 'video') !== undefined) return 'video';
  if (prop(record, 'audio') !== undefined) return 'audio';
  for (const key of ['associatedMedia', 'encoding']) {
    for (const m of list(deref(prop(record, key), index)).filter(isObj)) {
      const k = typesOf(m).map((t) => KIND_BY_TYPE.get(t)).find(Boolean) ?? kindOfFormat(first(prop(m, 'encodingFormat'))) ?? kindOfUrl(first(prop(m, 'contentUrl')));
      if (k) return k;
    }
  }
  return undefined;
}

/** "LocalBusiness" → "Local business", "HVACBusiness" → "HVAC business": a type as a person reads it. */
export const readableType = (t: string | undefined): string | undefined =>
  t
    ? t
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(' ')
        .map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
        .join(' ')
        .replace(/^./, (c) => c.toUpperCase())
    : undefined;

/** A person or organization as text: a name, or the string a record gives instead. */
export const nameOf = (v: unknown): string | undefined => {
  const x = first(v);
  return typeof x === 'string' ? str(x) : str(prop(x, 'name'));
};

/** The record's first type, short: "Plumber", not "https://schema.org/Plumber". */
export const typeOf = (record: Obj): string => short(first(record['@type']));

/**
 * The archetype a record draws as. Each of its types is looked up in the spec's map; with several, the one the
 * spec lists first wins, which lists the specific before the broad. Unknown types, archetypes of a later
 * phase, and the types an archetype defers, draw as Thing.
 */
export function archetype(record: Obj): Archetype {
  const found = list(record['@type'])
    .map((t) => short(String(t)))
    .filter((t) => !DEFERRED.has(t))
    .map((t) => SPEC.types[t])
    .filter((id): id is string => !!id && ARCH.has(id))
    .sort((a, b) => ARCH.get(a)!.rank - ARCH.get(b)!.rank);
  const id = found[0] ?? 'thing';
  return (built(ARCH.get(id)!) ? id : 'thing') as Archetype;
}

/** The heading a card is listed under: "Businesses", "Reviews". */
export const groupOf = (arch: Archetype): string => ARCH.get(arch)?.group ?? 'Other';

/** The archetype's intents, in the order its lead button is chosen by. */
export const leadOrder = (arch: Archetype): readonly Intent[] => (ARCH.get(arch)?.lead ?? ['navigate']) as readonly Intent[];

/** What an action is for, by its `@type`: a quote is contact, a reservation transact. */
export const intentOf = (actionType: string): Intent | undefined => SPEC.actions[short(actionType)]?.intent as Intent | undefined;

/**
 * What a record is called, by what it is: a business or product by its name, an article by its headline, a
 * review by what it reviews, and failing those, its type. "Untitled" only when the record holds no label at all.
 */
export function entityLabel(record: Obj): string {
  const type = typeOf(record);
  const reviewed = nameOf(record.itemReviewed);
  return (
    str(record.name) ??
    str(record.headline) ??
    str(record.title) ??
    (reviewed ? (type === 'Review' ? `Review of ${reviewed}` : reviewed) : undefined) ??
    readableType(type) ??
    'Untitled'
  );
}

/** A paywall section in Google's markup (a WebPageElement named by its CSS selector), as against a part that is a
 * work of its own, such as a series' episode. */
const isSection = (p: Obj): boolean => short(first(p['@type'])) === 'WebPageElement' || prop(p, 'cssSelector') !== undefined;

/** The works a series lists as its parts (episodes, lessons), not Google's paywall sections. */
export const worksOf = (record: Obj): Obj[] => list(prop(record, 'hasPart')).filter(isObj).filter((p) => !isSection(p));

const SERIES_KIND: Readonly<Record<string, [string, string]>> = {
  PodcastSeries: ['Podcast', 'episode'],
  RadioSeries: ['Radio series', 'episode'],
  TVSeries: ['TV series', 'episode'],
  Course: ['Course', 'lesson'],
};

/** "Podcast · Brackwater Audio · 12 episodes": what it is, who makes it, and how many parts it has. */
function seriesLine(record: Obj, type: string): (string | undefined)[] {
  const [kind, part] = SERIES_KIND[type] ?? [readableType(type), 'part'];
  const n = num(prop(record, 'numberOfEpisodes')) ?? (worksOf(record).length || undefined);
  const by = nameOf(record.publisher) ?? nameOf(record.author) ?? nameOf(record.provider);
  return [kind, by, n !== undefined ? `${n} ${part}${n === 1 ? '' : 's'}` : undefined];
}

/** The one line under the name: what it is, and the detail that identifies it for its archetype. */
export function subtitle(record: Obj, arch: Archetype = archetype(record)): string | undefined {
  const type = typeOf(record);
  const kind = type && type !== 'LocalBusiness' && type !== 'Thing' ? readableType(type) : undefined;
  const place = str(prop(record.address, 'addressLocality'));
  const date = str(record.datePublished);
  const episode = num(record.episodeNumber);
  const bits: Partial<Record<Archetype, (string | undefined)[]>> = {
    place: [kind, place],
    profile: [str(record.jobTitle) ?? nameOf(record.worksFor) ?? kind],
    offerable: [nameOf(record.brand) ?? nameOf(record.provider) ?? kind],
    readable: [nameOf(record.publisher), nameOf(record.author), date ? date.slice(0, 10) : undefined],
    media: [nameOf(record.partOfSeries) ?? kind, episode !== undefined ? `Episode ${episode}` : undefined],
    series: arch === 'series' ? seriesLine(record, type) : [],
    opinion: [],
    happening: [kind],
    thing: [kind],
  };
  return (bits[arch] ?? []).filter(Boolean).join(' · ') || undefined;
}

const yes = (v: unknown) => v === true || v === 'true' || v === 'True';
const no = (v: unknown) => v === false || v === 'false' || v === 'False';

function price(offer: unknown): { value: number; text: string } | undefined {
  const v = num(prop(offer, 'price'));
  if (v === undefined) return undefined;
  const cur = str(prop(offer, 'priceCurrency'));
  return { value: v, text: v === 0 ? SPEC.access.free : !cur || cur === 'USD' ? `$${v}` : `${v} ${cur}` };
}

const freeOf = (o: unknown): unknown => prop(o, 'isAccessibleForFree');

/**
 * One access state, read from markup sites already publish for Google: an action's
 * `actionAccessibilityRequirement` (`requiresSubscription`, `expectsAcceptanceOf` an Offer; a subscription whose
 * offer costs nothing is a free sign-up), the record's `isAccessibleForFree` with `hasPart` paywall sections, a
 * series' parts, and its offers. Nothing to go on is undefined: no badge, and never "free". The same rules as
 * the NxisAI app's `access()`.
 *
 * @param action - The record's action the card offers, when it has one: a media item's consume action (its
 * Listen), so a paid episode's subscription decides its badge.
 */
export function access(record: Obj, action?: Obj): Access | undefined {
  const reqs = list(prop(action, 'actionAccessibilityRequirement')).filter(isObj);
  const accepts = (o: unknown): unknown => (isObj(o) ? first(prop(o, 'expectsAcceptanceOf')) : undefined);
  // The action says anyone can take it (Google's `nologinrequired`): on a work that isn't free, that's its preview.
  const open = reqs.some((r) => short(String(prop(r, 'category') ?? '')) === 'nologinrequired');
  for (const r of reqs) {
    const sub = prop(r, 'requiresSubscription');
    const offer = accepts(r) ?? accepts(sub);
    const p = isObj(offer) ? price(offer) : undefined;
    if (yes(sub) || isObj(sub))
      return p && p.value === 0
        ? { state: 'registration', label: SPEC.access.registration }
        : { state: 'subscription', label: SPEC.access.subscription };
    if (p && p.value > 0) return { state: 'purchase', label: p.text };
  }
  const free = freeOf(record);
  const parts = list(prop(record, 'hasPart')).filter(isObj);
  const works = parts.filter((p) => !isSection(p));
  // A series with free episodes and paid ones is a free preview of itself; the parts say so, the series need not.
  const sample = works.some((p) => yes(freeOf(p))) && works.some((p) => no(freeOf(p)));
  if (no(free)) {
    const paywalled = parts.some((p) => isSection(p) && no(freeOf(p)));
    return paywalled || sample || open
      ? { state: 'preview', label: SPEC.access.preview }
      : { state: 'subscription', label: SPEC.access.subscription };
  }
  if (yes(free)) return { state: 'free', label: SPEC.access.free };
  if (sample) return { state: 'preview', label: SPEC.access.preview };
  const p = list(record.offers).map(price).find(Boolean);
  if (p) return p.value === 0 ? { state: 'free', label: SPEC.access.free } : { state: 'purchase', label: p.text };
  return undefined;
}

/** The record's action a card's access is read from: its consume action (a Listen), else its first. */
export function accessAction(record: Obj): Obj | undefined {
  const acts = list(record.potentialAction).filter(isObj);
  return acts.find((a) => SPEC.actions[short(first(a['@type']))]?.intent === 'consume') ?? acts[0];
}

/**
 * An ISO 8601 duration as a clock reads it: PT8S → "0:08", PT12M5S → "12:05", PT1H2M → "1:02:00". Anything else,
 * or nothing, is undefined: no duration shown.
 */
export function clock(iso: unknown): string | undefined {
  const total = durationSeconds(iso);
  if (total === undefined) return undefined;
  const hh = Math.floor(total / 3600);
  const mm = Math.floor(total / 60) % 60;
  const ss = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/** An ISO 8601 duration in whole seconds: PT1M5S → 65. Anything else is undefined. */
export function durationSeconds(iso: unknown): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
    typeof iso === 'string' ? iso.trim() : '',
  );
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return undefined;
  return Math.round((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0));
}

/** How long a media item runs: its own `duration` (or `timeRequired`), else its audio's or associated media's. */
export function runtime(record: Obj): string | undefined {
  const media = ['associatedMedia', 'audio', 'video'].flatMap((k) => list(record[k]));
  return [record, ...media]
    .filter(isObj)
    .map((m) => clock(str(prop(m, 'duration')) ?? str(prop(m, 'timeRequired'))))
    .find(Boolean);
}

/** A review's stars are its own (`reviewRating`); one review is not an aggregate, so it has no count. */
export const reviewStars = (record: Obj): number | undefined => num(prop(record.reviewRating, 'ratingValue'));

/** A review's own facts: who wrote it, and what they wrote. */
export function reviewFacts(record: Obj): string[] {
  const by = nameOf(record.author);
  const body = str(record.reviewBody);
  return [by ? `By ${by}` : undefined, body ? `“${body}”` : undefined].filter((l): l is string => !!l);
}

/**
 * Records drawn once each: a site's records can list one business once per page it is on, and records of one name,
 * type and address are one thing to a visitor. `keep` is the first of each, in order; `at[i]` is where record `i`
 * is in `keep` (its own place, or the place of the one it repeats). A record with no name is always kept.
 */
export function onceEach(records: readonly unknown[]): { keep: number[]; at: number[] } {
  const first = new Map<string, number>();
  const keep: number[] = [];
  const at = records.map((r, i) => {
    const name = String(list(prop(r, 'name'))[0] ?? '').trim().toLowerCase();
    const a = list(prop(r, 'address'))[0];
    const addr = isObj(a) ? ['streetAddress', 'addressLocality', 'postalCode'].map((k) => String(prop(a, k) ?? '')).join('|') : String(a ?? '');
    const key = `${name}\n${typesOf(r).sort().join(',')}\n${addr.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (name && first.has(key)) return first.get(key)!;
    if (name) first.set(key, keep.length);
    return keep.push(i) - 1;
  });
  return { keep, at };
}

/**
 * A phone number as a `tel:` link, in E.164 where the country can be told: `tel:+17735550142` for "(773) 555-0142".
 * A number with its own "+" keeps it; a 10-digit number (or 11 starting with 1) is North American; any other is
 * dialed as written. Undefined when it isn't a number.
 */
export function telHref(phone: unknown): string | undefined {
  const d = String(phone ?? '').replace(/[^\d+]/g, '');
  if (!/^\+?\d{7,15}$/.test(d)) return undefined;
  if (d[0] === '+') return `tel:${d}`;
  if (/^[2-9]\d{9}$/.test(d)) return `tel:+1${d}`;
  if (/^1[2-9]\d{9}$/.test(d)) return `tel:+${d}`;
  return `tel:${d}`;
}
