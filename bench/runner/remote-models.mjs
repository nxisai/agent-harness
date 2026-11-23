/**
 * A remote agent's own model calls, as the report gives them: apart from the
 * page's.
 *
 * The bench starts the remote agent (or tells you how to) with
 * `<NAME>_MODEL_BASE_URL` pointing at the proxy's remote route, so its models
 * go through the same allowlist and budget as the page's and are written to
 * the run's `remote-<name>.jsonl`. The agent is one process for the whole run,
 * so its calls carry no case: each is filed under the case whose turn it fell
 * in, by time.
 *
 * @module
 */
import { pct, turnCost } from './score.mjs';

/** `support` → `SUPPORT_MODEL_BASE_URL`: the variable the remote agent reads its model base URL from. */
export const remoteEnvName = (name) => `${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MODEL_BASE_URL`;

/** The transcript id the proxy files a remote agent's calls under. */
export const remoteModelId = (name) => `remote-${name}`;

/**
 * The base URL a remote agent's Anthropic client is given: the proxy's
 * remote route for this agent and run. Its client appends `/v1/messages`.
 *
 * @param {string} proxy - The page's proxy endpoint, `http://127.0.0.1:4100/api/agent`.
 */
export function remoteBaseUrl(proxy, name, runId) {
  return `${new URL(proxy).origin}/remote/${encodeURIComponent(name)}/${encodeURIComponent(runId)}`;
}

/**
 * The calls made between two moments: one case's turn.
 *
 * @param {Record<string, any>[]} rows - The remote agent's transcript rows.
 * @param {string} from - ISO time the turn began.
 * @param {string} to - ISO time it was scored.
 */
export const callsBetween = (rows, from, to) => rows.filter((r) => typeof r.at === 'string' && r.at >= from && r.at <= to);

/**
 * What a set of remote calls cost and took, in all and by model.
 *
 * @param {Record<string, any>[]} rows
 * @param {Record<string, import('../proxy/registry.mjs').ModelEntry>} models
 * @returns {{ calls: number, failed: number, latencyMs: number, costUsd: number | null, byModel: Record<string, { calls: number, promptTokens: number, outputTokens: number, costUsd: number | null }> }}
 */
export function remoteUsage(rows, models) {
  const byModel = {};
  let cost = null;
  for (const r of rows) {
    const m = (byModel[r.model ?? 'unknown'] ??= { calls: 0, promptTokens: 0, outputTokens: 0, costUsd: null });
    m.calls += 1;
    m.promptTokens += r.response?.usage?.promptTokens ?? 0;
    m.outputTokens += r.response?.usage?.outputTokens ?? 0;
    const c = r.ok ? turnCost(r, models[r.model]) : null;
    if (c != null) {
      m.costUsd = (m.costUsd ?? 0) + c;
      cost = (cost ?? 0) + c;
    }
  }
  return {
    calls: rows.length,
    failed: rows.filter((r) => !r.ok).length,
    latencyMs: rows.reduce((s, r) => s + (r.latencyMs ?? 0), 0),
    costUsd: cost,
    byModel,
  };
}

/**
 * The run's remote agent, per page model: how many calls, what they cost, and
 * the latency of a case's remote calls together (p50, p95 over the cases that
 * made any).
 *
 * @param {Record<string, any>[]} results - The run's results, each with `remoteModel`.
 * @param {string[]} pageModels
 */
export function remoteSummary(results, pageModels) {
  return Object.fromEntries(
    pageModels.map((id) => {
      const mine = results.filter((r) => r.modelId === id && r.remoteModel?.calls);
      const byModel = {};
      for (const r of mine) {
        for (const [m, u] of Object.entries(r.remoteModel.byModel)) {
          const t = (byModel[m] ??= { calls: 0, promptTokens: 0, outputTokens: 0, costUsd: null });
          t.calls += u.calls;
          t.promptTokens += u.promptTokens;
          t.outputTokens += u.outputTokens;
          if (u.costUsd != null) t.costUsd = (t.costUsd ?? 0) + u.costUsd;
        }
      }
      const costs = mine.map((r) => r.remoteModel.costUsd).filter((c) => c != null);
      const lat = mine.map((r) => r.remoteModel.latencyMs);
      return [
        id,
        {
          calls: mine.reduce((s, r) => s + r.remoteModel.calls, 0),
          failed: mine.reduce((s, r) => s + r.remoteModel.failed, 0),
          costUsd: costs.length ? costs.reduce((s, c) => s + c, 0) : null,
          p50: pct(lat, 0.5),
          p95: pct(lat, 0.95),
          byModel,
        },
      ];
    }),
  );
}
