/**
 * Where each case runs: a page of its own, with nothing of an earlier case in
 * it, unless it `continues` one.
 *
 * The element keeps its conversations in the origin's `localStorage` and opens
 * the last one on load, a handoff still open included. A case on a fresh page in
 * the same browser context would carry on the conversation the previous case
 * left, and a `(Send)` case that left its handoff open would send the next,
 * unrelated prompt to the remote target. So an independent case gets a context
 * of its own; a case that `continues` another takes that case's page, with its
 * storage and its conversation. Lane A keeps one persistent profile (its model
 * weights are in Cache Storage), so there the site's `localStorage` is cleared
 * instead, before the page loads.
 *
 * Pure apart from the browser it is handed; the tests give it a fake one.
 *
 * @module
 */

/**
 * @typedef {object} CaseLike
 * @property {string} id
 * @property {string} [continues]
 */

/**
 * @param {object} opts
 * @param {CaseLike[]} opts.cases - Every case the run will take, in order.
 * @param {() => Promise<import('playwright').BrowserContext>} [opts.newContext] - A fresh context, for each independent case.
 * @param {import('playwright').BrowserContext} [opts.shared] - One context every case shares (Lane A's profile).
 * @param {(page: import('playwright').Page) => Promise<void>} [opts.clearSite] - With `shared`: empty the site's storage before the page loads.
 * @param {(page: import('playwright').Page) => Promise<void>} opts.load - Open the site on a new page.
 */
export function caseSessions({ cases, newContext, shared, clearSite, load }) {
  if (!shared && !newContext) throw new Error('caseSessions needs newContext or shared');
  /** Pages kept open so a follow-up case can continue its conversation, by the case they were last used in. */
  const chains = new Map();
  /** The context each page was given, when it has one of its own. */
  const owned = new Map();

  const close = async (page) => {
    await page.close().catch(() => {});
    const context = owned.get(page);
    owned.delete(page);
    await context?.close().catch(() => {});
  };

  return {
    /**
     * The page a case runs on: the one its `continues` case left, or a new one on a clean site.
     *
     * @param {CaseLike} kase
     * @returns {Promise<{ page: import('playwright').Page, fresh: boolean }>}
     */
    async pageFor(kase) {
      const held = kase.continues ? chains.get(kase.continues) : undefined;
      if (held) return { page: held, fresh: false };
      const context = shared ?? (await newContext());
      const page = await context.newPage();
      if (!shared) owned.set(page, context);
      else await clearSite?.(page);
      await load(page);
      return { page, fresh: true };
    },

    /**
     * After a case: keep its page when a later case continues from it, else close it (and its context).
     *
     * @param {CaseLike} kase
     * @param {import('playwright').Page} page
     */
    async done(kase, page) {
      if (cases.some((c) => c.continues === kase.id)) chains.set(kase.id, page);
      else if (![...chains.values()].includes(page)) await close(page);
    },

    /** Close every page still held. */
    async closeAll() {
      for (const page of new Set(chains.values())) await close(page);
      chains.clear();
    },
  };
}

/**
 * Empty the site's `localStorage` in a persistent profile, through the
 * DevTools protocol, before the page loads it. Only local storage: the
 * on-device model's weights are in Cache Storage and stay.
 *
 * @param {import('playwright').Page} page
 * @param {string} origin
 */
export async function clearSiteStorage(page, origin) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' });
  } finally {
    await cdp.detach().catch(() => {});
  }
}
