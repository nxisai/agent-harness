/**
 * Carries one confirmed action across a page change.
 *
 * An action is run by filling the form on its own page, so a call made from
 * anywhere else has to travel: the values are collected and confirmed where
 * the visitor is, held here, and submitted once the browser arrives.
 *
 * What is held is what someone typed — a name, an email, a phone number — so
 * it is kept in the tab's own session storage, expires in two minutes, and is
 * read exactly once.
 *
 * @module
 */
import { samePage } from './site-actions.js';
import type { AgentStep } from '../steps.js';

/** A confirmed call waiting for its page to load. */
export interface PendingAction {
  /** The `@id` of the action to run on arrival. */
  actionId: string;
  /** What the page's own tool is expected to be called, if the id is not recorded. */
  pageToolName: string;
  /** The site tool the call was made through, for the card it produces. */
  toolName: string;
  /** The values to submit. */
  values: Record<string, unknown>;
  /** The page to submit on. */
  pageUrl: string;
  /** The conversation to return the result to. */
  conversationId?: string;
  /**
   * The journey so far, so a surface can show it after the page has changed.
   *
   * The steps that led here happened on a page that no longer exists.
   */
  steps?: AgentStep[];
  /** When it was stored, in epoch milliseconds. */
  savedAt: number;
}

const KEY = 'nxis:pending-action:v1';

/** How long a confirmed call stays good. Long enough for a page load, no longer. */
export const PENDING_TTL_MS = 2 * 60 * 1000;

/** Overrides for tests and for callers that manage their own storage. */
export interface PendingOptions {
  /** Where the call is held. Defaults to `sessionStorage`; null disables. */
  storage?: Storage | null;
  /** The clock. */
  now?: () => number;
}

/** The tab's session storage, or null where it is unavailable or blocked. */
function defaultStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Where the id of the conversation in progress is read from. */
let conversationSource: (() => string | undefined) | null = null;

/**
 * Say which conversation a call or visit that leaves this page belongs to.
 *
 * Set by whatever owns the conversation — the element, or a host's own UI —
 * rather than passed where tools are built, because the tools are built by
 * whichever script connects first, and on most sites that is not the UI.
 *
 * @param source - Returns the id of the conversation in progress; null to stop.
 */
export function setConversationSource(source: (() => string | undefined) | null): void {
  conversationSource = source;
}

/** The conversation in progress, as its owner reports it. */
function currentConversation(): string | undefined {
  try {
    return conversationSource?.() ?? undefined;
  } catch {
    return undefined;
  }
}

const store = (opts: PendingOptions): Storage | null =>
  opts.storage === undefined ? defaultStorage() : opts.storage;

/**
 * Hold a confirmed call until its page loads.
 *
 * @returns Whether it could be stored. A page that cannot store it must not
 * navigate, or the values would be lost in transit.
 */
export function savePendingAction(
  pending: Omit<PendingAction, 'savedAt'>,
  opts: PendingOptions = {},
): boolean {
  const storage = store(opts);
  if (!storage) return false;
  const now = (opts.now ?? Date.now)();
  try {
    const conversationId = pending.conversationId ?? currentConversation();
    storage.setItem(KEY, JSON.stringify({ ...pending, conversationId, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the call waiting for this page, if there is one.
 *
 * Reads once: a call this returns is removed, so a reload cannot submit the
 * same form twice. An expired call is discarded wherever it is found. A call
 * for another page is left alone, since the browser may still be on its way
 * there.
 *
 * @param href - The page now open. Defaults to the browser's.
 * @returns The call to submit here, or null.
 */
export function takePendingAction(href?: string, opts: PendingOptions = {}): PendingAction | null {
  const storage = store(opts);
  if (!storage) return null;
  let pending: PendingAction | null;
  try {
    pending = JSON.parse(storage.getItem(KEY) || 'null') as PendingAction | null;
  } catch {
    pending = null;
  }
  if (!pending || typeof pending.savedAt !== 'number' || !pending.actionId) {
    clearPendingAction(opts);
    return null;
  }

  const now = (opts.now ?? Date.now)();
  if (now - pending.savedAt > PENDING_TTL_MS || pending.savedAt > now) {
    clearPendingAction(opts);
    return null;
  }

  const here = href ?? (typeof location === 'undefined' ? undefined : location.href);
  if (!samePage(pending.pageUrl, here)) return null;

  clearPendingAction(opts);
  return pending;
}

/** Forget any waiting call. */
export function clearPendingAction(opts: PendingOptions = {}): void {
  try {
    store(opts)?.removeItem(KEY);
  } catch {
    /* nothing held, or storage gone */
  }
}

/**
 * A page the agent opened, waiting to pick the conversation up on arrival.
 *
 * Carries no values, only where the visitor was taken and the conversation
 * that took them, so the thread they were in is the one they find there.
 */
export interface PendingVisit {
  /** The page being opened. */
  pageUrl: string;
  /** What to call it. */
  label: string;
  /** The conversation to continue. */
  conversationId?: string;
  /** The journey so far. */
  steps?: AgentStep[];
  /** When it was stored, in epoch milliseconds. */
  savedAt: number;
}

const VISIT_KEY = 'nxis:pending-visit:v1';

/**
 * Remember a page being opened, so the conversation follows the visitor.
 *
 * @returns Whether it could be stored. Unlike a pending action, nothing is lost
 * when it cannot: the page still opens, in a fresh thread.
 */
export function savePendingVisit(visit: Omit<PendingVisit, 'savedAt'>, opts: PendingOptions = {}): boolean {
  const storage = store(opts);
  if (!storage) return false;
  try {
    const conversationId = visit.conversationId ?? currentConversation();
    storage.setItem(VISIT_KEY, JSON.stringify({ ...visit, conversationId, savedAt: (opts.now ?? Date.now)() }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the visit that brought the browser to this page, if there is one.
 *
 * Read once and discarded when stale, as a pending action is; a visit for
 * another page is left, since the browser may still be on its way.
 *
 * @param href - The page now open. Defaults to the browser's.
 */
export function takePendingVisit(href?: string, opts: PendingOptions = {}): PendingVisit | null {
  const storage = store(opts);
  if (!storage) return null;
  let visit: PendingVisit | null;
  try {
    visit = JSON.parse(storage.getItem(VISIT_KEY) || 'null') as PendingVisit | null;
  } catch {
    visit = null;
  }
  const drop = () => {
    try {
      storage.removeItem(VISIT_KEY);
    } catch {
      /* storage gone */
    }
  };
  const now = (opts.now ?? Date.now)();
  if (!visit || typeof visit.savedAt !== 'number' || !visit.pageUrl || now - visit.savedAt > PENDING_TTL_MS || visit.savedAt > now) {
    drop();
    return null;
  }
  const here = href ?? (typeof location === 'undefined' ? undefined : location.href);
  if (!samePage(visit.pageUrl, here)) return null;
  drop();
  return visit;
}
