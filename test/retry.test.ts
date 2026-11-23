/**
 * Waiting out a rate limit, as the server asked.
 *
 * The site's MCP server answers a read over its limit with the limit and how
 * long to wait. Every wait here is injected, so the cases are exercised without
 * spending the minute the server asked for.
 */
import { describe, expect, it, vi } from 'vitest';
import { isRateLimited, retryAfterMs, withRetry } from '../src/harness/tools/retry';

/** What the server actually says, over the wire, on the public plan. */
const LIMIT =
  'You have used all 3 read requests allowed per 60s on the public plan. Retry after 52s. ' +
  'Authenticate with an API key or OAuth 2.1 for a higher limit.';

describe('recognising a rate limit', () => {
  it('reads the server’s own sentence, however it arrives', () => {
    expect(isRateLimited(new Error(LIMIT))).toBe(true);
    expect(isRateLimited(LIMIT)).toBe(true);
    // A tool response that reports the refusal in its content rather than throwing.
    expect(isRateLimited({ isError: true, content: [{ type: 'text', text: LIMIT }] })).toBe(true);
    expect(isRateLimited(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isRateLimited(new Error('RESOURCE_NOT_FOUND'))).toBe(false);
    expect(isRateLimited(new Error('Failed to fetch'))).toBe(false);
  });

  it('takes the wait from the server, not from a guess', () => {
    expect(retryAfterMs(new Error(LIMIT))).toBe(52_000);
    expect(retryAfterMs(new Error('retry-after: 7'))).toBe(7000);
    expect(retryAfterMs(new Error('try again in 3 seconds'))).toBe(3000);
    expect(retryAfterMs(new Error('rate limited'))).toBeNull();
  });
});

describe('waiting it out', () => {
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => void sleeps.push(ms));
  const limited = () => Object.assign(new Error(LIMIT), { code: 8 });

  it('waits the advised time, then returns the answer', async () => {
    sleeps.length = 0;
    const run = vi.fn().mockRejectedValueOnce(limited()).mockResolvedValue('records');
    await expect(withRetry(run, { sleep })).resolves.toBe('records');
    expect(sleeps).toEqual([52_000]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('gives up once the attempts are spent, and says what the server said', async () => {
    sleeps.length = 0;
    const run = vi.fn().mockRejectedValue(limited());
    await expect(withRetry(run, { attempts: 1, sleep })).rejects.toThrow(/Retry after 52s/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refuses a wait longer than a visitor would sit through', async () => {
    const run = vi.fn().mockRejectedValue(new Error('Rate limited. Retry after 300s.'));
    await expect(withRetry(run, { sleep })).rejects.toThrow(/300s/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('backs off when the server names no time', async () => {
    sleeps.length = 0;
    const run = vi.fn().mockRejectedValueOnce(new Error('rate limit exceeded')).mockResolvedValue('ok');
    await expect(withRetry(run, { sleep })).resolves.toBe('ok');
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]).toBeLessThan(1500);
  });

  it('raises anything that is not a rate limit, first time', async () => {
    const run = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    await expect(withRetry(run, { sleep })).rejects.toThrow('Failed to fetch');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the turn is abandoned', async () => {
    const controller = new AbortController();
    const run = vi.fn().mockRejectedValue(limited());
    const waiting = withRetry(run, {
      sleep: (_ms, signal) =>
        new Promise((_res, rej) => {
          if (signal?.aborted) return rej(new Error('stopped'));
          signal?.addEventListener('abort', () => rej(new Error('stopped')), { once: true });
        }),
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toThrow('stopped');
  });
});
