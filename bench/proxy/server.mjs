/**
 * The model proxy, as a container.
 *
 * One endpoint satisfying `@nxisai/agent-harness`'s proxy contract, able to
 * route to several models so a bench can compare them without redeploying
 * anything. The page posts a conversation and the tools on it; this asks a
 * model for the next turn and maps the answer back to `{text, call, usage,
 * model}`.
 *
 * A handoff target's own model calls come in on `/remote/<agent>/<run>/v1/messages`
 * (remote.mjs): the same allowlist and budget, recorded apart.
 *
 * Refusals are ordered cheapest first — origin, then size, then the budget,
 * then the model — so nothing expensive is reached by a request that was never
 * going to be answered.
 *
 * The browser never holds a vendor credential: keys are read from the
 * environment at startup and only ever leave this process addressed to the
 * vendor.
 *
 * @module
 */
import { createServer } from 'node:http';
import { resolve as resolveModel, MODELS, DEFAULT_MODEL } from './registry.mjs';
import { budget, clientKey, take } from './limit.mjs';
import { append } from './transcript.mjs';
import { handleRemote, isRemotePath } from './remote.mjs';
import * as anthropic from './adapters/anthropic.mjs';
import * as openai from './adapters/openai.mjs';
import * as google from './adapters/google.mjs';
import * as ollama from './adapters/ollama.mjs';

const ADAPTERS = { anthropic, openai, google, ollama };

/** Ceilings this endpoint owns, rather than ones the caller asks for. */
const LIMITS = {
  /** Bytes of request body. A turn is a few KB. */
  body: 256_000,
  /** Messages in one conversation. */
  messages: 60,
  /** Characters in any single message. */
  messageChars: 8_000,
  /**
   * Generated tokens per turn, whatever the client requested.
   *
   * Higher than the production endpoint's 1024 on purpose: models whose
   * thinking is always on spend output tokens before the answer, and a turn
   * truncated by the ceiling would be scored as a model failure.
   */
  maxTokens: Number(process.env.MAX_TOKENS ?? 4096),
};

/**
 * Origins allowed to call this.
 *
 * A browser always sends `Origin` on a cross-origin POST, so a request without
 * one did not come from a page. This stops drive-by traffic, not anyone willing
 * to set a header, which is why it is the outermost of four layers rather than
 * the only one.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const PORT = Number(process.env.PORT ?? 4100);

/** @param {import('node:http').ServerResponse} res */
const send = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
};

/**
 * Read a request body, giving up once it is over the ceiling.
 *
 * Checking after buffering the whole thing would let a large body cost memory
 * before being refused for its size.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | null>} Null when the body is too large.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.body) {
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/healthz') {
    return send(res, 200, {
      ok: true,
      models: Object.keys(MODELS),
      defaultModel: DEFAULT_MODEL,
      budget,
      maxTokens: LIMITS.maxTokens,
      // Where a remote agent's own models are reached: its <NAME>_MODEL_BASE_URL is this, less /v1/messages.
      remote: '/remote/<agent>/<run>/v1/messages',
    });
  }

  // A remote agent's own model calls (a handoff target's), metered apart from the page's. See remote.mjs.
  if (isRemotePath(url.pathname)) {
    return handleRemote(req, res, url, { models: MODELS, resolve: resolveModel, take, append, maxTokens: LIMITS.maxTokens });
  }

  if (url.pathname !== '/api/agent') return send(res, 404, { error: 'Not found.' });

  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    // Preflight gets the same origin decision as the real request.
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return send(res, 403, { error: 'Not permitted from this origin.' });
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type, X-Nxis-Model, X-Bench-Run, X-Bench-Case',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });

  // 1 — origin. Free.
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return send(res, 403, { error: 'Not permitted from this origin.' });
  }
  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };

  // 2 — size. Cheap, and bounded.
  const raw = await readBody(req).catch(() => null);
  if (raw === null) return send(res, 413, { error: 'Request too large.' }, cors);

  // 3 — budget. One network hop at most.
  const peer = clientKey(
    new Request('http://bench/', {
      headers: {
        ...(req.headers['x-forwarded-for']
          ? { 'x-forwarded-for': String(req.headers['x-forwarded-for']) }
          : {}),
        'x-bench-peer': req.socket.remoteAddress ?? 'unknown',
      },
    }),
  );
  const gate = await take(peer);
  if (!gate.allowed) {
    return send(
      res,
      429,
      { error: 'Too many requests.' },
      { ...cors, 'Retry-After': String(gate.retryAfter || budget.windowSec) },
    );
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'Body must be JSON.' }, cors);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return send(res, 400, { error: 'No messages.' }, cors);
  if (messages.length > LIMITS.messages) {
    return send(res, 413, { error: 'Conversation too long.' }, cors);
  }
  if (messages.some((m) => String(m?.content ?? '').length > LIMITS.messageChars)) {
    return send(res, 413, { error: 'Message too long.' }, cors);
  }

  const picked = resolveModel(req.headers['x-nxis-model']);
  if ('error' in picked) return send(res, 400, { error: picked.error }, cors);
  const { id: modelId, entry } = picked;

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const maxTokens = Math.min(Number(body.maxTokens) || LIMITS.maxTokens, LIMITS.maxTokens);
  const runId = String(req.headers['x-bench-run'] ?? 'ad-hoc');
  const caseId = String(req.headers['x-bench-case'] ?? 'ad-hoc');

  // 4 — the model. The only layer that costs anything.
  //
  // The harness aborts a turn when the visitor stops it, closes the panel or
  // starts another, and that arrives here as the socket closing. Forwarding it
  // to the vendor is what stops a cancelled turn still being billed.
  const ac = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const started = Date.now();
  try {
    const out = await ADAPTERS[entry.vendor].complete({
      messages,
      tools,
      maxTokens,
      entry,
      cache: body.cache,
      signal: ac.signal,
    });
    const latencyMs = Date.now() - started;

    await append({
      runId,
      modelId,
      caseId,
      record: {
        ok: true,
        latencyMs,
        lane: entry.lane,
        vendorModel: entry.model,
        display: entry.display,
        request: { messages, tools, maxTokens, cache: body.cache ?? null },
        response: { text: out.text, call: out.call ?? null, usage: out.usage ?? null },
        meta: out.meta ?? null,
        limiter: gate.backend,
      },
    });

    // Only the four contract fields go to the page. `meta` stays in the record.
    return send(
      res,
      200,
      {
        text: out.text,
        ...(out.call ? { call: out.call } : {}),
        ...(out.usage ? { usage: out.usage } : {}),
        ...(out.model ? { model: out.model } : {}),
      },
      cors,
    );
  } catch (err) {
    const latencyMs = Date.now() - started;
    // The vendor's message can carry request detail, so it is logged and
    // recorded rather than returned. The visitor sees the harness's own line.
    const aborted = ac.signal.aborted || err?.name === 'AbortError';
    if (!aborted) {
      console.error(`[agent] ${modelId} failed after ${latencyMs}ms:`, err?.message ?? err);
    }
    await append({
      runId,
      modelId,
      caseId,
      record: {
        ok: false,
        aborted,
        latencyMs,
        error: aborted ? 'aborted by the client' : String(err?.message ?? err),
      },
    });
    // Nothing is listening on an aborted request, and writing to it throws.
    if (res.writableEnded || ac.signal.aborted) return res.destroy();
    return send(res, 502, { error: 'The assistant is unavailable right now.' }, cors);
  }
});

server.listen(PORT, () => {
  console.log(
    `[agent] listening on ${PORT}; models: ${Object.keys(MODELS).join(', ')}; ` +
      `budget ${budget.limit}/${budget.windowSec}s; origins: ${ALLOWED_ORIGINS.join(', ')}`,
  );
});
