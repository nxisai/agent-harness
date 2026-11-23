/**
 * The proxy provider, and the contract it holds endpoints to.
 *
 * Every test drives a fake `fetchImpl`, so these exercise the wire handling
 * rather than a network.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentHarness, createProxyProvider } from '../src/index';
import type { ChatMessage, ModelContextToolInfo } from '../src/types';

/** A `fetch` that answers with `body`, and records what it was asked. */
function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, reqInit: RequestInit) => {
    calls.push({ url, init: reqInit });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.status === 500 ? 'Internal Server Error' : 'OK',
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const REQ = {
  messages: [{ role: 'user' as const, content: 'what are your hours?' }],
  tools: [] as ModelContextToolInfo[],
};

describe('which model a remote provider shows', () => {
  it('shows the configured label before anything has answered', () => {
    const p = createProxyProvider({ endpoint: '/api/agent', name: 'claude-proxy', label: 'Claude' });
    expect(p.label).toBe('Claude');
  });

  it('follows the model the endpoint says answered', async () => {
    // An endpoint can route between models, so the response is the only
    // place the true name comes from.
    const { impl } = fakeFetch({ text: 'Open until six.', model: 'Claude Sonnet 5' });
    const p = createProxyProvider({ endpoint: '/api/agent', label: 'Claude', fetchImpl: impl });
    const completion = await p.complete(REQ);
    expect(completion.model).toBe('Claude Sonnet 5');
    expect(p.label).toBe('Claude Sonnet 5');
  });

  it('keeps the last reported model when a later response omits it', async () => {
    const answers = [{ text: 'a', model: 'Claude Sonnet 5' }, { text: 'b' }];
    const impl = (async () => ({ ok: true, status: 200, json: async () => answers.shift() })) as unknown as typeof fetch;
    const p = createProxyProvider({ endpoint: '/api/agent', label: 'Claude', fetchImpl: impl });
    await p.complete(REQ);
    const second = await p.complete(REQ);
    expect(second.model).toBeUndefined();
    expect(p.label).toBe('Claude Sonnet 5');
  });

  it('ignores a model that is not a usable name', async () => {
    const { impl } = fakeFetch({ text: 'a', model: '   ' });
    const p = createProxyProvider({ endpoint: '/api/agent', label: 'Claude', fetchImpl: impl });
    await p.complete(REQ);
    expect(p.label).toBe('Claude');
  });
});

describe('createProxyProvider', () => {
  it('declares itself remote, ready, and with nothing to load', () => {
    const p = createProxyProvider({ endpoint: '/api/agent' });
    expect(p.local).toBe(false);
    expect(p.ready).toBe(true);
    expect(p.loading).toBe(false);
    // The absence of load() is what tells the UI to skip the download
    // treatment, and countTokens' absence hides the token metrics.
    expect(p.load).toBeUndefined();
    expect(p.countTokens).toBeUndefined();
  });

  it('posts the conversation and tools to the endpoint', async () => {
    const { impl, calls } = fakeFetch({ text: 'Seven to five.' });
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl: impl });

    const out = await p.complete({ ...REQ, maxTokens: 256 });

    expect(out.text).toBe('Seven to five.');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/agent');
    expect(calls[0].init.method).toBe('POST');
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.messages).toEqual(REQ.messages);
    expect(sent.maxTokens).toBe(256);
  });

  it('asks for JSON, so streaming can be added later without breaking endpoints', async () => {
    const { impl, calls } = fakeFetch({ text: 'ok' });
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl: impl });
    await p.complete(REQ);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
  });

  it('carries host-supplied headers', async () => {
    const { impl, calls } = fakeFetch({ text: 'ok' });
    const p = createProxyProvider({
      endpoint: '/api/agent',
      headers: { 'X-Demo-Key': 'abc' },
      fetchImpl: impl,
    });
    await p.complete(REQ);
    expect((calls[0].init.headers as Record<string, string>)['X-Demo-Key']).toBe('abc');
  });

  it('serialises a live WebMCP tool without choking on the page it references', async () => {
    // A native registry hands back objects that reference the page. Stringifying
    // one throws "Converting circular structure to JSON ... constructor
    // 'Window'", which reaches the visitor as a failed turn.
    const live: Record<string, unknown> = {
      name: 'booking-form',
      description: 'Book a visit',
      inputSchema: { type: 'object', properties: { day: { type: 'string' } } },
      execute() {},
    };
    live.ownerWindow = live; // the cycle, in miniature

    const { impl, calls } = fakeFetch({ text: 'ok' });
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl: impl });

    await expect(
      p.complete({ ...REQ, tools: [live as unknown as ModelContextToolInfo] }),
    ).resolves.toBeDefined();

    // Only the three fields an endpoint needs, and nothing that points back.
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.tools).toEqual([
      {
        name: 'booking-form',
        description: 'Book a visit',
        inputSchema: { type: 'object', properties: { day: { type: 'string' } } },
      },
    ]);
  });

  it('normalises the schema whichever key it arrived under', async () => {
    const { impl, calls } = fakeFetch({ text: 'ok' });
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl: impl });
    await p.complete({
      ...REQ,
      // WebMCP carries the schema under four names, sometimes as a string.
      tools: [{ name: 'quote-form', parameters: '{"type":"object"}' } as unknown as ModelContextToolInfo],
    });
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.tools[0].inputSchema.type).toBe('object');
  });

  it('passes a tool call through', async () => {
    const { impl } = fakeFetch({
      text: 'Booking that.',
      call: { name: 'booking-form', args: { day: 'Thursday' } },
    });
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl: impl });
    const out = await p.complete(REQ);
    expect(out.call).toEqual({ name: 'booking-form', args: { day: 'Thursday' } });
  });

  it('reduces several tool calls to one and says which it dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { impl } = fakeFetch({
      text: '',
      calls: [
        { name: 'booking-form', args: {} },
        { name: 'quote-form', args: {} },
      ],
    });
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl: impl });

    const out = await p.complete(REQ);

    // The harness runs one tool per turn; silently dropping the rest is how an
    // endpoint author learns nothing.
    expect(out.call?.name).toBe('booking-form');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quote-form'));
    warn.mockRestore();
  });

  it('reports usage when the endpoint sends it, and omits it otherwise', async () => {
    const withUsage = fakeFetch({ text: 'ok', usage: { promptTokens: 812, outputTokens: 47 } });
    const a = createProxyProvider({ endpoint: '/x', fetchImpl: withUsage.impl });
    expect((await a.complete(REQ)).usage).toEqual({ promptTokens: 812, outputTokens: 47 });

    const without = fakeFetch({ text: 'ok' });
    const b = createProxyProvider({ endpoint: '/x', fetchImpl: without.impl });
    expect((await b.complete(REQ)).usage).toBeUndefined();
  });

  it('survives an endpoint that omits text', async () => {
    const { impl } = fakeFetch({ call: { name: 'booking-form', args: {} } });
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl: impl });
    // Rendered verbatim, so it has to be a string whatever arrived.
    expect((await p.complete(REQ)).text).toBe('');
  });

  it('throws with the status when the endpoint fails', async () => {
    const { impl } = fakeFetch({}, { ok: false, status: 500 });
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl: impl });
    await expect(p.complete(REQ)).rejects.toThrow(/500/);
  });
});

describe('the proxy provider under a stopped turn', () => {
  /** A fetch that hangs until its signal fires, as a real one does. */
  const hangingFetch = (() =>
    ((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        if (init.signal?.aborted) return rej(err);
        init.signal?.addEventListener('abort', () => rej(err), { once: true });
      })) as unknown as typeof fetch)();

  const recorder = () => {
    const said: string[] = [];
    const bubble = { thinking() {}, update() {}, finalize: (t: string) => t && said.push(t) };
    return {
      said,
      renderer: {
        streaming: () => bubble,
        message: (_r: string, t: string) => said.push(t),
        status() {},
        results() {},
        detail() {},
        toolError() {},
        dismissPrompt() {},
      } as never,
    };
  };

  it('threads the signal, so stopping a turn actually stops it', async () => {
    const provider = createProxyProvider({ endpoint: '/api/agent', fetchImpl: hangingFetch });
    const { said, renderer } = recorder();
    const harness = new AgentHarness({
      provider,
      renderer,
      toolSource: {
        discoverTools: async () => [
          { name: 'nxis_query', annotations: { readOnlyHint: true } } as ModelContextToolInfo,
        ],
      } as never,
    });

    const messages: ChatMessage[] = [];
    const turn = harness.turn('what are your hours?', messages);
    await Promise.resolve();
    harness.stop();

    // An AbortError is a cancellation, not a failure: the turn resolves.
    await expect(turn).resolves.toEqual({ decision: 'stopped' });
    expect(said).toEqual([]);
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'what are your hours?',
    ]);
  });
});
