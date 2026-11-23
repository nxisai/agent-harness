/**
 * A remote agent's own model calls, metered like the page's.
 *
 * A handoff target such as the Support Agent calls models server-side: one
 * composes, one rewrites. Started by the bench with
 * `SUPPORT_MODEL_BASE_URL=http://127.0.0.1:4100/remote/support/<run>`, its
 * Anthropic client posts to `<base>/v1/messages` here, naming the model on
 * `X-Nxis-Model`. This is the same allowlist the page's calls go through: the
 * header (or the request's own `model`) picks a registry entry, the entry's
 * vendor model is what is called, and the vendor key is this process's own,
 * never the caller's. Each call is written to the run's transcript as
 * `remote-<agent>.jsonl`, so the report can give the remote agent's cost and
 * latency apart from the page's.
 *
 * Messages API only, and Anthropic only: a non-Anthropic entry is refused.
 * Streaming is passed through as it arrives, its usage read on the way.
 *
 * Refusals, cheapest first: a browser's request (anything with an `Origin`:
 * this route is for a server process on this machine, never a page), the
 * path, the size, the budget, then the model.
 *
 * @module
 */

/** What this route holds a request to. A remote agent's request carries the records it fetched. */
export const REMOTE_LIMITS = { body: 1_000_000 };

/** `/remote/<agent>/<run>/v1/messages`. */
const PATH = /^\/remote\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9._-]{1,80})\/v1\/messages$/;

/** Whether a path is this route's. */
export const isRemotePath = (pathname) => pathname.startsWith('/remote/');

/**
 * The registry entry a remote call names: `X-Nxis-Model` by registry id or by
 * vendor model id (`claude-haiku-5-5`), else the request's own `model` the
 * same way. Only an Anthropic entry, since this route speaks its Messages API.
 *
 * @param {Record<string, import('./registry.mjs').ModelEntry>} models
 * @param {(id: string) => ({ id: string, entry: import('./registry.mjs').ModelEntry } | { error: string })} resolve
 * @param {string | undefined} header
 * @param {unknown} bodyModel
 */
export function resolveRemote(models, resolve, header, bodyModel) {
  const wanted = [header, typeof bodyModel === 'string' ? bodyModel : undefined].map((v) => (v ?? '').trim()).filter(Boolean);
  if (!wanted.length) return { error: 'Name the model on X-Nxis-Model.' };
  const byVendor = (v) => Object.keys(models).find((id) => models[id].model === v);
  const id = Object.prototype.hasOwnProperty.call(models, wanted[0]) ? wanted[0] : byVendor(wanted[0]) ?? wanted[0];
  const picked = resolve(id);
  if ('error' in picked) return picked;
  if (picked.entry.vendor !== 'anthropic') return { error: `Model "${picked.id}" is not an Anthropic model; this route forwards the Messages API only.` };
  return picked;
}

/**
 * Usage from a Messages API response or stream, as the transcript records it.
 *
 * @param {Record<string, any>} usage
 */
const usageOf = (usage) => ({
  promptTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
  outputTokens: usage?.output_tokens ?? 0,
});

/**
 * Read usage out of a Messages API event stream: `message_start` carries the
 * input, `message_delta` the output so far.
 *
 * @param {string} sse
 */
export function streamUsage(sse) {
  let start = {};
  let out = 0;
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const e = JSON.parse(line.slice(5).trim());
      if (e.type === 'message_start') start = e.message?.usage ?? {};
      if (e.type === 'message_delta' && typeof e.usage?.output_tokens === 'number') out = e.usage.output_tokens;
    } catch {
      // A keep-alive or a partial line: nothing to count.
    }
  }
  return usageOf({ ...start, output_tokens: out || start.output_tokens || 0 });
}

const send = (res, status, body) => {
  const payload = JSON.stringify({ type: 'error', error: { type: 'bench_proxy', message: body } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
};

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * What the route needs from the server, passed in so it can be tested without
 * a vendor, Redis or a container.
 *
 * @typedef {object} RemoteDeps
 * @property {Record<string, import('./registry.mjs').ModelEntry>} models
 * @property {(id: string) => any} resolve
 * @property {(peer: string) => Promise<{ allowed: boolean, retryAfter: number, backend: string }>} take
 * @property {(entry: { runId: string, modelId: string, caseId: string, record: Record<string, unknown> }) => Promise<void>} append
 * @property {number} maxTokens
 * @property {string} [upstream]  The vendor's base URL. Defaults to `ANTHROPIC_BASE_URL`, else Anthropic's.
 * @property {typeof fetch} [fetchImpl]
 * @property {Record<string, string | undefined>} [env]
 */

/**
 * Serve one remote agent's model call.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {RemoteDeps} deps
 */
export async function handleRemote(req, res, url, deps) {
  const env = deps.env ?? process.env;
  // 1 — a page. A browser always sends Origin on this kind of request; a server process never needs to.
  if (req.headers.origin) return send(res, 403, 'This route is for a remote agent on this machine, not a page.');
  const m = PATH.exec(url.pathname);
  if (!m) return send(res, 404, 'Use /remote/<agent>/<run>/v1/messages.');
  if (req.method !== 'POST') return send(res, 405, 'Use POST.');
  const [, agent, runId] = m;

  // 2 — size.
  const raw = await readBody(req, REMOTE_LIMITS.body).catch(() => null);
  if (raw === null) return send(res, 413, 'Request too large.');

  // 3 — budget, shared with the page's calls.
  const gate = await deps.take(`remote:${req.socket.remoteAddress ?? 'unknown'}`);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter || 60));
    return send(res, 429, 'Too many requests.');
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(res, 400, 'Body must be JSON.');
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return send(res, 400, 'No messages.');

  // 4 — the model: pinned to the registry's entry, whatever the caller asked for.
  const picked = resolveRemote(deps.models, deps.resolve, req.headers['x-nxis-model'], body.model);
  if ('error' in picked) return send(res, 400, picked.error);
  const { id: modelId, entry } = picked;
  const stream = body.stream === true;
  const forwarded = { ...body, model: entry.model, max_tokens: Math.min(Number(body.max_tokens) || deps.maxTokens, deps.maxTokens) };

  const ac = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const base = (deps.upstream ?? env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01'),
    // The caller's own key, if it sent one, goes no further than here.
    'x-api-key': String(env[entry.keyRef ?? 'ANTHROPIC_API_KEY'] ?? ''),
    ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': String(req.headers['anthropic-beta']) } : {}),
  };
  const record = (r) =>
    deps.append({
      runId,
      modelId: `remote-${agent}`,
      caseId: 'remote',
      record: { remote: agent, model: modelId, vendorModel: entry.model, display: entry.display, lane: entry.lane, stream, ...r },
    });

  const started = Date.now();
  try {
    const up = await (deps.fetchImpl ?? fetch)(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(forwarded), signal: ac.signal });
    const type = up.headers.get('content-type') ?? 'application/json';
    if (stream && up.ok && up.body && /event-stream/.test(type)) {
      res.writeHead(up.status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      let sse = '';
      const decoder = new TextDecoder();
      for await (const chunk of up.body) {
        sse += decoder.decode(chunk, { stream: true });
        res.write(chunk);
      }
      // Recorded before the stream closes, so a caller that reads the transcript once it has its answer finds it.
      await record({ ok: true, latencyMs: Date.now() - started, request: forwarded, response: { usage: streamUsage(sse) } });
      res.end();
      return;
    }
    const text = await up.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Passed through as it came; nothing to count.
    }
    await record(
      up.ok
        ? { ok: true, latencyMs: Date.now() - started, request: forwarded, response: { usage: usageOf(json?.usage), stopReason: json?.stop_reason ?? null } }
        : { ok: false, latencyMs: Date.now() - started, status: up.status, error: json?.error?.message ?? `upstream ${up.status}` },
    );
    res.writeHead(up.status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  } catch (err) {
    const aborted = ac.signal.aborted || err?.name === 'AbortError';
    await record({ ok: false, aborted, latencyMs: Date.now() - started, error: aborted ? 'aborted by the client' : String(err?.message ?? err) });
    if (res.headersSent || aborted) return res.destroy();
    return send(res, 502, 'The model is unavailable right now.');
  }
}
