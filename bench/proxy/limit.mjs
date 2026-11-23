/**
 * The rate limit, which on Docker the application has to supply itself.
 *
 * On a platform host this is configuration: Netlify takes a `rateLimit` block
 * and refuses the request at the edge, before any function runs. A container
 * has no edge, so the cheapest refusal available is still inside this process —
 * and a counter inside this process is lost on restart and not shared if the
 * service is ever run with more than one replica. Both of those turn a limit
 * into a suggestion.
 *
 * So the real limiter is Redis `INCR` plus `EXPIRE`, and the in-process bucket
 * below is only the fallback for when Redis is unreachable. The distinction is
 * observable, and the way to prove which one is active is to restart the
 * container mid-budget: a Redis-backed limit keeps refusing, an in-process one
 * forgets.
 *
 * @module
 */
import { createClient } from 'redis';

/** Requests allowed per window, per client. */
const LIMIT = Number(process.env.RATE_LIMIT_PER_MIN ?? 20);
/** Window length in seconds. */
const WINDOW = Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60);

/** @type {import('redis').RedisClientType | undefined} */
let redis;
/** Whether Redis has been given up on, so each request does not retry it. */
let redisDown = false;

/** In-process fallback: client key to window start and count. */
const local = new Map();

/**
 * Connect to Redis once, tolerating its absence.
 *
 * @returns {Promise<import('redis').RedisClientType | undefined>}
 */
async function client() {
  if (redis || redisDown) return redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisDown = true;
    console.warn('[limit] REDIS_URL unset; using the in-process bucket, which a restart clears.');
    return undefined;
  }
  try {
    const c = createClient({
      url,
      socket: {
        // The defaults are wrong for this job. `redis` retries a failed
        // connection indefinitely, so `connect()` never rejects and the first
        // request hangs rather than falling back — measured, not assumed.
        connectTimeout: 1_000,
        reconnectStrategy: false,
      },
    });
    // Without a handler, a later connection drop is an unhandled error event
    // that takes the process down — and the proxy should degrade, not die,
    // when its limiter goes away.
    c.on('error', (err) => console.warn('[limit] redis error:', err?.message ?? err));
    // Belt and braces: a socket that accepts and then stalls would still hang
    // the first turn, and no limiter is worth that.
    await Promise.race([
      c.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('connect timed out')), 1_500),
      ),
    ]);
    redis = /** @type {import('redis').RedisClientType} */ (c);
    return redis;
  } catch (err) {
    redisDown = true;
    console.warn(
      `[limit] redis unreachable (${err?.message ?? err}); using the in-process bucket.`,
    );
    return undefined;
  }
}

/**
 * Which client a request counts against.
 *
 * `X-Forwarded-For` is honoured only when TRUST_PROXY is set, because a header
 * anyone can send is a one-line way around the whole limit. Behind a reverse
 * proxy the flag is correct; exposed directly, it is a hole.
 *
 * @param {Request} req
 * @returns {string}
 */
export function clientKey(req) {
  if (process.env.TRUST_PROXY === 'true') {
    const fwd = req.headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
  }
  // Node's fetch-style Request carries no socket address, so the server passes
  // one in on this header before calling through.
  return req.headers.get('x-bench-peer') ?? 'unknown';
}

/**
 * Count one request and say whether it is over budget.
 *
 * @param {string} key - The client, from {@link clientKey}.
 * @returns {Promise<{ allowed: boolean, retryAfter: number, backend: 'redis' | 'memory' }>}
 */
export async function take(key) {
  const c = await client();
  if (c) {
    try {
      const bucket = `bench:rl:${key}`;
      const n = await c.incr(bucket);
      // Only the first request in a window sets the expiry. Setting it every
      // time would slide the window forward and never let the budget reset.
      if (n === 1) await c.expire(bucket, WINDOW);
      const ttl = n > LIMIT ? await c.ttl(bucket) : 0;
      return { allowed: n <= LIMIT, retryAfter: Math.max(ttl, 0), backend: 'redis' };
    } catch (err) {
      console.warn(`[limit] redis call failed (${err?.message ?? err}); falling back.`);
    }
  }

  const now = Date.now();
  const seen = local.get(key);
  if (!seen || now - seen.start >= WINDOW * 1000) {
    local.set(key, { start: now, count: 1 });
    return { allowed: true, retryAfter: 0, backend: 'memory' };
  }
  seen.count += 1;
  const retryAfter = Math.ceil((seen.start + WINDOW * 1000 - now) / 1000);
  return { allowed: seen.count <= LIMIT, retryAfter, backend: 'memory' };
}

/** The configured budget, for `/healthz` to report. */
export const budget = { limit: LIMIT, windowSec: WINDOW };
