/**
 * What a tap on Listen, Subscribe or "Their page" does on the site's own page.
 *
 * The funnel buttons (Get a quote, Reserve) ask the agent, which runs the site's form. Listen and Subscribe are
 * places, not requests: the episode's player and the subscribe page. The NxisAI app opens them in a new tab
 * because it isn't on the site; the harness is, so it goes there the way a link on the page would, and keeps the
 * conversation:
 *
 * - **in place**: the target is this page (an episode's `#player` while reading that episode): the browser moves
 *   to the fragment, nothing reloads, and the chat stays open beside the player.
 * - **same site**: another page on the site: the visit is saved (as "Open page" and the `open_page` tool save it)
 *   and the browser goes there in this tab; the conversation picks up on arrival.
 * - **new tab**: another origin (a subscribe page hosted elsewhere): opened in a new tab, so leaving the site never
 *   ends the conversation.
 *
 * @module
 */
import { samePage } from './site-actions.js';
import { savePendingVisit } from './pending-action.js';

/** How a target opens from here. */
export type OpenWay = 'in-place' | 'same-site' | 'new-tab';

/**
 * How `url` opens from the page at `here`.
 *
 * @param here - The page now open. Defaults to the browser's.
 */
export function openWay(url: string, here: string | undefined = typeof location === 'undefined' ? undefined : location.href): OpenWay {
  if (!here) return 'new-tab';
  try {
    const to = new URL(url, here);
    if (to.origin !== new URL(here).origin) return 'new-tab';
    return samePage(to.href, here) ? 'in-place' : 'same-site';
  } catch {
    return 'new-tab';
  }
}

/** What opening needs that the browser otherwise supplies; tests pass their own. */
export interface OpenTargetOptions {
  /** The page now open. */
  here?: string;
  /** The conversation to continue after a same-site navigation. */
  conversationId?: string;
  /** Go there in this tab. Defaults to assigning `location`. */
  navigate?: (url: string) => void;
  /** Open in a new tab. Defaults to `window.open` with `noopener` and `noreferrer`. */
  openTab?: (url: string) => void;
  /** Where the visit waits while the browser moves. Defaults to `sessionStorage`. */
  storage?: Storage | null;
}

/**
 * Follow a link the visitor tapped, the way a link on the page would, keeping the conversation.
 *
 * @param label - What the page is called, for the conversation to say where it went: the episode's or show's name.
 * @returns How it opened.
 */
export function openTarget(url: string, label: string, opts: OpenTargetOptions = {}): OpenWay {
  const way = openWay(url, opts.here);
  if (way === 'new-tab') {
    (opts.openTab ?? ((u) => window.open(u, '_blank', 'noopener,noreferrer')))(url);
    return way;
  }
  // A move within the page reloads nothing, so there is no visit to carry over.
  if (way === 'same-site') savePendingVisit({ pageUrl: url, label, conversationId: opts.conversationId }, { storage: opts.storage });
  (opts.navigate ?? ((u) => location.assign(u)))(url);
  return way;
}
