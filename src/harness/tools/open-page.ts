/**
 * A tool for taking the visitor to a page on the site.
 *
 * "Take me to that page" is a request the agent should be able to carry out.
 * Without a tool for it a model reaches for whatever it has — a lookup — and
 * nothing moves. This one opens a page by name, from the pages the site
 * reported — or home, or back to the page before — and carries the conversation
 * across so it continues there.
 *
 * It reads nothing and submits nothing, so it runs without a confirmation, and
 * it never leaves the origin.
 *
 * @module
 */
import { samePage } from './site-actions.js';
import { findPage, type SitePage } from './site-pages.js';
import { nameOf, navFor, parentOf, type NavLink, type SiteNav } from './site-nav.js';
import { savePendingVisit } from './pending-action.js';
import { HANDOFF_RESULT } from './action-tools.js';
import { journeySteps } from '../steps.js';
import type { JsonSchema, ModelContext, ModelContextTool, ModelContextToolInfo, ModelContextToolResponse } from '../../types.js';

/** The tool's registered name. */
export const OPEN_PAGE_TOOL = 'open_page';

/** Past this many pages the names are described rather than listed. */
const MAX_LISTED = 40;

/** Where the tool takes the visitor, and how to go. */
export interface OpenPageOptions {
  /** The site's origin. Defaults to the page's own. */
  origin?: string;
  /** The current page URL. Defaults to the browser's. */
  href?: string;
  /** Where the visit waits while the browser moves. Defaults to `sessionStorage`. */
  storage?: Storage | null;
  /** How to go to another page. Defaults to assigning `location`. */
  navigate?: (url: string) => void;
  /** How to return to the previous page. Defaults to `history.back()`. */
  back?: () => void;
  /** The page the visitor came from. Defaults to `document.referrer`. Read when the tool runs. */
  referrer?: () => string;
  /** The conversation to continue on arrival. Read when the tool runs. */
  conversationId?: () => string | undefined;
  /**
   * The site's graph, from its breadcrumb trails and page links.
   *
   * What makes "up a level" and "the section above" mean something, and what
   * keeps the tool's list of destinations to the pages near this one rather
   * than every page on the site.
   */
  nav?: SiteNav;
  /**
   * Fetch the trails the graph is missing, if they have not been fetched yet.
   *
   * Awaited when the tool runs, not at connect: the fetch is a read, and a
   * site's rate limit counts reads. Going somewhere is what makes it worth one.
   */
  loadNav?: () => Promise<SiteNav>;
}

/** What the visitor says for the site's home page: "home", "take me to the home page". */
const HOME =
  /^(?:(?:go|take\s+me|return)\s+(?:to\s+)?)?(?:the\s+)?(?:home|homepage|home\s*page|start(?:\s*page)?|main\s*page|front\s*page|landing\s*page|index)$/i;
/** What the visitor says for the page they came from: "back", "go back to the previous page". */
const BACK =
  /^(?:(?:go|take\s+me|return|head)\s+)?back(?:\s+to)?(?:\s+(?:the\s+)?(?:previous|last)\s+page)?$|^(?:the\s+)?(?:previous|last)\s+page$|^where\s+i\s+was$/i;

/** What the visitor says for the page above this one: "up", "the section above". */
const UP =
  /^(?:(?:go|take\s+me|move)\s+)?(?:up|upward)(?:\s+(?:a|one)\s+level)?$|^(?:the\s+)?(?:parent|section|category)(?:\s+(?:page|above))?$|^(?:go\s+)?up\s+to\s+(?:the\s+)?(?:parent|section|category)$/i;

/** A page's name compared the way a person would. */
const normalName = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Where a request to open a page resolves: a page, and whether it is reached by going back. */
export type Destination =
  | { kind: 'page' | 'home'; url: string; label: string }
  | { kind: 'back'; url: string; label: string }
  | { kind: 'none'; reason: string };

/** The pages and options the tool was built with, so the harness can name a destination. */
let known: { pages: SitePage[]; origin: string; opts: OpenPageOptions } = { pages: [], origin: '', opts: {} };

const here = (href?: string): string => href ?? (typeof location === 'undefined' ? '' : location.href);
const originOf = (origin?: string): string => origin ?? (typeof location === 'undefined' ? '' : location.origin);
const referrerOf = (opts: OpenPageOptions): string =>
  opts.referrer?.() ?? (typeof document === 'undefined' ? '' : document.referrer);

const text = (t: string, isError = false): ModelContextToolResponse => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Where a request to open a page goes.
 *
 * A page by name or address, and two that no site lists by name: "home", the
 * site's root, and "back", the page the visitor came from — only when that was
 * a page of this site, since going back must not leave it.
 *
 * @param wanted - What the visitor or model asked for.
 * @param pages - The site's pages.
 * @param origin - The site's origin.
 * @param opts - The referrer seam.
 */
export function resolveDestination(
  wanted: string,
  pages: SitePage[],
  origin: string,
  opts: OpenPageOptions = {},
): Destination {
  const w = wanted.trim();
  const named = (url: string): string | undefined => pages.find((p) => samePage(p.url, url))?.name;

  // A page actually called that wins: "Back Office Plumbing" is a page, not a direction.
  const exact = pages.filter((p) => normalName(p.name) === normalName(w));
  if (exact.length === 1) return { kind: 'page', url: exact[0].url, label: exact[0].name };

  if (UP.test(w)) {
    const above = opts.nav && parentOf(here(opts.href), opts.nav);
    return above
      ? { kind: 'page', url: above, label: nameOf(above, opts.nav!) }
      : { kind: 'none', reason: 'This page is not under a section I know of.' };
  }

  // Somewhere this page leads: a section above it, a page beside it, or a page it links to. Named
  // by the site's own name for it, which is how the visitor heard of it.
  const near = opts.nav ? nearby(opts.nav, here(opts.href)) : [];
  const calledThat = near.filter((l) => normalName(l.name) === normalName(w));
  if (calledThat.length === 1) return { kind: 'page', url: calledThat[0].url, label: calledThat[0].name };

  if (BACK.test(w)) {
    const from = referrerOf(opts);
    let sameSite = false;
    try {
      sameSite = !!from && new URL(from).origin === new URL(origin).origin;
    } catch {
      sameSite = false;
    }
    return sameSite
      ? { kind: 'back', url: from, label: named(from) ?? 'the previous page' }
      : { kind: 'none', reason: 'There is no previous page on this site to go back to.' };
  }

  if (HOME.test(w)) {
    const root = new URL('/', origin).href;
    const home = pages.find((p) => ['/', '/index.html', '/index.htm'].includes(new URL(p.url).pathname));
    return { kind: 'home', url: home?.url ?? root, label: home ? `the home page (${home.name})` : 'the home page' };
  }

  const found = findPage(w, pages, origin);
  if (found) return { kind: 'page', url: found.url, label: found.name };
  const loose = near.filter((l) => normalName(l.name).includes(normalName(w)));
  if (loose.length === 1) return { kind: 'page', url: loose[0].url, label: loose[0].name };
  const some = [...new Set([...near.map((l) => l.name), ...pages.map((p) => p.name)])].slice(0, 8).join(', ');
  return {
    kind: 'none',
    reason: `There is no page called "${w}" on this site${some ? `. Pages include: ${some}` : ''}.`,
  };
}

/**
 * Build the page-opening tool for a site's pages.
 *
 * @param pages - Every page the agent may open.
 * @param opts - Origin, current page, and the navigation seams.
 * @returns The definition to register.
 */
export function buildOpenPageTool(pages: SitePage[], opts: OpenPageOptions = {}): ModelContextTool {
  const origin = originOf(opts.origin);
  known = { pages, origin, opts };
  // Near first: a page's own surroundings are what a visitor asks for, and every name here reaches
  // the prompt. The rest of the site stays reachable by name, and the description says so.
  const near = opts.nav ? nearby(opts.nav, here(opts.href)).map((l) => l.name) : [];
  const names = [...new Set([...near, ...pages.map((p) => p.name)])];
  const listed = names.length <= MAX_LISTED ? names : [...new Set(near)].slice(0, MAX_LISTED);
  const page: JsonSchema = {
    type: 'string',
    description:
      (names.length <= MAX_LISTED
        ? 'The page to open, by name.'
        : 'The page to open: the name of the business, listing or record it is about. Any page of the site by name, not only those listed.') +
      ' Use "home" for the home page, "back" for the page the visitor was on before, and "up" for the section above this page.',
  };
  if (listed.length) page.enum = ['home', 'back', ...(opts.nav || opts.loadNav ? ['up'] : []), ...listed];

  return {
    name: OPEN_PAGE_TOOL,
    description:
      'Take the visitor to a page on this site. Use when they ask to go to, open, visit or see a page — ' +
      'for example the page of a result you found, the home page, or back to the previous page.',
    inputSchema: { type: 'object', properties: { page }, required: ['page'] },
    annotations: { readOnlyHint: true },
    execute: async (input: Record<string, unknown>) => {
      const filled = await opts.loadNav?.().catch(() => opts.nav);
      const to = resolveDestination(String(input?.page ?? ''), pages, origin, {
        ...opts,
        nav: filled ?? opts.nav,
      });
      if (to.kind === 'none') return text(to.reason, true);
      if (samePage(to.url, here(opts.href))) return text(`You are already on ${to.label}.`);

      savePendingVisit(
        { pageUrl: to.url, label: to.label, conversationId: opts.conversationId?.(), steps: journeySteps() },
        { storage: opts.storage },
      );
      if (to.kind === 'back') (opts.back ?? (() => history.back()))();
      else (opts.navigate ?? ((url: string) => location.assign(url)))(to.url);
      return {
        content: [{ type: 'text', text: `Opening ${to.label}…` }],
        structuredContent: { [HANDOFF_RESULT]: { pageUrl: to.url, label: to.label } },
      };
    },
  } as ModelContextTool;
}

/**
 * Everywhere this page leads: the sections above it, the pages beside and under
 * it, and the pages it points at. Ancestors first, because "up" and "the
 * section" are what a visitor asks for most.
 */
function nearby(nav: SiteNav, href: string): NavLink[] {
  const { ancestors, siblings, children, links } = navFor(nav, href);
  const seen = new Set<string>();
  return [...ancestors, ...children, ...links, ...siblings].filter((l) =>
    seen.has(l.url) ? false : (seen.add(l.url), true),
  );
}

/**
 * Where a call to the page-opening tool goes, before it runs.
 *
 * @returns The destination, or null when the tool is another one, the page is
 * unknown, or it is the page already open.
 */
export function visitFor(
  tool: Pick<ModelContextToolInfo, 'name'>,
  values: Record<string, unknown>,
  href?: string,
): { pageUrl: string; label: string } | null {
  if (tool.name !== OPEN_PAGE_TOOL) return null;
  const to = resolveDestination(String(values?.page ?? ''), known.pages, known.origin || originOf(), known.opts);
  if (to.kind === 'none' || samePage(to.url, here(href ?? known.opts.href))) return null;
  return { pageUrl: to.url, label: to.label };
}

/**
 * Register the page-opening tool, unless the registry already holds one.
 *
 * @returns Whether it was registered.
 */
export async function registerOpenPageTool(
  mc: ModelContext,
  pages: SitePage[],
  opts: OpenPageOptions = {},
): Promise<boolean> {
  // Registered with no pages too: "home" and "back" need no list, and a site whose page records
  // could not be read is exactly where a visitor still wants to get home.
  const tool = buildOpenPageTool(pages, opts);
  try {
    if ((await mc.getTools()).some((t) => t.name === OPEN_PAGE_TOOL)) return false;
  } catch {
    // A registry that cannot list may still register.
  }
  try {
    await mc.registerTool(tool);
    return true;
  } catch (err) {
    console.warn(`[nxis] could not register ${OPEN_PAGE_TOOL}:`, err);
    return false;
  }
}
