/**
 * Discovery: which `.well-known` catalog wins, and what counts as an answer.
 *
 * `fetch` is stubbed per test, keyed by path, so these exercise the order and
 * the fall-through rather than a network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverMcpServer } from '../src/harness/tools/discovery';

const CARD_URL = 'https://mcp.example.com/mcp/server-card';

const CARD = {
  title: 'Example',
  remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
};

const catalog = (url: string) => ({ entries: [{ identifier: 'example', url }] });

type Answer = { status?: number; body?: unknown; html?: boolean };

/** Stub `fetch` with one answer per path, and record the paths asked for. */
function serve(answers: Record<string, Answer>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url);
    const a = answers[url] ?? { status: 404 };
    const status = a.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        // A dev server's index.html fallback: 200, and not JSON.
        if (a.html) throw new SyntaxError("Unexpected token '<'");
        return a.body;
      },
    };
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discoverMcpServer', () => {
  it('takes the server card from ai-catalog.json and never reads the fallback', async () => {
    const asked = serve({
      '/.well-known/ai-catalog.json': { body: catalog(CARD_URL) },
      [CARD_URL]: { body: CARD },
    });

    const info = await discoverMcpServer();

    expect(info.cardUrl).toBe(CARD_URL);
    expect(info.endpoint).toBe('https://mcp.example.com/mcp');
    expect(asked).not.toContain('/.well-known/mcp/catalog.json');
  });

  it('falls back to mcp/catalog.json when ai-catalog.json is missing', async () => {
    const asked = serve({
      '/.well-known/mcp/catalog.json': { body: catalog(CARD_URL) },
      [CARD_URL]: { body: CARD },
    });

    const info = await discoverMcpServer();

    expect(info.cardUrl).toBe(CARD_URL);
    expect(asked.slice(0, 2)).toEqual([
      '/.well-known/ai-catalog.json',
      '/.well-known/mcp/catalog.json',
    ]);
  });

  it('does not read /.well-known/catalog.json, which nothing publishes', async () => {
    const asked = serve({
      '/.well-known/catalog.json': { body: catalog(CARD_URL) },
      [CARD_URL]: { body: CARD },
    });

    await expect(discoverMcpServer()).rejects.toThrow(/No MCP server-card URL/);
    expect(asked).not.toContain('/.well-known/catalog.json');
  });

  it('falls through a dev server answering index.html with a 200', async () => {
    serve({
      '/.well-known/ai-catalog.json': { html: true },
      '/.well-known/mcp/catalog.json': { body: catalog(CARD_URL) },
      [CARD_URL]: { body: CARD },
    });

    const info = await discoverMcpServer();

    expect(info.cardUrl).toBe(CARD_URL);
  });

  it('falls through a catalog whose entries carry no url', async () => {
    serve({
      '/.well-known/ai-catalog.json': { body: { entries: [{ identifier: 'a2a-agent' }] } },
      '/.well-known/mcp/catalog.json': { body: catalog(CARD_URL) },
      [CARD_URL]: { body: CARD },
    });

    const info = await discoverMcpServer();

    expect(info.cardUrl).toBe(CARD_URL);
  });

  it('fails with a clear error when neither catalog answers', async () => {
    serve({});

    await expect(discoverMcpServer()).rejects.toThrow(
      'No MCP server-card URL found in .well-known catalogs',
    );
  });
});
