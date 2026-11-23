/**
 * Finishing, on arrival, a call that was confirmed on another page.
 *
 * The decisions here are the awkward ones — is there a call waiting, did the
 * page's script ever register the form, does the live form want more than the
 * record said — and they are worth testing without a browser. So the work is
 * a function that returns what happened, and the caller draws it.
 *
 * @module
 */
import { takePendingAction, type PendingAction, type PendingOptions } from './pending-action.js';
import { awaitPageTool } from './action-tools.js';
import { extractResult, missingRequired } from './schema.js';
import { recordStep, restoreJourney } from '../steps.js';
import { waitForModelContext } from './source.js';
import { WebMcpTools } from './webmcp.js';
import type { ModelContext, ModelContextToolInfo, ModelContextToolResponse } from '../../types.js';

/** How long to wait for the registry, and then for the form's own tool. */
const WAIT_MS = 8000;

/** What became of the call that was waiting for this page. */
export type ResumeOutcome =
  /** Nothing was waiting for this page. The ordinary case. */
  | { status: 'none' }
  /** WebMCP never appeared, so the form's tool could not be reached. */
  | { status: 'no-registry'; pending: PendingAction }
  /** The page never registered a tool for this action. */
  | { status: 'no-tool'; pending: PendingAction }
  /** The live form requires values the record did not carry. */
  | { status: 'incomplete'; pending: PendingAction; tool: ModelContextToolInfo; missing: string[] }
  /** Submitted. */
  | { status: 'submitted'; pending: PendingAction; tool: ModelContextToolInfo; text: string }
  /** The tool ran and reported a failure. */
  | { status: 'rejected'; pending: PendingAction; tool: ModelContextToolInfo; text: string }
  /** The call threw. */
  | { status: 'failed'; pending: PendingAction; tool: ModelContextToolInfo; error: string };

/** Overrides, so this can be exercised without a page. */
export interface ResumeOptions extends PendingOptions {
  /** The page now open. Defaults to the browser's. */
  href?: string;
  /** How long to wait for the registry and the tool. */
  timeoutMs?: number;
  /** Wait for a WebMCP registry. */
  registry?(timeoutMs: number): Promise<ModelContext | null>;
  /** Wait for the page's own tool for this action. */
  pageTool?(
    mc: ModelContext,
    ref: { id: string; name: string },
    timeoutMs: number,
  ): Promise<ModelContextToolInfo | null>;
  /** Run the tool. */
  exec?(
    tool: ModelContextToolInfo,
    values: Record<string, unknown>,
  ): Promise<ModelContextToolResponse>;
  /**
   * Called once a waiting call is found, before the waits begin.
   *
   * The page has just loaded and the registry may take seconds to appear, so
   * this is where a UI opens the conversation the call came from rather than
   * leaving the visitor looking at an unrelated thread.
   */
  onStart?(pending: PendingAction): void;
}

/**
 * Submit the call waiting for this page, if there is one.
 *
 * Runs while the page is still loading, so neither the registry nor the
 * page's tools exist yet — the script that installs them is usually still
 * being fetched. Both waits are needed, and in this order.
 *
 * @param opts - Page, timeouts, and the seams tests replace.
 * @returns What happened, for the caller to render.
 */
export async function resumePendingAction(opts: ResumeOptions = {}): Promise<ResumeOutcome> {
  const pending = takePendingAction(opts.href, opts);
  if (!pending) return { status: 'none' };
  // The journey continues from where the other page left it.
  restoreJourney(pending.steps);
  recordStep({ id: 'navigate', label: 'Opened the page', status: 'done' });
  recordStep({ id: 'arrive', label: 'Found the form', status: 'active' });
  opts.onStart?.(pending);

  const timeoutMs = opts.timeoutMs ?? WAIT_MS;
  const waitForRegistry = opts.registry ?? ((ms: number) => waitForModelContext(ms));
  const mc = await waitForRegistry(timeoutMs);
  if (!mc) {
    recordStep({ id: 'arrive', label: 'This page has no agent tools', status: 'failed' });
    return { status: 'no-registry', pending };
  }

  const findTool = opts.pageTool ?? ((c, ref, ms) => awaitPageTool(c, ref, ms));
  const tool = await findTool(mc, { id: pending.actionId, name: pending.pageToolName }, timeoutMs);
  if (!tool) {
    recordStep({ id: 'arrive', label: 'Could not find the form here', status: 'failed' });
    return { status: 'no-tool', pending };
  }
  recordStep({ id: 'arrive', label: 'Found the form', status: 'done' });

  // The record says only what the crawler recorded; the form in front of us
  // says what it actually insists on. Now that its page is open, ask rather
  // than submit a half-filled form on someone's behalf.
  const missing = missingRequired(tool, pending.values);
  if (missing.length) {
    recordStep({
      id: 'collect',
      label: 'This form needs more',
      status: 'active',
      detail: missing.join(', '),
    });
    return { status: 'incomplete', pending, tool, missing };
  }

  recordStep({ id: 'fill', label: 'Filling the form', status: 'active' });
  const run = opts.exec ?? ((t, values) => new WebMcpTools().execTool(t, t.name, values));
  try {
    const res = await run(tool, pending.values);
    const text = extractResult(res);
    if (res?.isError) {
      recordStep({ id: 'submit', label: 'It did not go through', status: 'failed', detail: text });
      return { status: 'rejected', pending, tool, text };
    }
    recordStep({ id: 'fill', label: 'Filled the form', status: 'done' });
    recordStep({ id: 'submit', label: 'Submitted', status: 'done' });
    return { status: 'submitted', pending, tool, text };
  } catch (err) {
    const error = String((err as Error)?.message || err);
    recordStep({ id: 'submit', label: 'It did not go through', status: 'failed', detail: error });
    return { status: 'failed', pending, tool, error };
  }
}
