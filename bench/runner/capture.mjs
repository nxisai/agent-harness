/**
 * What one turn looked like, from both sides.
 *
 * Two streams, because neither alone is sufficient. The proxy's transcript
 * holds the request the harness built and the usage the vendor reported — the
 * things a failure has to be reproduced from. The page holds what the visitor
 * actually saw: whether a confirmation card rendered, what the answer read as.
 * A model that returns a perfect tool call the UI then fails to surface has not
 * passed, and only the page can say so.
 *
 * @module
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where the proxy writes, as mounted on the host. */
const RUNS = process.env.RUNS_DIR ?? new URL('../runs', import.meta.url).pathname;

/**
 * Read back what the proxy recorded for one case.
 *
 * The file is appended to while the run proceeds, so the last entry for the
 * case is the turn just taken.
 *
 * @param {string} runId
 * @param {string} modelId
 * @param {string} caseId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function proxyRecord(runId, modelId, caseId) {
  const rows = await proxyRecords(runId, modelId, caseId);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * Every request the proxy recorded for one case, in order.
 *
 * @param {string} runId
 * @param {string} modelId
 * @param {string} caseId
 * @returns {Promise<Record<string, any>[]>}
 */
export async function proxyRecords(runId, modelId, caseId) {
  const path = join(RUNS, runId, `${modelId}.jsonl`);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // One bad line should not cost the run; it is reported as a gap.
        return null;
      }
    })
    .filter((r) => r && r.caseId === caseId);
  return rows;
}

/**
 * Read the page's side of the turn.
 *
 * Runs in the browser. Selectors are the harness's own, and are the reason this
 * function is small: `.detailcard` with a `[data-act="submit"]` button is how
 * the harness renders a write awaiting confirmation, so its presence is the
 * fact the write-path case needs.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ transcript: string, actionCard: boolean, cardTitle: string | null, awaitingConfirm: boolean, fields: string[], remoteDrawn: string[] }>}
 */
export function pageState(page) {
  return page.evaluate(() => {
    const host = document.querySelector('nxis-agent, nxis-agent-fullscreen');
    const root = host?.shadowRoot;
    if (!root) {
      return { transcript: '', actionCard: false, cardTitle: null, awaitingConfirm: false, fields: [], remoteDrawn: [] };
    }
    // The action card (0.7) or the review card before it.
    const action = [...root.querySelectorAll('.action-card')].pop() ?? null;
    const card = action ?? root.querySelector('.detailcard');
    const submit = action ? (/is-(review|collect)/.test(action.className) ? action : null) : root.querySelector('.detailcard [data-act="submit"]');
    const pick = [...root.querySelectorAll('.results-answer .ra-pick.is-pick')].pop() ?? null;
    return {
      // The whole panel's text. Good enough for a judge and for a regex; the
      // structured facts come from the proxy record.
      transcript: (root.textContent ?? '').replace(/\s+/g, ' ').trim(),
      actionCard: !!card,
      cardTitle: (card?.querySelector('.ac-who strong') ?? card?.querySelector('.dc-title'))?.textContent?.trim() ?? null,
      // A search's recommendation: shown as a pick, and whose.
      pickShown: !!pick,
      pickName: pick?.querySelector('.ra-who strong')?.textContent?.trim() ?? null,
      awaitingConfirm: !!submit,
      // Field labels the harness is asking for, which is how "it asked rather
      // than invented" is observed.
      fields: [...root.querySelectorAll('.field label, .gf-desc, .ac-label')]
        .map((el) => el.textContent?.trim() ?? '')
        .filter(Boolean),
      // A remote agent's cited cards as drawn, `Type@id`, compact rows included: what `remoteCards` checks was shown.
      remoteDrawn: [...root.querySelectorAll('.remote .ra-cite[data-id]')].map((el) => `${el.getAttribute('data-type')}@${el.getAttribute('data-id')}`),
    };
  });
}
