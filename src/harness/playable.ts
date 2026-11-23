/**
 * The media a record carries, as the cards show it: its pictures now, and what can play in the chat.
 *
 * Pure and renderer-free: the answer view and the A2UI surface draw from the same detection. Every address is
 * checked by {@link safeMediaUrl} before anything draws it; a record's pictures are https (or this page's own
 * origin), never `data:`, `blob:` or `javascript:`, never a URL with credentials or an unfilled template.
 *
 * @module
 */
import { archetype, deref, durationSeconds as seconds, idIndex, mediaKind, nameOf, prop, typesOf } from './entity.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const no = (v: unknown) => v === false || v === 'false' || v === 'False';

/** The longest address drawn; anything longer is not a picture's. */
export const MAX_MEDIA_URL = 2048;

/**
 * A media address that is safe to put in `src`: https, or this page's own origin (a site served over http on
 * localhost). `data:`, `blob:`, `javascript:` and every other scheme, credentials (`https://user:pass@…`), unfilled
 * templates (`{id}`), whitespace and anything over 2048 characters are refused.
 *
 * @param here - The page's own address, for its origin. Defaults to the browser's.
 */
export function safeMediaUrl(v: unknown, here: string | undefined = typeof location === 'undefined' ? undefined : location.href): string | undefined {
  const raw = str(v);
  if (!raw || raw.length > MAX_MEDIA_URL || /[{}\s<>"\\]/.test(raw)) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.username || u.password) return undefined;
  if (u.protocol === 'https:') return u.href;
  try {
    return here && u.protocol === 'http:' && u.origin === new URL(here).origin ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A length in pixels, however a record gives it: `640`, `"640"`, `"640 px"`, or a QuantitativeValue
 * (`{"value": 640, "unitCode": "E37"}`). Other units, and anything not a positive size, are undefined.
 */
export function pixels(v: unknown): number | undefined {
  const x = first(v);
  if (isObj(x)) {
    const unit = str(prop(x, 'unitCode')) ?? str(prop(x, 'unitText'));
    return unit && !/^(E37|px|pixels?)$/i.test(unit) ? undefined : pixels(prop(x, 'value'));
  }
  const m = typeof x === 'number' ? [String(x), String(x)] : typeof x === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*(?:px|pixels?)?\s*$/i.exec(x) : null;
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n < 100000 ? Math.round(n) : undefined;
}

/** One picture: where it is, its size when the record gives it (so its space is kept before it loads), and its words. */
export interface ImageModel {
  url: string;
  width?: number;
  height?: number;
  /** What it shows: its caption, else its name. */
  alt?: string;
}

/** The properties a record's pictures are read from, in order; `logo` only for a place or a person. */
const IMAGE_KEYS = ['image', 'thumbnail', 'thumbnailUrl', 'photo'];

/** One value as a picture: a URL, or an ImageObject's `contentUrl` (else `url`), its size and words. */
function imageFrom(v: unknown, here?: string): ImageModel | undefined {
  if (!isObj(v)) {
    const url = safeMediaUrl(v, here);
    return url ? { url } : undefined;
  }
  const url = safeMediaUrl(first(prop(v, 'contentUrl')), here) ?? safeMediaUrl(first(prop(v, 'url')), here);
  if (!url) return undefined;
  const width = pixels(prop(v, 'width'));
  const height = pixels(prop(v, 'height'));
  const alt = str(first(prop(v, 'caption'))) ?? str(first(prop(v, 'name')));
  return { url, ...(width && height ? { width, height } : {}), ...(alt ? { alt } : {}) };
}

/** Whether a record is a picture itself: an ImageObject or a Photograph. */
export const isImageRecord = (record: unknown): boolean => typesOf(record).some((t) => /^(ImageObject|ImageObjectSnapshot|Photograph)$/.test(t));

/**
 * A record's pictures, first the one its tile shows: an image's own file (only its thumbnail when it isn't free),
 * then `image`, `thumbnail`, `thumbnailUrl` and `photo` (and `logo` for a place or a person), strings or
 * ImageObjects, each address once.
 */
export function imagesOf(record: unknown, here?: string): ImageModel[] {
  if (!isObj(record)) return [];
  const own: unknown[] = [];
  if (isImageRecord(record)) {
    // A paid picture shows only its thumbnail: the record's own file is what it sells.
    const width = prop(record, 'width');
    const height = prop(record, 'height');
    const file = no(prop(record, 'isAccessibleForFree')) ? undefined : first(prop(record, 'contentUrl'));
    if (file) own.push({ contentUrl: file, width, height, caption: prop(record, 'caption'), name: prop(record, 'name') });
  }
  const keys = ['place', 'profile'].includes(archetype(record)) ? [...IMAGE_KEYS, 'logo'] : IMAGE_KEYS;
  const seen = new Set<string>();
  return [...own, ...keys.flatMap((k) => list(prop(record, k)))]
    .map((v) => imageFrom(v, here))
    .filter((i): i is ImageModel => !!i && !seen.has(i.url) && !!seen.add(i.url));
}

/** The picture a record's tile shows, if it has one. */
export const imageOf = (record: unknown, here?: string): string | undefined => imagesOf(record, here)[0]?.url;

/** An ImageObject as its figure card draws it. */
export interface FigureModel {
  /** The picture: its own file, or only its thumbnail when it isn't free; none when a paid picture has no thumbnail. */
  image?: ImageModel;
  caption?: string;
  /** Who to credit: its `creditText`, else its `copyrightHolder` or `author`, by name. */
  credit?: string;
  /** Where its licence can be had (`acquireLicensePage`), shown and never enforced. */
  licensePage?: string;
  /** Its `license`, as given. */
  license?: string;
  /** The page it is on: its `url` (or `mainEntityOfPage`), when that isn't the picture's own file. */
  page?: string;
}

/** A picture record (an ImageObject or a Photograph) as its figure card, or undefined for anything else. */
export function figureOf(record: unknown, here?: string): FigureModel | undefined {
  if (!isObj(record) || !isImageRecord(record)) return undefined;
  const image = imagesOf(record, here)[0];
  const caption = str(first(prop(record, 'caption'))) ?? str(first(prop(record, 'description')));
  const credit = str(first(prop(record, 'creditText'))) ?? nameOf(prop(record, 'copyrightHolder')) ?? nameOf(prop(record, 'author'));
  const page = first(prop(record, 'acquireLicensePage'));
  const licensePage = safeMediaUrl(isObj(page) ? first(prop(page, 'url')) : page, here);
  const lic = first(prop(record, 'license'));
  const license = isObj(lic) ? str(first(prop(lic, 'url'))) ?? nameOf(lic) : str(lic);
  const at = [first(prop(record, 'url')), first(prop(record, 'mainEntityOfPage'))]
    .map((v) => str(isObj(v) ? v['@id'] ?? prop(v, 'url') : v))
    .find((u) => u && /^https?:\/\//i.test(u) && !/[{}\s]/.test(u) && u !== str(first(prop(record, 'contentUrl'))));
  // A paid picture shows its thumbnail, else no picture at all.
  const shown = no(prop(record, 'isAccessibleForFree'))
    ? imageFrom(first(prop(record, 'thumbnailUrl')) ?? first(prop(record, 'thumbnail')), here)
    : image && { ...image, ...(caption && !image.alt ? { alt: caption } : {}) };
  return {
    ...(shown ? { image: shown } : {}),
    ...(caption ? { caption } : {}),
    ...(credit ? { credit } : {}),
    ...(licensePage ? { licensePage } : {}),
    ...(license ? { license } : {}),
    ...(at ? { page: at } : {}),
  };
}

// ── Playing in the chat ──────────────────────────────────────────────────────────────────────────────────────────────

/** One file a media element can be given: its address and, when the record says, its media type. */
export interface MediaSource {
  src: string;
  type?: string;
}

/** A captions track: WebVTT only. */
export interface CaptionTrack {
  src: string;
  lang?: string;
  label?: string;
}

/**
 * Whether an item may play in the chat: free (or a preview or trailer that is itself marked free); locked (paid, a
 * subscription, a sign-up, or expired), never; unknown (no access markup at all), only when the site opts in.
 */
export type PlayAccess = 'free' | 'locked' | 'unknown';

/** Something the docked player can play, with everything it shows and reports. Plain data: it is saved with the
 * conversation, and the gate runs on it again when Play is pressed. */
export interface MediaModel {
  /** Stable for the item: its media object's `@id`, else its first file. */
  id: string;
  kind: 'audio' | 'video';
  /** Every file it comes in, best first; the player keeps those the browser can play. */
  sources: MediaSource[];
  access: PlayAccess;
  title: string;
  /** The show it belongs to. */
  show?: string;
  /** Its art (audio) or poster frame (video). */
  poster?: string;
  captions?: CaptionTrack[];
  transcript?: string;
  seconds?: number;
  /** Where to start, in seconds into the file: a cited clip's `startOffset` ({@link fromOffset}). */
  start?: number;
  /** Width over height, "16 / 9", for a video's frame. */
  aspect?: string;
  /** ISO date after which it may no longer be played. */
  expires?: string;
  /** Its `embedUrl`, kept for the embed story; not used to play. */
  embed?: string;
  /** Where to send the visitor when it can't play here: its page. */
  page?: string;
  /** What a play reports: its Listen or Watch action. */
  actionType?: string;
  actionId?: string;
  reportToken?: string;
}

/**
 * An item that starts `seconds` into its file, for a cited clip. It is an item of its own (its id names the time), so
 * two clips of one video each have their own Play, and the whole video its own. No offset, or none past 0: unchanged.
 */
export function fromOffset(m: MediaModel | undefined, seconds: number | undefined): MediaModel | undefined {
  return m && seconds && seconds > 0 ? { ...m, id: `${m.id}#t=${seconds}`, start: seconds } : m;
}

const HLS = 'application/vnd.apple.mpegurl';

/** A file and its media type. HLS is kept, to play where the browser plays it natively; DASH never plays here. */
function sourceOf(o: unknown, here?: string): MediaSource | undefined {
  const src = safeMediaUrl(first(isObj(o) ? prop(o, 'contentUrl') : o), here);
  if (!src) return undefined;
  const given = isObj(o) ? str(first(prop(o, 'encodingFormat'))) : undefined;
  const type = given?.toLowerCase() ?? (/\.m3u8(?:$|[?#])/i.test(src) ? HLS : undefined);
  if (type && /dash\+xml/.test(type)) return undefined;
  if (!type && /\.mpd(?:$|[?#])/i.test(src)) return undefined;
  return { src, ...(type && /^(audio|video)\/|mpegurl/.test(type) ? { type: /mpegurl/.test(type) ? HLS : type } : {}) };
}

const yes = (v: unknown) => v === true || v === 'true' || v === 'True';
const pastDate = (d: string | undefined, now: number): boolean => !!d && Number.isFinite(Date.parse(d)) && Date.parse(d) < now;

/** A media object's own access markup: free, locked, or nothing said. */
function ownAccess(o: Obj): PlayAccess {
  const free = prop(o, 'isAccessibleForFree');
  if (no(free) || prop(o, 'requiresSubscription') !== undefined) return 'locked';
  return yes(free) ? 'free' : 'unknown';
}

/**
 * A record's playable media, if it has any: the record itself, then its `audio`, `video`, `associatedMedia`,
 * `encoding`, `trailer` and `hasPart`, references resolved by `@id`. The first that may play wins (a paid episode's
 * free preview, a film's free trailer); with none, the first there is, locked.
 *
 * Access: an object marked free plays; one marked not free, or needing a subscription, never does; one that says
 * nothing takes the record's word (`recordAccess`): free plays, unknown is unknown, and anything else (a
 * subscription, a sign-up, a price) is locked. A past `expires` locks it.
 *
 * @param recordAccess - The record's own access state, as the card's badge reads it (`access()` in entity.ts).
 */
export function playableOf(
  record: unknown,
  opts: { recordAccess?: string; index?: ReadonlyMap<string, Obj>; here?: string; now?: number } = {},
): MediaModel | undefined {
  if (!isObj(record)) return undefined;
  const index = opts.index ?? idIndex(record);
  const now = opts.now ?? Date.now();
  const inherited: PlayAccess = !opts.recordAccess ? 'unknown' : opts.recordAccess === 'free' ? 'free' : 'locked';
  const candidates = [record, ...['audio', 'video', 'associatedMedia', 'encoding', 'trailer', 'hasPart'].flatMap((k) => list(deref(prop(record, k), index)))]
    .filter(isObj);
  const models: MediaModel[] = [];
  for (const c of candidates) {
    const kind = mediaKind(c, index);
    if (kind !== 'audio' && kind !== 'video') continue;
    const sources = [c, ...list(deref(prop(c, 'encoding'), index))].map((o) => sourceOf(o, here(opts))).filter((s): s is MediaSource => !!s);
    if (!sources.length) continue;
    const own = ownAccess(c);
    const expires = str(first(prop(c, 'expires'))) ?? str(first(prop(record, 'expires')));
    const access: PlayAccess = pastDate(expires, now) ? 'locked' : own === 'unknown' ? inherited : own;
    const w = pixels(prop(c, 'width'));
    const h = pixels(prop(c, 'height'));
    const captions = list(prop(c, 'caption'))
      .map((t) => ({ t, src: safeMediaUrl(isObj(t) ? first(prop(t, 'contentUrl')) ?? first(prop(t, 'url')) : t, here(opts)) }))
      .filter(({ t, src }) => src && (/\.vtt(?:$|[?#])/i.test(src) || (isObj(t) && /vtt/i.test(String(prop(t, 'encodingFormat'))))))
      .map(({ t, src }) => {
        const lang = isObj(t) ? str(first(prop(t, 'inLanguage'))) : undefined;
        return { src: src!, ...(lang ? { lang, label: lang } : {}) };
      });
    const poster = imageOf(c, here(opts)) ?? imageOf(record, here(opts));
    const transcript = str(first(prop(c, 'transcript'))) ?? str(first(prop(record, 'transcript')));
    const secs = seconds(first(prop(c, 'duration'))) ?? seconds(first(prop(record, 'duration')));
    const embed = safeMediaUrl(first(prop(c, 'embedUrl')), here(opts));
    const show = nameOf(prop(record, 'partOfSeries'));
    const page = [prop(record, 'url'), prop(c, 'url')].map((u) => str(first(u))).find((u) => u && /^https?:\/\//i.test(u) && !/[{}\s]/.test(u));
    models.push({
      id: str(c['@id']) ?? sources[0].src,
      kind,
      sources,
      access,
      title: str(first(prop(record, 'name'))) ?? str(first(prop(c, 'name'))) ?? 'Untitled',
      ...(show ? { show } : {}),
      ...(poster ? { poster } : {}),
      ...(captions.length ? { captions } : {}),
      ...(transcript ? { transcript } : {}),
      ...(secs ? { seconds: secs } : {}),
      ...(kind === 'video' && w && h ? { aspect: `${w} / ${h}` } : {}),
      ...(expires ? { expires } : {}),
      ...(embed ? { embed } : {}),
      ...(page ? { page } : {}),
    });
  }
  return models.find((m) => m.access !== 'locked') ?? models[0];
}

/** A record's media, as the cards use it: its pictures, and what can play in the chat, if anything. */
export function mediaOf(record: unknown, opts: Parameters<typeof playableOf>[1] = {}): { images: ImageModel[]; play?: MediaModel } {
  const play = playableOf(record, opts);
  return { images: imagesOf(record, opts.here), ...(play ? { play } : {}) };
}

const here = (opts: { here?: string }): string | undefined => opts.here ?? (typeof location === 'undefined' ? undefined : location.href);

/** Hosts whose media failed to play here this session (a Content-Security-Policy, an error, a stall); the player
 * (src/media/sources.ts) writes them. */
export const BLOCKED_KEY = 'nxis:media-blocked';

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The hosts marked blocked for this session. */
export function blockedHosts(storage: Storage | null = sessionStore()): string[] {
  try {
    const v = JSON.parse(storage?.getItem(BLOCKED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The gate, run when a card is drawn and again when Play is pressed (a card saved with the conversation may be
 * older than its access): free plays; unknown only with `unmarked`; locked, expired, or every file on a blocked
 * host, never.
 */
export function mayPlay(m: MediaModel | undefined, opts: { unmarked?: boolean; now?: number; storage?: Storage | null } = {}): m is MediaModel {
  if (!m || !m.sources?.length) return false;
  if (m.access === 'locked' || (m.access === 'unknown' && !opts.unmarked)) return false;
  if (pastDate(m.expires, opts.now ?? Date.now())) return false;
  const blocked = blockedHosts(opts.storage === undefined ? sessionStore() : opts.storage);
  return m.sources.some((s) => {
    try {
      return !blocked.includes(new URL(s.src).host);
    } catch {
      return false;
    }
  });
}
