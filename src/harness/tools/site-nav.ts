/**
 * The site as a graph the agent can walk.
 *
 * A page publishes one breadcrumb trail: the path from the site's root down to
 * itself. Every page publishes its own, so the trails together *are* the
 * hierarchy — inverted, each page gains the sections above it, the pages beside
 * it, and the pages under it. A page's `significantLink` and `relatedLink` add
 * the cross-links a hierarchy cannot express: a listing pointing at its service
 * area, a guide pointing at the form it explains.
 *
 * Link names come free. A link usually points at a page the site also has a
 * record for, so the name shown is that page's own name rather than anchor text
 * nobody extracted. A link to a page with no record keeps its address.
 *
 * Nothing here leaves the origin: a trail level or link on another host is
 * dropped when the graph is built, not when it is walked.
 *
 * @module
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServerInfo, ModelContext, ModelContextTool } from '../../types.js';
import { queryTypedRecords, samePage } from './site-actions.js';
import type { SitePage } from './site-pages.js';

const SCHEMA_NS = 'https://schema.org/';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_PREFIX = 'nxis:site-trails:v1:';

/** One level of a page's trail. The last is the page itself, and names no URL. */
export interface TrailLevel {
  /** What the site calls this level. */
  name: string;
  /** Absolute URL, on this origin. Absent on the page's own level. */
  url?: string;
}

/** A page's path from the root, root first. */
export interface SiteTrail {
  /** The page whose trail this is, when it can be told from the record's id. */
  page?: string;
  levels: TrailLevel[];
}

/** Somewhere the agent can go from here, and what to call it. */
export interface NavLink {
  url: string;
  name: string;
}

/** What a page is surrounded by. */
export interface PageNav {
  /** The sections above it, root first, not including the page itself. */
  ancestors: NavLink[];
  /** Pages under the same parent, excluding the page itself. */
  siblings: NavLink[];
  /** Pages whose parent is this page. */
  children: NavLink[];
  /** Pages this page points a reader at. */
  links: NavLink[];
}

/** The whole site, ready to answer "where am I and what is near me". */
export interface SiteNav {
  /** The site's origin, so a graph can be rebuilt from itself. */
  origin: string;
  /** Parent page URL, by page URL. */
  parents: Map<string, string>;
  /** The trail for each page it was published for. */
  trails: Map<string, TrailLevel[]>;
  /** Everything a page points at, by page URL. */
  links: Map<string, string[]>;
  /** Every page known, by URL, for naming. */
  pages: SitePage[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const schemaValue = (o: Obj, prop: string): unknown => o[prop] ?? o[SCHEMA_NS + prop];
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const bareType = (t: string): string => t.replace(/^.*[/#]/, '');

const types = (o: Obj): string[] =>
  (Array.isArray(o['@type']) ? o['@type'] : [o['@type']])
    .filter((t): t is string => typeof t === 'string')
    .map(bareType);

/** A URL resolved against the origin, if it stays on it. */
function onOrigin(raw: unknown, origin: string): string | undefined {
  const s = str(raw) ?? (isObj(raw) ? str(raw['@id']) ?? str(schemaValue(raw, 'url')) : undefined);
  if (!s) return undefined;
  try {
    const url = new URL(s, origin);
    url.hash = '';
    return url.origin === new URL(origin).origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The page a trail was published for: its record's id, without the fragment. */
function pageOfTrail(raw: Obj, origin: string): string | undefined {
  const id = str(raw['@id']);
  if (!id || !id.includes('#')) return undefined;
  return onOrigin(id, origin);
}

/**
 * Read one typed-retrieval record as a trail.
 *
 * @param raw - A `BreadcrumbList` record.
 * @param origin - The site's origin; levels elsewhere are dropped.
 * @returns The trail, or null when the record is not one or carries no levels.
 */
export function parseTrail(raw: unknown, origin: string): SiteTrail | null {
  if (!isObj(raw) || !types(raw).includes('BreadcrumbList')) return null;
  const rawLevels = schemaValue(raw, 'itemListElement');
  const list = Array.isArray(rawLevels) ? rawLevels : rawLevels ? [rawLevels] : [];
  const levels = list
    .filter(isObj)
    .map((item) => {
      const position = Number(schemaValue(item, 'position') ?? Number.MAX_SAFE_INTEGER);
      const name = str(schemaValue(item, 'name'));
      const url = onOrigin(schemaValue(item, 'item'), origin);
      return { position, name, url };
    })
    .filter((l): l is { position: number; name: string; url: string | undefined } => !!l.name)
    .sort((a, b) => a.position - b.position)
    .map(({ name, url }) => (url ? { name, url } : { name }));
  if (!levels.length) return null;
  const page = pageOfTrail(raw, origin);
  return page ? { page, levels } : { levels };
}

/**
 * The graph: who is above whom, and what points at what.
 *
 * A trail's parent is its last level with a URL that is not the page itself —
 * the section directly above. A page with a one-level trail (itself) has no
 * parent, which is what the root looks like.
 *
 * @param pages - The site's pages, for names.
 * @param trails - Its trails.
 * @param origin - The site's origin.
 */
export function buildNav(pages: SitePage[], trails: SiteTrail[], origin: string): SiteNav {
  const parents = new Map<string, string>();
  const byPage = new Map<string, TrailLevel[]>();
  const links = new Map<string, string[]>();

  for (const trail of trails) {
    // A trail with no id to place it still names its page in its last level.
    const page = trail.page ?? trail.levels[trail.levels.length - 1]?.url;
    if (!page) continue;
    byPage.set(page, trail.levels);
    const above = trail.levels.filter((l) => l.url && !samePage(l.url, page));
    const parent = above[above.length - 1]?.url;
    if (parent) parents.set(page, parent);
  }

  for (const page of pages) {
    const out = (page.links ?? [])
      .map((l) => onOrigin(l, origin))
      .filter((l): l is string => !!l && !samePage(l, page.url));
    if (out.length) links.set(page.url, [...new Set(out)]);
  }

  return { origin, parents, trails: byPage, links, pages };
}

/**
 * Fold trails into a graph already in someone's hands.
 *
 * The tools are built at connect and hold the graph; the trails may arrive
 * later, because fetching them is a read the site's rate limit counts. Mutating
 * in place is what lets a tool built before the fetch answer after it.
 */
export function applyTrails(nav: SiteNav, trails: SiteTrail[]): SiteNav {
  const fresh = buildNav(nav.pages, trails, nav.origin);
  nav.parents.clear();
  for (const [page, parent] of fresh.parents) nav.parents.set(page, parent);
  nav.trails.clear();
  for (const [page, levels] of fresh.trails) nav.trails.set(page, levels);
  return nav;
}

/** What a URL is called: the page's own name, else the last word of its path. */
export function nameOf(url: string, nav: SiteNav): string {
  const known = nav.pages.find((p) => samePage(p.url, url));
  if (known) return known.name;
  const level = [...nav.trails.values()].flat().find((l) => l.url && samePage(l.url, url));
  if (level) return level.name;
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return slug.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ') || 'home';
  } catch {
    return url;
  }
}

/** The page that a URL is under, if the graph knows. */
export function parentOf(url: string, nav: SiteNav): string | undefined {
  const key = [...nav.parents.keys()].find((p) => samePage(p, url));
  return key ? nav.parents.get(key) : undefined;
}

/**
 * Where the agent can go from a page: up, sideways, down, and out along its
 * own links.
 *
 * @param href - The page to place. Defaults to the browser's.
 */
export function navFor(nav: SiteNav, href: string): PageNav {
  const link = (url: string): NavLink => ({ url, name: nameOf(url, nav) });

  const ancestors: NavLink[] = [];
  let up = parentOf(href, nav);
  // A cycle in published trails would otherwise walk forever.
  while (up && ancestors.length < 8 && !ancestors.some((a) => samePage(a.url, up!))) {
    ancestors.unshift(link(up));
    up = parentOf(up, nav);
  }

  const parent = parentOf(href, nav);
  const siblings = parent
    ? [...nav.parents.entries()]
        .filter(([page, under]) => samePage(under, parent) && !samePage(page, href))
        .map(([page]) => link(page))
    : [];

  const children = [...nav.parents.entries()]
    .filter(([, under]) => samePage(under, href))
    .map(([page]) => link(page));

  const own = [...(nav.links.keys() as Iterable<string>)].find((p) => samePage(p, href));
  const links = (own ? (nav.links.get(own) ?? []) : []).map(link);

  return { ancestors, siblings, children, links };
}

/** Options for {@link loadSiteTrails}. */
export interface SiteTrailsOptions {
  /** The origin trails must belong to. Defaults to the page's own. */
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
 * Every breadcrumb trail on the site.
 *
 * One query, cached in the tab like the page list, because the hierarchy is the
 * same on every page of it.
 *
 * @throws When the query fails. The caller decides whether that matters.
 */
export async function loadSiteTrails(
  client: Client,
  info: Pick<McpServerInfo, 'endpoint'>,
  opts: SiteTrailsOptions = {},
): Promise<SiteTrail[]> {
  const origin = opts.origin ?? location.origin;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const now = (opts.now ?? Date.now)();
  const key = CACHE_PREFIX + info.endpoint;

  try {
    const entry = JSON.parse(storage?.getItem(key) || 'null') as { fetchedAt: number; trails: SiteTrail[] } | null;
    const fresh = entry && now - entry.fetchedAt <= (opts.ttlMs ?? CACHE_TTL_MS) && entry.fetchedAt <= now;
    if (fresh && Array.isArray(entry.trails)) return entry.trails;
  } catch {
    // A corrupt entry is a refetch.
  }

  const trails = (await queryTypedRecords(client, 'BreadcrumbList'))
    .map((r) => parseTrail(r, origin))
    .filter((t): t is SiteTrail => t !== null);
  try {
    storage?.setItem(key, JSON.stringify({ fetchedAt: now, trails }));
  } catch {
    // Full or blocked storage costs a refetch on the next page, nothing more.
  }
  return trails;
}

/** The tool's registered name. */
export const PAGE_LINKS_TOOL = 'page_links';

/** Where a listing stops, so an answer stays readable. */
const MAX_LISTED = 10;

const list = (label: string, links: NavLink[]): string[] =>
  links.length ? [`${label}: ${links.slice(0, MAX_LISTED).map((l) => l.name).join(', ')}`] : [];

/**
 * What the agent can say about where it is.
 *
 * Read rather than navigation: "what else is in this section" is a question,
 * and answering it by opening a page would be answering a different one. The
 * names it returns are the names {@link buildOpenPageTool} accepts, so the
 * model can follow one with the other.
 *
 * Always answers. "Where am I" is answerable from the address bar alone, so a
 * site that publishes no trails and links nothing still gets the page it is on
 * — an agent that cannot say that reads as an agent with no idea where it is.
 */
export function describeNav(nav: SiteNav, href: string): string {
  const { ancestors, siblings, children, links } = navFor(nav, href);
  const trail = [...nav.trails.entries()].find(([page]) => samePage(page, href))?.[1];
  const known = nav.pages.length;
  const lines = [
    `You are on ${nameOf(href, nav)} (${pathOf(href, nav)})` +
      (known ? `, one of ${known} page${known === 1 ? '' : 's'} on this site.` : '.'),
    ...(trail?.length ? [`Trail: ${trail.map((l) => l.name).join(' › ')}`] : []),
    ...list('Above', ancestors),
    ...list('Also in this section', siblings),
    ...list('Under this page', children),
    ...list('Linked from here', links),
  ];
  if (lines.length > 1) return lines.join('\n');
  const elsewhere = nav.pages.filter((p) => !samePage(p.url, href)).slice(0, MAX_LISTED);
  return elsewhere.length
    ? `${lines[0]} This site publishes no sections, so there is nothing above or beside it. Other pages: ${elsewhere
        .map((p) => p.name)
        .join(', ')}.`
    : `${lines[0]} Nothing else on the site links to or from it.`;
}

/**
 * The address as a visitor reads it, which is what "what page is this" asks for.
 *
 * The path of the page the site actually publishes, when one matches. A query a surface put there
 * — `?surface=window`, `?open=1` — belongs to this tab, not to the site: nothing is indexed under
 * it, and quoting it back invites the model to ask for a page by an address no record carries.
 */
function pathOf(href: string, nav: SiteNav): string {
  const known = nav.pages.find((p) => samePage(p.url, href));
  try {
    // A published page's own query is part of its address; the tab's is not, and with no record to
    // say otherwise, the path alone is the page.
    if (known) {
      const url = new URL(known.url);
      return url.pathname + url.search;
    }
    return new URL(href).pathname;
  } catch {
    return known?.url ?? href;
  }
}

/** Options for the page-links tool: where the visitor is, and how the graph fills in. */
export interface PageLinksOptions {
  /** The current page URL. Defaults to the browser's. Read when the tool runs. */
  href?: () => string;
  /**
   * Fetch the site's trails, if they have not been fetched yet.
   *
   * Awaited when the tool runs rather than at connect, because the fetch is a
   * read and a site's rate limit counts reads. Answering "where am I" is what
   * makes that read worth spending.
   */
  loadNav?: () => Promise<SiteNav>;
}

/**
 * Build the tool that reports where this page sits and what it leads to.
 *
 * @param nav - The site's graph.
 */
export function buildPageLinksTool(nav: SiteNav, opts: PageLinksOptions = {}): ModelContextTool {
  return {
    name: PAGE_LINKS_TOOL,
    description:
      'Where the visitor is right now and what this page leads to: the page they are on, the sections ' +
      'above it, the other pages in its section, the pages under it, and the pages it links to. Use for ' +
      '"where am I", "what page is this" and "what else is here", and before offering to take them somewhere.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const filled = (await opts.loadNav?.().catch(() => nav)) ?? nav;
      return {
        content: [
          {
            type: 'text',
            text: describeNav(filled, opts.href?.() ?? (typeof location === 'undefined' ? '' : location.href)),
          },
        ],
      };
    },
  } as ModelContextTool;
}

/**
 * Register the page-links tool, unless the registry already holds one.
 *
 * Registered whatever the site publishes. It was once gated on the site having
 * trails or links, which withheld the tool from exactly the sites where "where
 * am I" is the only question it could answer.
 *
 * @returns Whether it was registered.
 */
export async function registerPageLinksTool(
  mc: ModelContext,
  nav: SiteNav,
  opts: PageLinksOptions = {},
): Promise<boolean> {
  try {
    if ((await mc.getTools()).some((t) => t.name === PAGE_LINKS_TOOL)) return false;
  } catch {
    // A registry that cannot list may still register.
  }
  try {
    await mc.registerTool(buildPageLinksTool(nav, opts));
    return true;
  } catch (err) {
    console.warn(`[nxis] could not register ${PAGE_LINKS_TOOL}:`, err);
    return false;
  }
}
