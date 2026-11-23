/**
 * Tells the site's MCP server that a form the agent filled went through.
 *
 * A page's own form submits to the site, not to NxisAI, so the server never
 * sees it happen. Agent Analytics counts these reports as conversions
 * (`nxis_track_site_action`, outcome `submitted`), next to the actions the
 * server runs itself.
 *
 * A report names the action and nothing else: never a value the visitor typed.
 * It is best effort — a site whose server cannot take it, or a report that
 * fails, never changes what the visitor sees.
 *
 * @module
 */
import type { ModelContextToolInfo, ModelContextToolResponse } from '../../types.js';

/** The server tool a report goes to. Kept from the model: it reports what happened, it is not something to do. */
export const TRACK_TOOL = 'nxis_track_site_action';

/** The `@id` of the action a page tool came from, where the page records it. */
export const ACTION_ID_HINT = 'ai.nxis/actionId';

/** What a report says. Closed fields only, so nothing the visitor typed can ride along. */
export interface SiteActionReport {
  outcome: 'submitted';
  action_id: string;
  action_type?: string;
  source: 'on_page_agent';
  /** The site's signature on the answer that led here, when the visitor came by a handoff link. */
  report_token?: string;
}

/**
 * A page tool that ran and went through. The action's `@id` when the registry
 * kept it: a spec registry keeps only the four standard hints, so on native
 * Chrome the tool's name, on its own page, is all there is to go on.
 */
export interface PageFormRun {
  actionId?: string;
  toolName: string;
}

/** Turns a run into a report and sends it, or ignores a run that was no action of the site's. */
export type SiteActionReporter = (run: PageFormRun) => Promise<unknown> | unknown;

let reporter: SiteActionReporter | null = null;

/** Runs that finished before there was a reporter to take them, oldest first. */
let held: PageFormRun[] = [];

/** More than a page ever finishes before its server connects; past it, the oldest go. */
const MAX_HELD = 10;

/**
 * Where reports go: the site's server, once it is connected. `null` stops
 * reporting, which is the state until a server is found.
 *
 * Runs {@link reportFormRun} held while there was none go to the first
 * reporter set.
 */
export function setSiteActionReporter(next: SiteActionReporter | null): void {
  reporter = next;
  if (!next || !held.length) return;
  const waiting = held;
  held = [];
  for (const run of waiting) send(next, run);
}

/** Hand one run to a reporter, swallowing whatever it does wrong. */
function send(to: SiteActionReporter, run: PageFormRun): void {
  try {
    void Promise.resolve(to(run)).catch(() => {});
  } catch {
    // The visitor's submission stands whether or not it was counted.
  }
}

/**
 * Report a form that went through without its page tool running: a handoff
 * target that took the form's place and resolved it (see `takes` in
 * docs/handoff.md).
 *
 * The hand-back can arrive before the site's server is connected — a handoff
 * resumed on the next page finishes as the page loads — so a run with no
 * reporter yet is held, in memory, for the first one set. Held runs die with
 * the page: a site with no server never reports, as before.
 */
export function reportFormRun(run: PageFormRun): void {
  if (reporter) {
    send(reporter, run);
    return;
  }
  held.push(run);
  if (held.length > MAX_HELD) held.splice(0, held.length - MAX_HELD);
}

/**
 * Report a page tool's run if it went through. Whether it was one of the
 * site's actions is the reporter's to decide; a form that refused the input,
 * or failed, is never reported.
 */
export function reportSubmitted(
  tool: ModelContextToolInfo | null,
  name: string,
  res: ModelContextToolResponse | null,
): void {
  if (!reporter || !res || res.isError) return;
  const hint = tool?.annotations?.[ACTION_ID_HINT];
  const run: PageFormRun = { toolName: tool?.name || name, ...(typeof hint === 'string' && hint ? { actionId: hint } : {}) };
  send(reporter, run);
}

/** Where held report tokens live: the tab's session, so a form finished on another page still has its token. */
const TOKENS_KEY = 'nxis:report-tokens';

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readTokens(storage: Storage | null): Record<string, string> {
  try {
    const parsed = JSON.parse(storage?.getItem(TOKENS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeTokens(storage: Storage | null, tokens: Record<string, string>): void {
  try {
    if (Object.keys(tokens).length) storage?.setItem(TOKENS_KEY, JSON.stringify(tokens));
    else storage?.removeItem(TOKENS_KEY);
  } catch {
    // Unverified is still counted; a token that cannot be held is only lost proof.
  }
}

/** Hold the token a handoff link brought for an action, until its form is sent. */
export function rememberReportToken(actionId: string, token: string, storage: Storage | null = sessionStore()): void {
  writeTokens(storage, { ...readTokens(storage), [actionId]: token });
}

/** Take the token held for an action, if any: it goes with one report and is then let go. */
export function takeReportToken(actionId: string, storage: Storage | null = sessionStore()): string | undefined {
  const tokens = readTokens(storage);
  const token = tokens[actionId];
  if (token === undefined) return undefined;
  delete tokens[actionId];
  writeTokens(storage, tokens);
  return typeof token === 'string' && token ? token : undefined;
}

// ── Media: the pages Listen, Subscribe and "Their page" open ─────────────────────────────────────────────────────

/**
 * What a tap that opens one of the site's pages reports. nxis_track_site_action takes only submitted, call,
 * page_open and handoff until telemetry counts `play`, so a Listen (or a play in the chat) reports the page it
 * stands for, and its `action_type` tells Listen from Subscribe, as the NxisAI app does.
 */
export const MEDIA_PLAY_OUTCOME = 'page_open' as const;

/**
 * What else a tap that opens a page can say: an event's Get tickets or Register is the intent to buy or register
 * (`purchase_start`, `register_start`). Only the site's own confirmation counts as a conversion.
 */
export const INTENT_OUTCOMES = ['purchase_start', 'register_start'] as const;

/** What a tap that opens a page reports. */
export type PageOpenOutcome = typeof MEDIA_PLAY_OUTCOME | (typeof INTENT_OUTCOMES)[number];

const OUTCOMES: readonly string[] = [MEDIA_PLAY_OUTCOME, ...INTENT_OUTCOMES];

/** A tap on a button that opens a page: the action it came from, when it came from one, and the site's token. */
export interface PageOpenTap {
  /** `page_open` unless it says otherwise. */
  outcome?: PageOpenOutcome;
  actionType?: string;
  actionId?: string;
  reportToken?: string;
}

/** What a page-open report says: closed fields only, as for forms. */
export interface PageOpenReport {
  outcome: PageOpenOutcome;
  action_type?: string;
  action_id?: string;
  report_token?: string;
  source: 'on_page_agent';
}

/** The report for a tap. A token goes only with the action it was signed for. */
export function pageOpenReport(tap: PageOpenTap): PageOpenReport {
  const type = typeof tap.actionType === 'string' && /^[A-Z][A-Za-z]*Action$/.test(tap.actionType) ? tap.actionType : undefined;
  const id = typeof tap.actionId === 'string' && tap.actionId ? tap.actionId : undefined;
  const token = id && typeof tap.reportToken === 'string' && tap.reportToken ? tap.reportToken : undefined;
  const outcome = tap.outcome && OUTCOMES.includes(tap.outcome) ? tap.outcome : MEDIA_PLAY_OUTCOME;
  return { outcome, ...(type ? { action_type: type } : {}), ...(id ? { action_id: id } : {}), ...(token ? { report_token: token } : {}), source: 'on_page_agent' };
}

/** Sends one page-open report: the site's server, once connected. */
export type PageOpenReporter = (report: PageOpenReport) => Promise<unknown> | unknown;

let pageOpenReporter: PageOpenReporter | null = null;
let heldOpens: PageOpenReport[] = [];

/** Where page-open reports wait while the browser goes to another page of the site; sent from there. */
const OPENS_KEY = 'nxis:page-opens';

function takeStoredOpens(storage: Storage | null): PageOpenReport[] {
  try {
    const parsed = JSON.parse(storage?.getItem(OPENS_KEY) ?? '[]') as unknown;
    storage?.removeItem(OPENS_KEY);
    return Array.isArray(parsed) ? (parsed.filter((r) => r && typeof r === 'object' && OUTCOMES.includes(r.outcome)) as PageOpenReport[]) : [];
  } catch {
    return [];
  }
}

function sendOpen(to: PageOpenReporter, report: PageOpenReport): void {
  try {
    void Promise.resolve(to(report)).catch(() => {});
  } catch {
    // The page opened whether or not it was counted.
  }
}

/**
 * Where page-open reports go: the site's server, once it is connected. Reports held in memory, and any a previous
 * page of this tab left in the session as it navigated here, go to the first reporter set.
 */
export function setPageOpenReporter(next: PageOpenReporter | null, storage: Storage | null = sessionStore()): void {
  pageOpenReporter = next;
  if (!next) return;
  const waiting = [...takeStoredOpens(storage), ...heldOpens];
  heldOpens = [];
  for (const r of waiting) sendOpen(next, r);
}

/**
 * Report a tap that opens one of the site's pages (Listen, Subscribe, "Their page"), best effort.
 *
 * @param opts.leaving - The tap navigates this tab away (another page of the site): the report waits in the
 * session and the next page sends it, since a request started now dies with this page.
 */
export function reportPageOpen(tap: PageOpenTap, opts: { leaving?: boolean; storage?: Storage | null } = {}): void {
  const report = pageOpenReport(tap);
  const storage = opts.storage === undefined ? sessionStore() : opts.storage;
  if (opts.leaving) {
    try {
      const queued = JSON.parse(storage?.getItem(OPENS_KEY) ?? '[]') as unknown;
      storage?.setItem(OPENS_KEY, JSON.stringify([...(Array.isArray(queued) ? queued : []), report].slice(-MAX_HELD)));
      return;
    } catch {
      // No session to hold it: try now.
    }
  }
  if (pageOpenReporter) return sendOpen(pageOpenReporter, report);
  heldOpens.push(report);
  if (heldOpens.length > MAX_HELD) heldOpens.splice(0, heldOpens.length - MAX_HELD);
}
