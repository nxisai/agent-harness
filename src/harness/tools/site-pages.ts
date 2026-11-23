/**
 * The site's pages, and which of them a record belongs to.
 *
 * A result the agent finds is a record — a plumber, a product — and the
 * visitor usually wants the page it came from. The record rarely says: a
 * business's `url` is its website, often the site root. Typed retrieval also
 * holds the site's `WebPage` records, and every Action names the page its form
 * is on, so between them most records can be traced back to a page.
 *
 * Only pages on this origin are ever returned: whatever a record claims, the
 * agent does not send a visitor to another site.
 *
 * @module
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServerInfo } from '../../types.js';
import type { NxisAction } from '../../webmcp-contract.js';
import { queryTypedRecords, samePage } from './site-actions.js';

const SCHEMA_NS = 'https://schema.org/';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_PREFIX = 'nxis:site-pages:v1:';

/** A page on the site, as the agent can name it. */
export interface SitePage {
  /** Absolute URL, on this origin. */
  url: string;
  /** What the page is called, for the visitor and the model. */
  name: string;
  /** The `@id`s of the records the page is about, when its record says. */
  about?: string[];
  /** Pages this one points a reader at: its `significantLink` and `relatedLink`. */
  links?: string[];
  /** The `@id` of the breadcrumb trail extracted from this page, when it has one. */
  breadcrumb?: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const schemaValue = (o: Obj, prop: string): unknown => o[prop] ?? o[SCHEMA_NS + prop];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const bareType = (t: string): string => t.replace(/^.*[/#]/, '');
const types = (o: Obj): string[] =>
  (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).filter((t): t is string => typeof t === 'string').map(bareType);

/** A name compared the way a person would: case, spacing and punctuation aside. */
const normal = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * A URL resolved against the origin, if it stays on it.
 *
 * Crawled pages often record a path (`/listings/x.html`) rather than a URL.
 */
function onOrigin(raw: unknown, origin: string): string | null {
  const s = str(raw);
  if (!s) return null;
  try {
    const url = new URL(s, origin);
    return url.origin === new URL(origin).origin ? url.href : null;
  } catch {
    return null;
  }
}

/** Every `@id` (or URL) a reference property points at. */
function refs(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [v];
  return list
    .map((r) => (isObj(r) ? str(r['@id']) ?? str(schemaValue(r, 'url')) : str(r)))
    .filter((r): r is string => !!r);
}

/**
 * Read one typed-retrieval record as a page.
 *
 * @param raw - A record as returned by `nxis_query`.
 * @param origin - The site's origin; pages elsewhere are refused.
 * @returns The page, or null when the record is not a page, has no URL on
 * this origin, or has no name.
 */
export function parsePage(raw: unknown, origin: string): SitePage | null {
  if (!isObj(raw) || !types(raw).some((t) => t.endsWith('Page'))) return null;
  const url = onOrigin(schemaValue(raw, 'url'), origin);
  const name = str(schemaValue(raw, 'name')) ?? str(schemaValue(raw, 'headline'));
  if (!url || !name) return null;
  const about = [...refs(schemaValue(raw, 'mainEntity')), ...refs(schemaValue(raw, 'about'))];
  // What the page points at, which is how an agent follows a page's own links rather than only
  // the hierarchy above it. Kept as published; the platform stores them absolute.
  const links = [...new Set([...refs(schemaValue(raw, 'significantLink')), ...refs(schemaValue(raw, 'relatedLink'))])];
  const breadcrumb = refs(schemaValue(raw, 'breadcrumb'))[0];
  return {
    url,
    name,
    ...(about.length ? { about } : {}),
    ...(links.length ? { links } : {}),
    ...(breadcrumb ? { breadcrumb } : {}),
  };
}

/**
 * The pages the site's actions live on, named for what each is about.
 *
 * An action whose field is fixed to one value — the business a quote goes
 * to — names its page better than the page's path does.
 */
export function pagesFromActions(actions: NxisAction[], origin: string): SitePage[] {
  const pages: SitePage[] = [];
  for (const action of actions) {
    const url = onOrigin(action.target['nxis:pageUrl'], origin);
    if (!url) continue;
    // A name, not a count or a code: a quantity field's "0" or an event's `low-light-2027` names nothing.
    const named = (action.input ?? []).find((i) => i.defaultValue && !i['nxis:valueOption'] && isName(i.defaultValue));
    const name = named?.defaultValue ?? slugName(url);
    if (name) pages.push({ url, name });
  }
  return pages;
}

/** Words, rather than a number or a code written for a program. */
const isName = (v: string): boolean => /\p{L}/u.test(v) && !(/^\S+$/.test(v.trim()) && /[-_\d]/.test(v));

/** `/listings/detroit-metro-plumbing.html` → `detroit metro plumbing`. */
function slugName(url: string): string {
  const slug = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  return slug.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ') || 'home';
}

/**
 * Pages from any number of sources, each page once.
 *
 * The first source to name a page wins its name, so pass the page records
 * before anything inferred.
 */
export function mergePages(...lists: SitePage[][]): SitePage[] {
  const out: SitePage[] = [];
  for (const page of lists.flat()) {
    const same = out.find((p) => samePage(p.url, page.url));
    if (!same) out.push({ ...page });
    else {
      if (page.about?.length) same.about = [...new Set([...(same.about ?? []), ...page.about])];
      if (page.links?.length) same.links = [...new Set([...(same.links ?? []), ...page.links])];
      if (page.breadcrumb && !same.breadcrumb) same.breadcrumb = page.breadcrumb;
    }
  }
  return out;
}

/**
 * The page a record came from, when it can be told.
 *
 * In order of how much each is to be trusted: the record naming its page, its
 * id when that is formed from a page (`page.html#organization`), the record
 * being a page, the record's own URL when it is a page of this site rather than
 * its root, a page that says it is about the record, and last a page with the
 * record's exact name.
 *
 * @param entity - The record, compact or IRI-keyed.
 * @param pages - The site's pages.
 * @param origin - The site's origin.
 * @returns The page, or null when none can be told apart.
 */
export function pageForEntity(entity: Obj, pages: SitePage[], origin: string): SitePage | null {
  if (!isObj(entity)) return null;
  const name = str(schemaValue(entity, 'name')) ?? str(schemaValue(entity, 'headline'));
  const known = (url: string): SitePage =>
    pages.find((p) => samePage(p.url, url)) ?? { url, name: name ?? slugName(url) };

  for (const ref of refs(schemaValue(entity, 'mainEntityOfPage'))) {
    const url = onOrigin(ref, origin);
    if (url) return known(url);
  }

  // An id built from its page (`page.html#organization`) names the page: everything before the
  // fragment. Only with a fragment and below the root: a site-wide id (`/#organization/...`) names
  // no page, and the hash-suffixed ids stored before (`page.html/23400b...`) are not pages either.
  const idPage = pageOfId(str(entity['@id']), origin);
  if (idPage) return known(idPage);

  const own = onOrigin(schemaValue(entity, 'url'), origin);
  if (own && (types(entity).some((t) => t.endsWith('Page')) || new URL(own).pathname !== '/')) {
    return known(own);
  }

  const id = str(entity['@id']);
  if (id) {
    const about = pages.filter((p) => p.about?.includes(id));
    if (about.length === 1) return about[0];
  }

  if (name) {
    const named = pages.filter((p) => normal(p.name) === normal(name));
    if (named.length === 1) return named[0];
  }
  return null;
}

/**
 * The page an id formed from it names, or null.
 *
 * The NxisAI index forms a page entity's id as the page URL plus a fragment, so the page is the id with
 * the fragment removed.
 */
function pageOfId(id: string | undefined, origin: string): string | null {
  if (!id || !id.includes('#')) return null;
  const url = onOrigin(id, origin);
  if (!url) return null;
  const page = new URL(url);
  page.hash = '';
  return page.pathname === '/' ? null : page.href;
}

/**
 * The page a visitor or model means, by name or by address.
 *
 * @param wanted - A page name, a URL, or a path.
 * @param pages - The site's pages.
 * @param origin - The site's origin.
 * @returns The page, or null when nothing matches or several do equally.
 */
export function findPage(wanted: string, pages: SitePage[], origin: string): SitePage | null {
  const w = wanted.trim();
  if (!w) return null;
  if (/^(https?:\/\/|\/)/i.test(w)) {
    const url = onOrigin(w, origin);
    return url ? (pages.find((p) => samePage(p.url, url)) ?? null) : null;
  }
  const n = normal(w);
  const exact = pages.filter((p) => normal(p.name) === n);
  if (exact.length === 1) return exact[0];
  const partial = pages.filter((p) => normal(p.name).includes(n) || n.includes(normal(p.name)));
  return partial.length === 1 ? partial[0] : null;
}

/** Options for {@link loadSitePages}. */
export interface SitePagesOptions {
  /** The origin pages must belong to. Defaults to the page's own. */
  origin?: string;
  /** Where the list is cached between page loads. Defaults to `sessionStorage`; null disables. */
  storage?: Storage | null;
  /** How long a cached list is reused, in milliseconds. Defaults to ten minutes. */
  ttlMs?: number;
  /** The clock, for tests. */
  now?: () => number;
}

function defaultStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Every page record on the site, on this origin.
 *
 * Cached in the tab like the site's actions, so moving between pages costs
 * one request per session.
 *
 * @throws When the query fails. The caller decides whether that matters.
 */
export async function loadSitePages(
  client: Client,
  info: Pick<McpServerInfo, 'endpoint'>,
  opts: SitePagesOptions = {},
): Promise<SitePage[]> {
  const origin = opts.origin ?? location.origin;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const now = (opts.now ?? Date.now)();
  const key = CACHE_PREFIX + info.endpoint;

  try {
    const entry = JSON.parse(storage?.getItem(key) || 'null') as { fetchedAt: number; pages: SitePage[] } | null;
    const fresh = entry && now - entry.fetchedAt <= (opts.ttlMs ?? CACHE_TTL_MS) && entry.fetchedAt <= now;
    if (fresh && Array.isArray(entry.pages)) return entry.pages;
  } catch {
    // A corrupt entry is a refetch.
  }

  const pages = mergePages(
    (await queryTypedRecords(client, 'Page'))
      .map((r) => parsePage(r, origin))
      .filter((p): p is SitePage => p !== null),
  );
  try {
    storage?.setItem(key, JSON.stringify({ fetchedAt: now, pages }));
  } catch {
    // Full or blocked storage costs a refetch on the next page, nothing more.
  }
  return pages;
}
