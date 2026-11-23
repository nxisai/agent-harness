/**
 * Arriving from somewhere else to use one of this page's forms.
 *
 * The NxisAI app in Claude or ChatGPT cannot fill a form that runs in the
 * browser, so for such an action it sends the person to the page instead:
 * `?nxis_handoff=<the action's @id>`, and optionally `&nxis_intent=<what they
 * want>`. On arrival the agent opens on that form.
 *
 * In the query, so the fragment, which some sites route by, is left alone. A
 * page's structured data is found by its registered address, so the site tag
 * leaves these two parameters out of the address it asks for.
 *
 * A link can be written by anyone, so it only ever chooses which of the page's
 * own forms to start. The words that start it are the agent's own, built from
 * the form; the intent is left in the composer for the person to send, change
 * or delete, never sent on their behalf. None of the parameters carries
 * anything personal, and all are taken out of the address bar once read.
 *
 * `&nxis_report=<token>` is the site's own signature on the answer the link came
 * from. It is held for the form, and sent back with the report that the form
 * went through, so the site counts the conversion as verified.
 *
 * @module
 */
import { awaitPageTool, withoutSiteSuffix } from './action-tools.js';
import { rememberReportToken } from './report.js';
import { waitForModelContext } from './source.js';
import type { ModelContext, ModelContextToolInfo } from '../../types.js';

/** The action to open on: its `@id`. */
export const HANDOFF_PARAM = 'nxis_handoff';
/** What the person wants, in a few words. Optional. */
export const INTENT_PARAM = 'nxis_intent';
/** The site's report token for the action, from the answer the link came from. Optional. */
export const REPORT_PARAM = 'nxis_report';

/** Longer than any `@id` the crawler writes; a longer value is not one. */
const MAX_ID = 512;
/** Longer than any token a site signs; a longer value is not one. */
const MAX_TOKEN = 1024;
/** A few words: enough for "a quote for a panel upgrade", not a message. */
export const MAX_INTENT = 120;

/** How long to wait for the registry, and then for the form's own tool. */
const WAIT_MS = 8000;

/** A handoff read from the address. */
export interface InboundHandoff {
  /** The `@id` of the action whose form to open. */
  actionId: string;
  /** What the person wants, cleaned up; absent when none was given. */
  intent?: string;
  /** The site's report token for the action; absent when the link had none. */
  reportToken?: string;
}

/**
 * The handoff in an address, if there is one.
 *
 * @param href - The page's address.
 * @returns The handoff, or null when there is none or it is malformed.
 */
export function readInboundHandoff(href: string): InboundHandoff | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const actionId = (url.searchParams.get(HANDOFF_PARAM) ?? '').trim();
  if (!actionId || actionId.length > MAX_ID || /\s/.test(actionId)) return null;
  const intent = cleanIntent(url.searchParams.get(INTENT_PARAM) ?? '');
  const token = (url.searchParams.get(REPORT_PARAM) ?? '').trim();
  const reportToken = token && token.length <= MAX_TOKEN && /^[A-Za-z0-9_.-]+$/.test(token) ? token : '';
  return { actionId, ...(intent ? { intent } : {}), ...(reportToken ? { reportToken } : {}) };
}

/** One line of plain text, at most {@link MAX_INTENT} characters. */
export function cleanIntent(raw: string): string {
  // Control characters, newlines included, become spaces: a draft is one line.
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_INTENT ? flat.slice(0, MAX_INTENT - 1).trimEnd() + '…' : flat;
}

/**
 * The address without the handoff parameters, everything else kept.
 *
 * A reload, a bookmark or a copied link would otherwise open the form again.
 */
export function withoutHandoff(href: string): string {
  const url = new URL(href);
  if (!url.search) return url.toString();
  // Pair by pair on the raw text: re-serializing would re-encode the other
  // parameters, and the address would no longer be the one the page had.
  const kept = url.search
    .slice(1)
    .split('&')
    .filter((pair) => ![HANDOFF_PARAM, INTENT_PARAM, REPORT_PARAM].includes(decodeName(pair.split('=')[0])));
  url.search = kept.length ? `?${kept.join('&')}` : '';
  return url.toString();
}

/** A query parameter's name, decoded; as written when it can't be. */
function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * The address that hands someone to an action's page.
 *
 * @param pageUrl - The page the action's form is on.
 * @param actionId - The action's `@id`.
 * @param intent - What they want, in a few words. Nothing personal.
 * @param reportToken - The site's token for the action, when the button that hands them there carried one.
 */
export function handoffUrl(pageUrl: string, actionId: string, intent?: string, reportToken?: string): string {
  const url = new URL(pageUrl);
  // Appended to the raw query, so the page's own parameters keep their encoding.
  const added = new URLSearchParams({ [HANDOFF_PARAM]: actionId });
  const said = intent ? cleanIntent(intent) : '';
  if (said) added.set(INTENT_PARAM, said);
  if (reportToken) added.set(REPORT_PARAM, reportToken);
  url.search = url.search ? `${url.search}&${added}` : `?${added}`;
  return url.toString();
}

/**
 * Read the handoff from this page's address and take it out.
 *
 * @param opts - The address and the history to rewrite; the browser's by default.
 */
export function takeInboundHandoff(
  opts: { href?: string; replace?: (href: string) => void } = {},
): InboundHandoff | null {
  const href = opts.href ?? (typeof location !== 'undefined' ? location.href : '');
  const handoff = href ? readInboundHandoff(href) : null;
  if (!handoff) return null;
  const replace =
    opts.replace ??
    ((next: string) => {
      try {
        history.replaceState(history.state, '', next);
      } catch {
        // A sandboxed frame can refuse; the handoff is still taken once, below.
      }
    });
  replace(withoutHandoff(href));
  // Held for the form this opens, wherever it is sent from; see report.ts.
  if (handoff.reportToken) rememberReportToken(handoff.actionId, handoff.reportToken);
  return handoff;
}

/** What the agent says to start a form: "Start the quote form". */
export function startMessage(tool: ModelContextToolInfo): string {
  return startFormMessage(withoutSiteSuffix(tool.name).replace(/[_-]+/g, ' ').trim().toLowerCase());
}

/**
 * What the agent says to start a site form for one business, in the words a
 * result card's button uses: "Get a quote from McManus Electric".
 */
export function startFormMessage(noun: string, choice?: string): string {
  const named = noun || 'form';
  const form = /\bform\b/.test(named) ? named : `${named} form`;
  if (!choice) return `Start the ${form}`;
  return /quote/.test(named) ? `Get a quote from ${choice}` : `Start the ${form} for ${choice}`;
}

/** Where the form a handoff names stands, once the page has loaded. */
export type ArrivalOutcome =
  /** WebMCP never appeared, so the page's forms cannot be reached. */
  | { status: 'no-registry' }
  /** The page has no form for that action. */
  | { status: 'no-tool' }
  /** The form is here. */
  | { status: 'ready'; tool: ModelContextToolInfo };

/** Overrides, so this can be exercised without a page. */
export interface ArrivalOptions {
  /** How long to wait for the registry, and then for the tool. */
  timeoutMs?: number;
  /** Wait for a WebMCP registry. */
  registry?(timeoutMs: number): Promise<ModelContext | null>;
  /** Wait for the page's own tool for this action. */
  pageTool?(mc: ModelContext, ref: { id: string; name: string }, timeoutMs: number): Promise<ModelContextToolInfo | null>;
}

/**
 * Find the form a handoff names, waiting for the page to register it.
 *
 * Runs while the page is still loading, as the cross-page resume does: the
 * registry and the form's tool usually appear a moment after the agent.
 */
export async function findHandoffForm(handoff: InboundHandoff, opts: ArrivalOptions = {}): Promise<ArrivalOutcome> {
  const timeoutMs = opts.timeoutMs ?? WAIT_MS;
  const mc = await (opts.registry ?? ((ms: number) => waitForModelContext(ms)))(timeoutMs);
  if (!mc) return { status: 'no-registry' };
  // By id only: a name match could be a different form on this page.
  const find = opts.pageTool ?? ((c, ref, ms) => awaitPageTool(c, ref, ms));
  const tool = await find(mc, { id: handoff.actionId, name: '' }, timeoutMs);
  return tool ? { status: 'ready', tool } : { status: 'no-tool' };
}
