/**
 * Assembles the page's toolset from both of its sources.
 *
 * Tools come from two places: those registered on the page itself, and those
 * from a remote MCP server discovered through `.well-known` and bridged in.
 * Both end up in `document.modelContext`, so the harness discovers them with a
 * single call and treats them alike, distinguishing only read from write via
 * each tool's annotations.
 *
 * {@link connectTools} is awaited rather than run as a load-time side effect,
 * so a caller knows when the toolset is complete.
 *
 * @module
 */

import { hasCachedTools, registerRemoteTools, type BridgeOptions } from './bridge.js';
import { ensureModelContext } from './local-context.js';
import { connectMcp } from './client.js';
import { discoverMcpServer } from './discovery.js';
import { findEmbeddedAction, loadSiteActions, type SiteActionsOptions } from './site-actions.js';
import { registerSiteActionTools, reportFor, setPageTitles } from './action-tools.js';
import { setPageOpenReporter, setSiteActionReporter, takeReportToken, TRACK_TOOL } from './report.js';
import { loadSitePages, mergePages, pagesFromActions, type SitePage } from './site-pages.js';
import { registerOpenPageTool, OPEN_PAGE_TOOL, type OpenPageOptions } from './open-page.js';
import {
  applyTrails,
  buildNav,
  loadSiteTrails,
  registerPageLinksTool,
  PAGE_LINKS_TOOL,
  type SiteNav,
} from './site-nav.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServerInfo, ModelContext } from '../../types.js';
import type { NxisAction } from '../../webmcp-contract.js';

const READY_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 200;

/** The outcome of {@link connectTools}. */
export interface ConnectResult {
  /** The registry the tools were registered into, or null if none was found. */
  modelContext: ModelContext | null;
  /** Remote tool names bridged in. Empty when discovery failed or was skipped. */
  remoteTools: string[];
  /**
   * Every Action on the site, from any page, that belongs to this origin.
   *
   * Empty when discovery failed, the query failed, or it was turned off with
   * {@link ConnectOptions.siteActions}.
   */
  siteActions: NxisAction[];
  /**
   * The tools registered for {@link siteActions}.
   *
   * Fewer than the actions: those that share a name and a set of fields become
   * one tool that chooses between them.
   */
  siteTools: string[];
  /**
   * The site's pages the agent can open and link results to: its page
   * records, and the pages its actions live on.
   */
  sitePages: SitePage[];
  /**
   * The site's graph: which pages sit under which, and what points at what,
   * from its breadcrumb trails and its pages' links. Empty when the site
   * publishes no trails and its pages link nothing.
   */
  siteNav?: SiteNav;
  /**
   * Where the site's MCP server builds an event's calendar file (`<calendar><base64url of its @id>.ics`): beside its
   * endpoint, at `/ics/`. Only for a server a browser can reach without a key, since a browser opens the file.
   */
  calendar?: string;
  /** Why remote tools or site actions are absent, when they are. Never fatal. */
  warning?: string;
}

/** Where a server builds calendar files, from its endpoint: `…/mcp` → `…/ics/`. As the NxisAI app's `calendarBase`. */
export function calendarBase(info: Pick<McpServerInfo, 'endpoint' | 'authRequired'>): string | undefined {
  const e = info.endpoint?.trim();
  if (!e || info.authRequired || !/^https?:\/\/\S+$/i.test(e)) return undefined;
  return `${e.replace(/\/+$/, '').replace(/\/mcp$/, '')}/ics/`;
}

/** The page's model context, from either of the two places it may appear. */
function getModelContext(): ModelContext | null {
  return document.modelContext ?? navigator.modelContext ?? null;
}

/**
 * Wait for a WebMCP provider to appear on the page.
 *
 * @param timeout - How long to wait, in milliseconds.
 * @returns The model context, or null if none appears in time.
 */
export function waitForModelContext(timeout = READY_TIMEOUT_MS): Promise<ModelContext | null> {
  const immediate = getModelContext();
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const mc = getModelContext();
      if (mc) {
        clearInterval(iv);
        resolve(mc);
      } else if (Date.now() - started > timeout) {
        clearInterval(iv);
        resolve(null);
      }
    }, POLL_INTERVAL_MS);
  });
}

/** Options for {@link connectTools}. */
export interface ConnectOptions {
  /** How long to wait for a WebMCP provider before falling back. */
  timeout?: number;
  /**
   * Register into a local registry when the page has no WebMCP provider.
   *
   * Defaults to true, so a working MCP server still yields tools on a page with
   * no WebMCP implementation. Pass false to require a real provider.
   */
  fallback?: boolean;
  /** Override which of the server's tools are bridged in. */
  accept?: BridgeOptions['accept'];
  /**
   * Fetch the site's Actions from every page, not only this one.
   *
   * Defaults to true. Pass false to skip the query, or an options object to
   * override the origin check or the cache.
   */
  siteActions?: boolean | SiteActionsOptions;
  /**
   * Register `open_page`, so the agent can take the visitor to a page.
   *
   * Defaults to true when site actions are fetched. Pass false to leave it
   * out, or options to supply the conversation to continue on arrival.
   */
  openPage?: boolean | OpenPageOptions;
}

/**
 * Wait for a tool registry, then bridge in a remote MCP server's tools.
 *
 * Every remote failure is caught and reported as
 * {@link ConnectResult.warning}: discovery, CORS and network problems leave the
 * page's own tools working, and a site with no MCP server is an ordinary case
 * rather than an error.
 *
 * Connects each registry once. A second call for the same registry, such as a
 * page script and the element both connecting, returns the first call's result
 * rather than registering the same tools again, which a native `modelContext`
 * rejects as a duplicate.
 *
 * @param apiKey - Key for the remote server's private tools. Public tools need
 * none, and the element never supplies one: a key readable in the page is a
 * published key. Pass one only where it is short-lived and scoped, such as a
 * token your backend mints per session.
 * @param opts - Timeout, local-registry fallback, and a tool filter. Only the
 * first call's options apply to a registry.
 * @returns The registry, the remote tools bridged in, and any warning.
 */
export async function connectTools(
  apiKey?: string,
  opts: ConnectOptions = {},
): Promise<ConnectResult> {
  const waited = await waitForModelContext(opts.timeout ?? READY_TIMEOUT_MS);
  const mc = waited ?? (opts.fallback === false ? null : ensureModelContext());
  if (!mc) {
    return {
      modelContext: null,
      remoteTools: [],
      siteActions: [],
      siteTools: [],
      sitePages: [],
      warning: 'WebMCP (document.modelContext) unavailable — no tools registered.',
    };
  }

  let connection = connections.get(mc);
  if (!connection) {
    connection = connectRegistry(mc, apiKey, opts);
    connections.set(mc, connection);
  }
  return connection;
}

/** One connection per registry, shared by every caller. */
const connections = new WeakMap<ModelContext, Promise<ConnectResult>>();

async function connectRegistry(
  mc: ModelContext,
  apiKey: string | undefined,
  opts: ConnectOptions,
): Promise<ConnectResult> {
  let info: McpServerInfo;
  let client: Client;
  let remoteTools: string[];
  try {
    info = await discoverMcpServer();
    // A key's tool list may hold private tools, so it is never kept in the tab.
    const storage = apiKey ? null : undefined;
    const lazy = lazyClient(() => connectMcp(info, apiKey));
    client = lazy;
    // The first page of a session connects now, so a server that won't connect leaves the navigation tools only.
    // After that every read connecting needs is kept in the tab (the server, its tools, the site's actions and
    // pages), so a page load registers them all without a request, and the session opens when a tool first runs.
    if (!hasCachedTools(info, storage)) await lazy.ready();
    remoteTools = await registerRemoteTools(client, mc, info, { accept: opts.accept, storage });
  } catch (err) {
    // No server, so no page list — but the address bar still says where the visitor is, and
    // "home" and "back" need nothing else. An unreachable corpus is not a reason to lose those.
    if (opts.openPage !== false) await registerNavigationOnly(mc, opts.openPage);
    return {
      modelContext: mc,
      remoteTools: [],
      siteActions: [],
      siteTools: [],
      sitePages: [],
      warning: `remote tool bootstrap failed — on-page tools still work: ${errorText(err)}`,
    };
  }

  const calendar = calendarBase(info);
  if (opts.siteActions === false) {
    return { modelContext: mc, remoteTools, siteActions: [], siteTools: [], sitePages: [], ...(calendar ? { calendar } : {}) };
  }

  const siteOpts = typeof opts.siteActions === 'object' ? opts.siteActions : {};

  // Each read stands on its own. They used to share one `try`, so a corpus the server was rate
  // limiting took the navigation tools down with it: the agent lost the tool that says which page
  // it is on — a question needing no read at all — because a different query had failed.
  let siteActions: NxisAction[] = [];
  let siteTools: string[] = [];
  let warning: string | undefined;
  try {
    siteActions = await loadSiteActions(client, info, siteOpts);
  } catch (err) {
    warning = `site actions unavailable — this page's own actions still work: ${errorText(err)}`;
    console.warn(`[nxis] ${warning}`);
  }

  // The page records before the tools are built: a form on many pages offers each by its page's title (the
  // event's name), which is known only once they are read.
  const records = await pageRecords(client, info, siteOpts);
  // The records' own titles name a form's page in what the visitor reads; names made from a path never do.
  setPageTitles(records);

  try {
    siteTools = await registerSiteActionTools(mc, siteActions, {
      // A form the index holds only inside its business or page, looked up when a call names it.
      findAction: (query) => findEmbeddedAction(client, { ...query, origin: siteOpts.origin }),
    });
  } catch (err) {
    warning = `site actions unavailable — this page's own actions still work: ${errorText(err)}`;
    console.warn(`[nxis] ${warning}`);
  }

  reportTo(client, siteActions);

  const site = await connectPages(mc, client, info, siteActions, records, siteOpts, opts.openPage);
  return { modelContext: mc, remoteTools, siteActions, siteTools, sitePages: site.pages, siteNav: site.nav, ...(calendar ? { calendar } : {}), warning };
}

/**
 * Count the site's forms the agent sends, and the pages its media buttons open, in its Agent Analytics, through
 * its own server.
 */
function reportTo(client: Client, actions: NxisAction[]): void {
  setSiteActionReporter((run) => {
    const report = reportFor(actions, run);
    if (!report) return undefined;
    // A visitor handed here from the NxisAI app brings the site's token for the action: the report counts as verified.
    const token = takeReportToken(report.action_id);
    return client.callTool({ name: TRACK_TOOL, arguments: { ...report, ...(token ? { report_token: token } : {}) } });
  });
  // Listen, Subscribe and "Their page" open a page rather than send a form, so they don't go through reportFor():
  // the button already carries the action's type, @id and the site's token.
  setPageOpenReporter((report) => client.callTool({ name: TRACK_TOOL, arguments: { ...report } }));
}

/**
 * The site's pages, and the tool that opens them.
 *
 * A failed page query is not worth a warning of its own: the pages the
 * actions live on still make a usable list.
 */
async function connectPages(
  mc: ModelContext,
  client: Client,
  info: McpServerInfo,
  actions: NxisAction[],
  records: SitePage[],
  siteOpts: SiteActionsOptions,
  openPage: ConnectOptions['openPage'],
): Promise<{ pages: SitePage[]; nav: SiteNav }> {
  const origin = siteOpts.origin ?? location.origin;
  const pages = mergePages(records, pagesFromActions(actions, origin));
  if (!pages.length) {
    // Registered anyway: "where am I", "home" and "back" are answerable from the address bar, and a
    // page list that failed to load is the moment a visitor most needs them.
    console.info('[nxis] no page records; navigation is by address');
  }

  // The pages and what they link, now; the hierarchy on demand. Connecting already spends two
  // reads (actions, pages), and a site's rate limit counts them — the public plan allows three a
  // minute, so a third here would leave the visitor's first question waiting on the limit. The
  // trails are fetched the first time navigation needs them, and folded into this same graph.
  const nav = buildNav(pages, [], origin);
  let trails: Promise<SiteNav> | null = null;
  const loadNav = (): Promise<SiteNav> =>
    (trails ??= loadSiteTrails(client, info, siteOpts)
      .then((found) => {
        console.info(`[nxis] ${found.length} breadcrumb trail(s)`);
        return applyTrails(nav, found);
      })
      .catch((err) => {
        // Asked again next time: a rate limit now is not a site without trails.
        trails = null;
        console.warn(`[nxis] breadcrumb trails unavailable, navigation is by name: ${errorText(err)}`);
        return nav;
      }));

  if (openPage !== false) {
    const registered = await registerOpenPageTool(mc, pages, {
      origin,
      nav,
      loadNav,
      ...(typeof openPage === 'object' ? openPage : {}),
    });
    if (registered) console.info(`[nxis] ${OPEN_PAGE_TOOL}: ${pages.length} page(s)`);
    const links = await registerPageLinksTool(mc, nav, { loadNav });
    if (links) console.info(`[nxis] ${PAGE_LINKS_TOOL}: where the visitor is, and what leads where`);
  }
  return { pages, nav };
}

/**
 * The site's page records. A failed query is not worth a warning of its own: the pages the actions live on still
 * make a usable list.
 */
async function pageRecords(client: Client, info: McpServerInfo, siteOpts: SiteActionsOptions): Promise<SitePage[]> {
  try {
    return await loadSitePages(client, info, siteOpts);
  } catch (err) {
    console.warn(`[nxis] page records unavailable, using action pages only: ${errorText(err)}`);
    return [];
  }
}

/** A client that opens its session on first use: once, again after a failure. */
function lazyClient(open: () => Promise<Client>): Client & { ready(): Promise<Client> } {
  let session: Promise<Client> | null = null;
  const ready = (): Promise<Client> =>
    (session ??= open().catch((err) => {
      session = null;
      throw err;
    }));
  return {
    ready,
    callTool: (...a: Parameters<Client['callTool']>) => ready().then((c) => c.callTool(...a)),
    listTools: (...a: Parameters<Client['listTools']>) => ready().then((c) => c.listTools(...a)),
  } as unknown as Client & { ready(): Promise<Client> };
}

/** The navigation tools with nothing but the page's own address to go on. */
async function registerNavigationOnly(mc: ModelContext, openPage: ConnectOptions['openPage']): Promise<void> {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const nav = buildNav([], [], origin);
  await registerOpenPageTool(mc, [], { origin, nav, ...(typeof openPage === 'object' ? openPage : {}) });
  await registerPageLinksTool(mc, nav);
}

const errorText = (err: unknown): string => String((err as Error)?.message || err);

export { discoverMcpServer, connectMcp, registerRemoteTools, loadSiteActions };
export {
  registerSiteActionTools,
  buildSiteActionTools,
  withoutShadowedTools,
  handoffFor,
  findPageTool,
  awaitPageTool,
  pageToolRef,
  siteToolName,
  selectSiteTools,
  readsOnly,
  resultsUrl,
  pageTitle,
  formNoun,
} from './action-tools.js';
export { resumePendingAction } from './resume.js';
export {
  loadSitePages,
  parsePage,
  pagesFromActions,
  mergePages,
  pageForEntity,
  findPage,
} from './site-pages.js';
export type { SitePage, SitePagesOptions } from './site-pages.js';
export { buildOpenPageTool, registerOpenPageTool, resolveDestination, visitFor, OPEN_PAGE_TOOL } from './open-page.js';
export {
  applyTrails,
  buildNav,
  buildPageLinksTool,
  describeNav,
  loadSiteTrails,
  nameOf,
  navFor,
  parentOf,
  parseTrail,
  registerPageLinksTool,
  PAGE_LINKS_TOOL,
} from './site-nav.js';
export type { NavLink, PageNav, SiteNav, SiteTrail, SiteTrailsOptions, TrailLevel } from './site-nav.js';
export type { OpenPageOptions, Destination } from './open-page.js';
export type { ResumeOutcome, ResumeOptions } from './resume.js';
export type { SiteActionTool, Handoff, PageToolRef } from './action-tools.js';
export {
  savePendingAction,
  takePendingAction,
  clearPendingAction,
  savePendingVisit,
  takePendingVisit,
  setConversationSource,
} from './pending-action.js';
export type { PendingAction, PendingVisit } from './pending-action.js';
export { parseAction, samePage, sameActionPage } from './site-actions.js';
export type { SiteActionsOptions } from './site-actions.js';
export { ensureModelContext, LocalModelContext } from './local-context.js';
export { reportPageOpen, pageOpenReport, setPageOpenReporter, MEDIA_PLAY_OUTCOME } from './report.js';
export type { PageOpenTap, PageOpenReport, PageOpenReporter } from './report.js';
