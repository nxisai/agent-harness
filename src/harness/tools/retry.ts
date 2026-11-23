/**
 * Waiting out a server that is rate limiting us.
 *
 * The site's MCP server answers a read over its limit with the limit, and how
 * long to wait: "You have used all 3 read requests allowed per 60s on the public
 * plan. Retry after 52s." That is an instruction, not a failure — a turn that
 * gives up on it tells the visitor the site has no data, which is false, and a
 * turn that retries immediately makes it worse.
 *
 * The wait is the server's number, never a guess of ours, and it is bounded: a
 * visitor is owed an answer sooner than a minute, so a long wait is refused and
 * reported rather than sat through.
 *
 * @module
 */

/** How many times a rate-limited call is retried, by default. */
const ATTEMPTS = 2;
/** The longest we will wait on one attempt. Past this, the visitor is told. */
const MAX_WAIT_MS = 60_000;

/** "Retry after 52s", "retry-after: 52", "try again in 52 seconds". */
const AFTER = /retry[-\s]?after:?\s*(\d+)\s*(s|sec|secs|seconds)?\b|try again in\s*(\d+)\s*(s|sec|secs|seconds)\b/i;
/** What a server says when it is us, not the request, that it is refusing. */
const LIMITED = /rate[-\s]?limit|resource[-_\s]?exhausted|too many requests|requests allowed per|429/i;

const textOf = (err: unknown): string => {
  if (typeof err === 'string') return err;
  const e = err as { message?: string; content?: { text?: string }[] };
  const message = typeof e?.message === 'string' ? e.message : '';
  const content = Array.isArray(e?.content) ? e.content.map((c) => c?.text ?? '').join(' ') : '';
  return `${message} ${content}`.trim();
};

/**
 * Whether a failure is the server asking us to wait.
 *
 * Read from what it said. The transport carries a numeric code too, but each
 * hop maps it differently, and the sentence survives every hop.
 */
export function isRateLimited(err: unknown): boolean {
  const text = textOf(err);
  return LIMITED.test(text) || AFTER.test(text);
}

/**
 * How long the server asked us to wait, in milliseconds.
 *
 * @returns The advised wait, or null when it named none.
 */
export function retryAfterMs(err: unknown): number | null {
  const match = AFTER.exec(textOf(err));
  if (!match) return null;
  const seconds = Number(match[1] ?? match[3]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** Overrides, so the waiting can be exercised without spending it. */
export interface RetryOptions {
  /** Retries after the first try. Defaults to two. */
  attempts?: number;
  /** The longest single wait to accept. Defaults to a minute. */
  maxWaitMs?: number;
  /** Abort while waiting. */
  signal?: AbortSignal;
  /** How to wait. Replaced in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Told before each wait, for a surface that wants to say "one moment". */
  onWait?: (ms: number, err: unknown) => void;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

/**
 * Run a call, waiting out a rate limit as the server asked.
 *
 * Anything else — a network failure, a bad request, a tool that refused — is
 * raised as it happened: this waits for permission, it does not paper over
 * errors by trying again.
 *
 * @param run - The call, run afresh on each attempt.
 * @param opts - Attempts, ceiling, the clock and the abort signal.
 */
export async function withRetry<T>(run: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? ATTEMPTS;
  const ceiling = opts.maxWaitMs ?? MAX_WAIT_MS;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const advised = retryAfterMs(err);
      const waitable = isRateLimited(err) && attempt < attempts;
      // A wait longer than the ceiling is the server saying "not for a while":
      // sitting on it would hold the turn open with nothing happening.
      if (!waitable || (advised ?? 0) > ceiling) throw err;
      // A limit with no number attached: back off, so a second client does not
      // retry in lockstep with this one.
      const wait = advised ?? Math.min(ceiling, 1000 * 2 ** attempt + Math.floor(Math.random() * 400));
      opts.onWait?.(wait, err);
      await sleep(wait, opts.signal);
    }
  }
}
