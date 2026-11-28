// @vitest-environment happy-dom
/**
 * Handoff targets from A2A Agent Cards: NxisAI's relay serves the site's specialists as cards at
 * `<edge>/v1/s/<site>/agents`, beside `…/handoff`, and a self-deployed site names its own cards per target.
 *
 * Covered: cards become the handoff tools, described from the card's description and skills; they are read as the
 * element boots, so the tools are on the page before the chat opens; a card that points anywhere but the relay is
 * ignored; a page's own `targets` work as before, merged with the cards; a specialist paused since the last read is gone from the next turn; the ETag is sent back; a self-deployed
 * card is read with the same parser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';
import { HandoffController, TRANSFER_TO_AGENT_TOOL, TALK_TO_A_PERSON_TOOL, buildEnvelope, buildHandoffTools } from '../src/handoff/index';
import { briefOf, cardsUrl, readAgentCard, trustedRelayCard } from '../src/handoff/cards';
import { refreshHandoffTools } from '../src/handoff/tools';
import { AgentHarness } from '../src/harness/harness';
import { settle } from './helpers/guard';
import type { Completion, CompletionRequest } from '../src/providers/types';
import type { ModelContextTool, ModelContextToolInfo } from '../src/types';

const EDGE = 'https://agents.example';
const RELAY = `${EDGE}/v1/s/site-1/handoff`;
const AGENTS = `${EDGE}/v1/s/site-1/agents`;
const EXT = 'https://nxis.ai/a2a/handoff/v1';

/** A card as the edge serves it. */
function card(target: string, opts: { label?: string; kind?: 'agent' | 'person'; url?: string; description?: string } = {}) {
  const label = opts.label ?? target[0].toUpperCase() + target.slice(1);
  return {
    name: label,
    description: opts.description ?? `Answers ${target} questions from the site's help content.`,
    url: opts.url ?? `${RELAY}/${target}`,
    version: '1.0.0',
    capabilities: {
      streaming: true,
      extensions: [{ uri: EXT, required: false, params: { target, kind: opts.kind ?? 'agent', label } }],
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: `${target}-skill`,
        name: `Handle ${target}`,
        description: `Settles a ${target} request end to end.`,
        examples: [`I have a ${target} question`, 'second example', 'third, never shown'],
      },
    ],
  };
}

interface Edge {
  cards: unknown[];
  listed: { name: string; kind?: string; label?: string; available?: boolean; description?: string }[];
  etag?: string;
  agentsStatus?: number;
}

/** NxisAI's relay and its card list, as a fake `fetch`. */
function fakeEdge(edge: Edge) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = Object.fromEntries([...new Headers(init?.headers).entries()].map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ url: u, headers });
    if (u === AGENTS) {
      if (edge.agentsStatus) return new Response('{}', { status: edge.agentsStatus });
      if (edge.etag && headers['if-none-match'] === edge.etag) return new Response(null, { status: 304, headers: { ETag: edge.etag } });
      return new Response(JSON.stringify({ agents: edge.cards }), {
        headers: { 'content-type': 'application/json', ...(edge.etag ? { ETag: edge.etag } : {}) },
      });
    }
    if (u === RELAY) return new Response(JSON.stringify({ targets: edge.listed }), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

const listedAs = (...names: string[]) => names.map((name) => ({ name, kind: 'agent', label: name, available: true, transcript: false }));

afterEach(() => vi.restoreAllMocks());

describe('cards become the handoff tools', () => {
  it('offers each card the relay lists, described from its description and skills, with no targets in the config', async () => {
    const edge = fakeEdge({ cards: [card('support'), card('booking', { label: 'Booking' })], listed: listedAs('support', 'booking') });
    const controller = new HandoffController({ relay: RELAY, fetchImpl: edge.fetchImpl, storage: null });
    const tools = await buildHandoffTools(controller, { conversationId: () => 'conv-1' });
    expect(tools.map((t) => t.name)).toEqual([TRANSFER_TO_AGENT_TOOL]);
    const [tool] = tools;
    expect((tool.inputSchema as any).properties.target.enum).toEqual(['support', 'booking']);
    expect(tool.description).toContain('"support" (Support: Answers support questions from the site\'s help content.');
    expect(tool.description).toContain('Skills: Handle booking: Settles a booking request end to end. (e.g. "I have a booking question", "second example")');
    expect(tool.description).not.toContain('third, never shown');
    // An empty `targets` map is the same as none.
    const empty = new HandoffController({ relay: RELAY, targets: {}, fetchImpl: edge.fetchImpl, storage: null });
    expect((await empty.targets()).map((t) => t.name)).toEqual(['support', 'booking']);
  });

  it('takes a person card as a person, for talk_to_a_person', async () => {
    const edge = fakeEdge({ cards: [card('desk', { kind: 'person', label: 'The team' })], listed: listedAs('desk') });
    const controller = new HandoffController({ relay: RELAY, fetchImpl: edge.fetchImpl, storage: null });
    expect((await buildHandoffTools(controller, { conversationId: () => 'c' })).map((t) => t.name)).toEqual([TALK_TO_A_PERSON_TOOL]);
  });

  it('offers only the cards the relay also lists: a card the relay would not reach is not offered', async () => {
    const edge = fakeEdge({ cards: [card('support'), card('quote')], listed: listedAs('support') });
    const controller = new HandoffController({ relay: RELAY, fetchImpl: edge.fetchImpl, storage: null });
    expect((await controller.targets()).map((t) => t.name)).toEqual(['support']);
  });

  it('starts a handoff to a target known only from its card', async () => {
    const edge = fakeEdge({ cards: [card('support')], listed: listedAs('support') });
    const controller = new HandoffController({ relay: RELAY, fetchImpl: edge.fetchImpl, storage: null });
    await controller.targets();
    // The POST answers 404 here: what matters is that the controller knows the target and tried the relay for it.
    const envelope = buildEnvelope({ target: 'support', reason: 'Help', summary: 'Needs help.', conversationId: 'conv-1' });
    await expect(controller.start('conv-1', 'support', envelope)).rejects.toThrow();
    expect(controller.session('conv-1')?.label).toBe('Support');
    expect(edge.requests.some((r) => r.url === `${RELAY}/support`)).toBe(true);
  });
});

describe('cards load with the element', () => {
  it('registers the handoff tool as the element boots, before the chat opens, and opening registers nothing twice', async () => {
    const edge = fakeEdge({ cards: [card('support')], listed: listedAs('support') });
    const registered: ModelContextTool[] = [];
    (document as any).modelContext = Object.assign(new EventTarget(), {
      getTools: async () => registered.map(({ execute: _e, ...info }) => info),
      registerTool: async (t: ModelContextTool) => void registered.push(t),
      executeTool: async () => ({ content: [] }),
    });
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    el.setAttribute('site-actions', 'false');
    document.body.append(el);
    el.handoff = { relay: RELAY, fetchImpl: edge.fetchImpl };
    for (let i = 0; i < 200 && !registered.length; i++) await settle(5);
    expect(el.isOpen).toBe(false);
    expect(registered.map((t) => t.name)).toEqual([TRANSFER_TO_AGENT_TOOL]);
    expect(edge.requests.map((r) => r.url).sort()).toEqual([AGENTS, RELAY]);
    el.open();
    await settle(50);
    expect(registered.map((t) => t.name)).toEqual([TRANSFER_TO_AGENT_TOOL]);
    // The targets are kept thirty seconds: opening reads nothing again.
    expect(edge.requests).toHaveLength(2);
    el.remove();
    delete (document as any).modelContext;
  });

  it('reads nothing until the targets are asked for, then keeps them thirty seconds', async () => {
    const edge = fakeEdge({ cards: [card('support')], listed: listedAs('support') });
    let now = 1_000;
    const controller = new HandoffController({ relay: RELAY, fetchImpl: edge.fetchImpl, storage: null, now: () => now });
    expect(edge.requests).toHaveLength(0);
    await controller.targets();
    await controller.targets();
    expect(edge.requests).toHaveLength(2);
    now += 31_000;
    await controller.targets();
    expect(edge.requests).toHaveLength(4);
  });

  it('sends the ETag back, and keeps the cards it has on a 304', async () => {
    const edge = fakeEdge({ cards: [card('support')], listed: listedAs('support'), etag: '"v1"' });
    let now = 0;
    const controller = new HandoffController({ relay: RELAY, fetchImpl: edge.fetchImpl, storage: null, now: () => now });
    await controller.targets();
    now += 31_000;
    expect((await controller.targets()).map((t) => t.name)).toEqual(['support']);
    const reads = edge.requests.filter((r) => r.url === AGENTS);
    expect(reads[0].headers['if-none-match']).toBeUndefined();
    expect(reads[1].headers['if-none-match']).toBe('"v1"');
  });
});

describe('only cards from the configured relay are trusted', () => {
  it('ignores a card whose url is on another origin, another path, or another target', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const edge = fakeEdge({
      cards: [
        card('support'),
        card('evil', { url: 'https://attacker.example/v1/s/site-1/handoff/evil' }),
        card('other', { url: `${EDGE}/v1/s/site-2/handoff/other` }),
        card('swap', { url: `${RELAY}/support` }),
        card('query', { url: `${RELAY}/query?to=elsewhere` }),
      ],
      listed: listedAs('support', 'evil', 'other', 'swap', 'query'),
    });
    const controller = new HandoffController({ relay: RELAY, fetchImpl: edge.fetchImpl, storage: null });
    expect((await controller.targets()).map((t) => t.name)).toEqual(['support']);
  });

  it('checks a card against the relay with the rules the list uses', () => {
    const relay = new URL(RELAY);
    expect(cardsUrl(relay)?.href).toBe(AGENTS);
    expect(cardsUrl(new URL('https://site.example/api/relay'))).toBeNull();
    const ok = readAgentCard(card('support'), AGENTS)!;
    expect(trustedRelayCard(ok, relay)).toBe(true);
    const relative = readAgentCard(card('support', { url: '/v1/s/site-1/handoff/support' }), AGENTS)!;
    expect(trustedRelayCard(relative, relay)).toBe(true);
    const noTarget = readAgentCard({ name: 'Support', url: `${RELAY}/support` }, AGENTS)!;
    expect(trustedRelayCard(noTarget, relay)).toBe(false);
    expect(readAgentCard('not a card', AGENTS)).toBeNull();
    expect(readAgentCard({ description: 'no name' }, AGENTS)).toBeNull();
  });

  it('offers nothing new when the card list cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const edge = fakeEdge({ cards: [], listed: listedAs('support'), agentsStatus: 500 });
    const controller = new HandoffController({ relay: RELAY, fetchImpl: edge.fetchImpl, storage: null });
    expect(await controller.targets()).toEqual([]);
  });
});

describe('a page config with targets', () => {
  it('works as before, the config deciding kind, label and description, merged with the cards', async () => {
    const edge = fakeEdge({
      cards: [card('support'), card('booking')],
      listed: [...listedAs('support', 'booking'), { name: 'team', kind: 'person', label: 'x', available: false }],
    });
    const controller = new HandoffController({
      relay: RELAY,
      targets: {
        support: { kind: 'agent', label: 'Help desk', description: 'answers help questions' },
        team: { kind: 'person', label: 'Our team', takes: ['contact_form'] },
      },
      fetchImpl: edge.fetchImpl,
      storage: null,
    });
    const targets = await controller.targets();
    expect(targets.map((t) => [t.name, t.kind, t.label, t.available])).toEqual([
      ['support', 'agent', 'Help desk', true],
      ['booking', 'agent', 'Booking', true],
      ['team', 'person', 'Our team', false],
    ]);
    expect(targets[0].description).toBe('answers help questions');
    expect(targets[0].brief).toContain('Skills: Handle support');
    expect(targets[2].takes).toEqual(['contact_form']);
  });

  it('keeps a self-deployed relay with no card list working, and asks for the list only once', async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      if (String(url) === '/api/handoff') return new Response(JSON.stringify({ targets: listedAs('booking') }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    let now = 0;
    const controller = new HandoffController({
      relay: '/api/handoff',
      targets: { booking: { kind: 'agent', label: 'Booking', description: 'books a visit' } },
      fetchImpl,
      storage: null,
      now: () => now,
    });
    const tools = await buildHandoffTools(controller, { conversationId: () => 'c' });
    expect(tools[0].description).toContain('"booking" (Booking: books a visit; available)');
    now += 31_000;
    await controller.targets();
    expect(requests.filter((u) => u.endsWith('/api/agents'))).toHaveLength(1);
  });

  it("reads a self-deployed site's own card for a target, on the relay's origin only", async () => {
    const own = {
      // As a self-deployed site publishes it: no `url`, the endpoint in `supportedInterfaces`, no extension params.
      name: 'The Copperline team',
      description: 'A person at Copperline Home Services.',
      supportedInterfaces: [{ url: `${location.origin}/a2a/desk`, protocolBinding: 'JSONRPC' }],
      capabilities: { extensions: [{ uri: EXT, required: false }] },
      skills: [{ id: 'talk', name: 'Talk to a person', description: 'Anything the assistant could not settle.' }],
    };
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      requests.push(u);
      if (u === '/api/handoff') return new Response(JSON.stringify({ targets: [{ name: 'team', available: true }, { name: 'far', available: true }] }));
      if (u === `${location.origin}/a2a/desk/agent-card.json`) return new Response(JSON.stringify(own));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const controller = new HandoffController({
      relay: '/api/handoff',
      targets: {
        team: { kind: 'person', label: 'The Copperline team', description: 'a person at the office', card: '/a2a/desk/agent-card.json' },
        far: { kind: 'agent', label: 'Far', card: 'https://elsewhere.example/a2a/far/agent-card.json' },
      },
      fetchImpl,
      storage: null,
    });
    const [team, far] = await controller.targets();
    expect(team.description).toBe('a person at the office');
    expect(team.brief).toBe('A person at Copperline Home Services. Skills: Talk to a person: Anything the assistant could not settle.');
    expect(far.brief).toBeUndefined();
    expect(requests).not.toContain('https://elsewhere.example/a2a/far/agent-card.json');
  });
});

describe('a specialist paused since the last read', () => {
  it('is gone from the next turn once the cards are read again', async () => {
    const edge = fakeEdge({ cards: [card('support'), card('booking')], listed: listedAs('support', 'booking') });
    let now = 0;
    const controller = new HandoffController({ relay: RELAY, fetchImpl: edge.fetchImpl, storage: null, now: () => now });
    // Registered once, at the first open, with both specialists.
    const handoffTools = await buildHandoffTools(controller, { conversationId: () => 'conv-1' });
    const page: ModelContextToolInfo = { name: 'contact_form', description: 'Contact us', inputSchema: { type: 'object', properties: {} } };
    const tools = [page, ...handoffTools];
    const offered: ModelContextToolInfo[][] = [];
    const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
      offered.push(req.tools as ModelContextToolInfo[]);
      return { text: 'Sure.' };
    });
    const harness = new AgentHarness({
      provider: { name: 's', label: 's', local: false, ready: true, loading: false, complete } as never,
      toolSource: { discoverTools: async () => tools, execTool: vi.fn(), modelContext: () => null } as never,
      renderer: { streaming: () => ({ thinking() {}, update() {}, finalize() {} }), message() {}, status() {}, results() {}, detail() {} } as never,
      recommend: false,
      handoff: () => controller,
    });
    await harness.turn('hello', []);
    const enumOf = (ts: ModelContextToolInfo[]) => (ts.find((t) => t.name === TRANSFER_TO_AGENT_TOOL)?.inputSchema as any)?.properties.target.enum;
    expect(enumOf(offered[0])).toEqual(['support', 'booking']);

    // Booking is paused: the edge drops its card. Within thirty seconds the turn still has it; after, it doesn't.
    const paused = fakeEdge({ cards: [card('support')], listed: listedAs('support', 'booking') });
    (edge.fetchImpl as any).mockImplementation((paused.fetchImpl as any).getMockImplementation());
    now += 31_000;
    await harness.turn('again', []);
    expect(enumOf(offered[1])).toEqual(['support']);
    expect(offered[1].find((t) => t.name === TRANSFER_TO_AGENT_TOOL)?.description).not.toContain('"booking"');

    // And with every specialist paused, the tool is left out of the turn altogether.
    const none = fakeEdge({ cards: [], listed: listedAs('support', 'booking') });
    (edge.fetchImpl as any).mockImplementation((none.fetchImpl as any).getMockImplementation());
    now += 31_000;
    await harness.turn('once more', []);
    expect(offered[2].map((t) => t.name)).toEqual(['contact_form']);
  });

  it('refreshes only the handoff tools, and keeps a turn as it was while the relay is slow', () => {
    const other: ModelContextToolInfo = { name: 'search', description: 'Search', inputSchema: { type: 'object' } };
    const stale: ModelContextToolInfo = { name: TRANSFER_TO_AGENT_TOOL, description: 'old', inputSchema: { type: 'object' } };
    const fresh = refreshHandoffTools([other, stale], [
      { name: 'support', kind: 'agent', label: 'Support', available: true, transcript: false, brief: 'Answers support questions.' },
    ]);
    expect(fresh[0]).toBe(other);
    expect(fresh[1].description).toContain('"support" (Support: Answers support questions.; available)');
    expect(briefOf({ description: 'Books visits.', skills: [] })).toBe('Books visits.');
  });
});
