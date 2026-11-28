// @vitest-environment happy-dom
/**
 * The element's WebMCP tools register as it boots on the page, not when the chat opens: a browser agent reads
 * `document.modelContext` and never opens the chat.
 *
 * Covered: the site's remote tools, the navigation tools and the handoff tool are registered before any open, with
 * no model call; opening the chat afterwards registers nothing again and fires no `toolchange`; a second page load in
 * the same tab registers them from what the first kept, reading no catalog and opening no MCP session; WebMCP mode
 * "none" registers nothing until the chat opens; a contained preview registers and fetches nothing.
 *
 * The MCP session is a stub (`connectMcp` mocked); discovery and the relay are a stubbed `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => {
  const tool = (name: string) => ({
    name,
    description: `The site's ${name}.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  });
  const client = {
    listTools: async () => ({ tools: ['nxis_list_types', 'nxis_query', 'nxis_get'].map(tool) }),
    // Every typed read answers with no records: no site actions, no page records.
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ results: [], total: 0 }) }] }),
  };
  return { client, connectMcp: vi.fn(async () => client) };
});
vi.mock('../src/harness/tools/client', () => ({ connectMcp: remote.connectMcp }));

import '../src/ui/agent';
import { LocalModelContext } from '../src/harness/tools/local-context';
import { TRANSFER_TO_AGENT_TOOL } from '../src/handoff/index';
import { settle } from './helpers/guard';

const CARD_URL = 'https://mcp.example.com/mcp/server-card';
const CARD = { title: 'Example', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] };
const RELAY = 'https://agents.example/v1/s/site-1/handoff';
const AGENTS = 'https://agents.example/v1/s/site-1/agents';
const TARGETS = { targets: [{ name: 'quote', kind: 'agent', label: 'Quote', available: true, transcript: false }] };
/** The relay's agent card for the target, as the edge serves it. */
const CARDS = {
  agents: [
    {
      name: 'Quote',
      description: 'Prepares a quote.',
      url: `${RELAY}/quote`,
      version: '1.0.0',
      capabilities: {
        streaming: true,
        extensions: [{ uri: 'https://nxis.ai/a2a/handoff/v1', required: false, params: { target: 'quote', kind: 'agent', label: 'Quote' } }],
      },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [{ id: 'quote', name: 'Quote', description: 'Prepares a quote.' }],
    },
  ],
};
const SITE_TOOLS = ['nxis_get', 'nxis_list_types', 'nxis_query', 'open_page', 'page_links'];

let fetchSpy: ReturnType<typeof vi.fn>;
let mc: LocalModelContext;
let registerSpy: ReturnType<typeof vi.spyOn>;
let changes: number;

/** The page's registry, fresh: a new page load. */
function freshRegistry(): void {
  mc = new LocalModelContext();
  registerSpy = vi.spyOn(mc, 'registerTool');
  changes = 0;
  mc.addEventListener('toolchange', () => changes++);
  (document as any).modelContext = mc;
}

/** A stub provider: registering must never ask it anything. */
const provider = () => ({
  name: 'Stub',
  local: false,
  ready: true,
  loading: false,
  load: vi.fn(async () => {}),
  complete: vi.fn(async () => ({ text: 'Hello.' })),
});

/** Mounted the way the site tag does: properties first, then into the page. */
function mount(handoff = true): any {
  const el = document.createElement('nxis-agent') as any;
  el.setAttribute('preload', 'none');
  el.modelProvider = provider();
  if (handoff) el.handoff = { relay: RELAY, fetchImpl: fetchSpy };
  document.body.append(el);
  return el;
}

const names = async () => (await mc.getTools()).map((t) => t.name).sort();
const wanted = [...SITE_TOOLS, TRANSFER_TO_AGENT_TOOL].sort();

/** Wait until the registry holds `n` tools. */
async function until(n: number): Promise<void> {
  for (let i = 0; i < 400 && (await mc.getTools()).length < n; i++) await settle(5);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  remote.connectMcp.mockClear();
  delete (window as any).__NXIS_CONFIG__;
  fetchSpy = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u === '/.well-known/ai-catalog.json') return new Response(JSON.stringify({ entries: [{ identifier: 'mcp', url: CARD_URL }] }));
    if (u === CARD_URL) return new Response(JSON.stringify(CARD));
    if (u === RELAY) return new Response(JSON.stringify(TARGETS), { headers: { 'content-type': 'application/json' } });
    if (u === AGENTS) return new Response(JSON.stringify(CARDS), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  freshRegistry();
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (document as any).modelContext;
  delete (window as any).__NXIS_CONFIG__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tools register at page load', () => {
  it('registers the site tools and the handoff tool before the chat opens, without asking the model', async () => {
    const el = mount();
    await until(wanted.length);
    expect(el.isOpen).toBe(false);
    expect(await names()).toEqual(wanted);
    expect(el.provider.complete).not.toHaveBeenCalled();
    expect(el.provider.load).not.toHaveBeenCalled();
    expect(remote.connectMcp).toHaveBeenCalledTimes(1);
  });

  it('opening the chat afterwards duplicates nothing and fires no toolchange', async () => {
    const el = mount();
    await until(wanted.length);
    await settle(20);
    const registered = registerSpy.mock.calls.length;
    const changed = changes;
    const requests = fetchSpy.mock.calls.length;

    el.open();
    await el._connectTools();
    await settle(50);

    expect(el.isOpen).toBe(true);
    expect(await names()).toEqual(wanted);
    expect(registerSpy.mock.calls.length).toBe(registered);
    expect(changes).toBe(changed);
    expect(fetchSpy.mock.calls.length).toBe(requests);
    expect(remote.connectMcp).toHaveBeenCalledTimes(1);
  });

  it('a second page in the same tab registers the same tools from what the first kept: no catalog read, no MCP session', async () => {
    mount(false);
    await until(SITE_TOOLS.length);
    expect(await names()).toEqual(SITE_TOOLS);
    document.body.innerHTML = '';

    // The next page: a new registry, the same tab.
    freshRegistry();
    fetchSpy.mockClear();
    remote.connectMcp.mockClear();
    const el = mount(false);
    await until(SITE_TOOLS.length);
    expect(el.isOpen).toBe(false);
    expect(await names()).toEqual(SITE_TOOLS);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).not.toContain('/.well-known/ai-catalog.json');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(remote.connectMcp).not.toHaveBeenCalled();

    // The session opens when a tool first runs.
    const query = (await mc.getTools()).find((t) => t.name === 'nxis_query')!;
    await mc.executeTool(query as never, {});
    expect(remote.connectMcp).toHaveBeenCalledTimes(1);
  });

  it('WebMCP mode "none" registers nothing on load; opening the chat still brings the tools', async () => {
    (window as any).__NXIS_CONFIG__ = { webmcp: { mode: 'none' } };
    const el = mount();
    await settle(100);
    expect(await names()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    el.open();
    await until(wanted.length);
    expect(await names()).toEqual(wanted);
  });

  it('a contained preview registers nothing and fetches nothing', async () => {
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('contained', '');
    el.modelProvider = provider();
    document.body.append(el);
    await settle(100);
    expect(await names()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
