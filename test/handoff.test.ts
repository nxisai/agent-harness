/**
 * Handoffs to agents and people, against a relay that answers as A2A 1.0 does.
 *
 * The relay here is a fake `fetch`: each target is a script of answers, and a
 * streamed answer is written out as server-sent events, byte for byte as a real
 * relay passes them through. Every path the lifecycle table in docs/handoff.md
 * names is walked: queued, active, a question back, a hand-back, a stream the
 * host cut off, a reload, a refusal and the visitor leaving.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  A2AClient,
  HANDOFF_EXTENSION,
  HANDOFF_KEY_HEADER,
  HANDOFF_SESSION_RESULT,
  HandoffController,
  TALK_TO_A_PERSON_TOOL,
  TRANSFER_TO_AGENT_TOOL,
  buildEnvelope,
  buildHandoffTools,
  cleanPageUrl,
  normaliseResponse,
  readHandBack,
  registerHandoffTools,
  type A2AStreamResponse,
  type HandoffEvent,
} from '../src/handoff/index';
import { AgentCoordinator } from '../src/harness/router/coordinator';
import { mcpCatalogEntry } from '../src/harness/tools/discovery';
import { policyFor, decide } from '../src/harness/policy';
import type { AgentHarness } from '../src/harness/harness';
import type { ChatMessage, ModelContext, ModelContextTool } from '../src/types';

const RELAY = '/api/handoff';
const KEY = 'k-visitor-1';

/** A Storage that lives in memory, as `localStorage` would across page loads. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

type Answer =
  | { events: A2AStreamResponse[]; headers?: Record<string, string> }
  | { result: unknown }
  | { status: number; retryAfter?: number };

interface Call {
  target: string;
  method: string;
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A relay whose targets answer from scripts, in order. */
function fakeRelay(
  scripts: Record<string, Answer[]>,
  listed = [
    { name: 'booking', kind: 'agent', label: 'Booking', available: true, transcript: false },
    { name: 'team', kind: 'person', label: 'Our team', available: true, transcript: true, waitMinutes: 4 },
  ],
) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!init?.method || init.method === 'GET') {
      return new Response(JSON.stringify({ targets: listed }), { headers: { 'content-type': 'application/json' } });
    }
    const target = decodeURIComponent(u.slice(RELAY.length + 1));
    const body = JSON.parse(String(init.body));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ target, method: body.method, params: body.params, headers });
    const answer = scripts[target]?.shift();
    if (!answer) return new Response(JSON.stringify({ error: 'no such target' }), { status: 404 });
    if ('status' in answer) {
      return new Response(JSON.stringify({ error: 'refused' }), {
        status: answer.status,
        headers: answer.retryAfter ? { 'retry-after': String(answer.retryAfter) } : {},
      });
    }
    if ('result' in answer) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer.result }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const sse = answer.events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join('');
    return new Response(sse, { headers: { 'content-type': 'text/event-stream', ...answer.headers } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const ext = (data: Record<string, unknown>) => ({
  data,
  mediaType: 'application/json',
  metadata: { extension: HANDOFF_EXTENSION },
});
const agentSays = (id: string, text: string, extra: object[] = []) => ({
  messageId: id,
  role: 'ROLE_AGENT' as const,
  parts: [{ text }, ...extra],
});
const status = (state: string, message?: object): A2AStreamResponse => ({
  statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: state as never, ...(message ? { message: message as never } : {}) } },
});

const envelope = (target = 'booking') =>
  buildEnvelope({
    target,
    reason: 'Wants a boiler inspection',
    summary: 'Visitor in Royal Oak wants a boiler inspection next week.',
    conversationId: 'conv-1',
    page: { url: 'https://copperline.example/book', title: 'Book a visit' },
    locale: 'en-US',
    origin: 'https://copperline.example',
    now: () => new Date('2026-09-23T12:00:00Z'),
  });

/** Everything a controller reported, and a way to wait for a moment in it. */
function watch(controller: HandoffController) {
  const events: HandoffEvent[] = [];
  controller.addEventListener('handoff', (e) => events.push((e as CustomEvent<HandoffEvent>).detail));
  const until = async (pred: (events: HandoffEvent[]) => boolean) => {
    for (let i = 0; i < 200 && !pred(events); i++) await new Promise((r) => setTimeout(r, 5));
    expect(pred(events)).toBe(true);
  };
  return { events, until };
}

const states = (events: HandoffEvent[]) => events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);

describe('a handoff to a person', () => {
  it('queues, connects to an operator, takes a question back, and hands back with a reference', async () => {
    const { fetchImpl, calls } = fakeRelay({
      team: [
        {
          headers: { [HANDOFF_KEY_HEADER]: KEY },
          events: [
            { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_SUBMITTED' } } },
            status('TASK_STATE_SUBMITTED', { messageId: 'q1', role: 'ROLE_AGENT', parts: [ext({ handoff: 'queue', position: 2, waitMinutes: 4 })] }),
            status('TASK_STATE_WORKING', agentSays('m1', "Hi, I'm Sam.", [ext({ handoff: 'operator', name: 'Sam', kind: 'person' })])),
            status('TASK_STATE_INPUT_REQUIRED', agentSays('m2', 'Which day suits you?')),
          ],
        },
        {
          events: [
            status('TASK_STATE_WORKING'),
            status(
              'TASK_STATE_COMPLETED',
              agentSays('m3', 'Booked for Tuesday.', [
                ext({ handoff: 'handback', outcome: 'resolved', note: 'Booked Tuesday 9am.', references: [{ label: 'Booking', value: 'CPL-4821' }] }),
              ]),
            ),
          ],
        },
      ],
    });
    const controller = new HandoffController({
      relay: RELAY,
      targets: { team: { kind: 'person', label: 'Our team' } },
      fetchImpl,
      storage: memoryStorage(),
    });
    const { events, until } = watch(controller);

    await controller.start('conv-1', 'team', envelope('team'));
    await until((ev) => states(ev).includes('awaiting-visitor'));

    const queued = events.find((e) => e.type === 'state' && e.state === 'queued') as Extract<HandoffEvent, { type: 'state' }>;
    expect(queued.session.label).toBe('Our team');
    expect(events.filter((e) => e.type === 'message').map((e) => [(e as { from: string }).from, (e as { text: string }).text])).toEqual([
      ['Sam', "Hi, I'm Sam."],
      ['Sam', 'Which day suits you?'],
    ]);
    expect(controller.active('conv-1')?.state).toBe('awaiting-visitor');

    await controller.send('conv-1', 'Tuesday morning');
    await until((ev) => states(ev).includes('handed-back'));

    // The follow-up carried the task, the context and the key the relay issued.
    const followUp = calls[1];
    expect(followUp.method).toBe('SendStreamingMessage');
    expect(followUp.headers[HANDOFF_KEY_HEADER.toLowerCase()]).toBe(KEY);
    expect((followUp.params.message as { taskId: string; contextId: string }).taskId).toBe('t1');
    expect((followUp.params.message as { contextId: string }).contextId).toBe('c1');

    const back = events.find((e) => e.type === 'handback') as Extract<HandoffEvent, { type: 'handback' }>;
    expect(back.handBack).toEqual({ outcome: 'resolved', note: 'Booked Tuesday 9am.', references: [{ label: 'Booking', value: 'CPL-4821' }] });
    expect(controller.active('conv-1')).toBeNull();
    expect(controller.session('conv-1')?.state).toBe('handed-back');
    expect(states(events)).toEqual(['connecting', 'queued', 'queued', 'active', 'awaiting-visitor', 'active', 'handed-back']);
    // Joining is announced before the operator speaks; the hand-back follows the last words.
    const order = events.map((e) => (e.type === 'state' ? e.state : e.type === 'message' ? `said: ${e.text}` : e.type));
    expect(order.indexOf('active')).toBeLessThan(order.indexOf("said: Hi, I'm Sam."));
    expect(order.slice(-3)).toEqual(['said: Booked for Tuesday.', 'handback', 'handed-back']);
  });

  it('sends the envelope as the first message, with the summary readable by any agent', async () => {
    const { fetchImpl, calls } = fakeRelay({ booking: [{ events: [status('TASK_STATE_WORKING')] }] });
    const controller = new HandoffController({ relay: RELAY, targets: { booking: { kind: 'agent', label: 'Booking' } }, fetchImpl, storage: null });
    await controller.start('conv-1', 'booking', envelope());
    const first = calls[0];
    expect(first.headers['a2a-version']).toBe('1.0');
    expect(first.headers['a2a-extensions']).toBe(HANDOFF_EXTENSION);
    const message = first.params.message as { role: string; parts: { text?: string; data?: Record<string, unknown> }[] };
    expect(message.role).toBe('ROLE_USER');
    expect(message.parts[0].text).toContain('boiler inspection next week');
    expect(message.parts[1].data).toMatchObject({
      handoff: 'envelope',
      reason: 'Wants a boiler inspection',
      page: { url: 'https://copperline.example/book', title: 'Book a visit' },
      ui: { cards: 2, feedback: 1 },
      consent: { target: 'booking', shared: ['reason', 'summary', 'page'], at: '2026-09-23T12:00:00.000Z' },
    });
    controller.dispose();
  });
});

describe('a handoff to an agent', () => {
  it('picks a stream the host cut off back up, and finishes', async () => {
    const { fetchImpl, calls } = fakeRelay({
      booking: [
        { events: [{ task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } }, status('TASK_STATE_WORKING', agentSays('m1', 'Checking the calendar…'))] },
        { events: [status('TASK_STATE_COMPLETED', agentSays('m2', 'Done.'))] },
      ],
    });
    const controller = new HandoffController({
      relay: RELAY,
      targets: { booking: { kind: 'agent', label: 'Booking' } },
      fetchImpl,
      storage: null,
      resumeDelayMs: 1,
    });
    const { events, until } = watch(controller);
    await controller.start('conv-1', 'booking', envelope());
    await until((ev) => states(ev).includes('ended'));
    expect(calls.map((c) => c.method)).toEqual(['SendStreamingMessage', 'SubscribeToTask']);
    expect(calls[1].params).toEqual({ id: 't1' });
    expect(events.filter((e) => e.type === 'message').map((e) => (e as { text: string }).text)).toEqual(['Checking the calendar…', 'Done.']);
  });

  it('backs off from a task that stays working with nothing new, instead of asking every second', async () => {
    const stuck = { events: [{ task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' as const } } }] };
    const { fetchImpl, calls } = fakeRelay({ booking: [stuck, stuck, stuck, stuck, stuck, stuck] });
    const controller = new HandoffController({
      relay: RELAY,
      targets: { booking: { kind: 'agent', label: 'Booking' } },
      fetchImpl,
      storage: null,
      resumeDelayMs: 20,
    });
    await controller.start('conv-1', 'booking', envelope());
    // Waits of 20, 40, 80 ms: three resubscribes in 250 ms, not a dozen.
    await new Promise((r) => setTimeout(r, 250));
    controller.dispose();
    expect(calls.filter((c) => c.method === 'SubscribeToTask').length).toBeLessThanOrEqual(4);
    expect(calls.filter((c) => c.method === 'SubscribeToTask').length).toBeGreaterThanOrEqual(2);
  });

  it('cancels the task when the visitor goes back to the assistant', async () => {
    const { fetchImpl, calls } = fakeRelay({
      booking: [
        {
          headers: { [HANDOFF_KEY_HEADER]: KEY },
          events: [status('TASK_STATE_INPUT_REQUIRED', agentSays('m1', 'Which day?'))],
        },
        { result: { id: 't1', status: { state: 'TASK_STATE_CANCELED' } } },
      ],
    });
    const controller = new HandoffController({ relay: RELAY, targets: { booking: { kind: 'agent', label: 'Booking' } }, fetchImpl, storage: null });
    const { until } = watch(controller);
    await controller.start('conv-1', 'booking', envelope());
    await until((ev) => states(ev).includes('awaiting-visitor'));
    await controller.end('conv-1');
    expect(calls[1]).toMatchObject({ method: 'CancelTask', params: { id: 't1' } });
    expect(calls[1].headers[HANDOFF_KEY_HEADER.toLowerCase()]).toBe(KEY);
    expect(controller.session('conv-1')?.state).toBe('ended');
    expect(controller.active('conv-1')).toBeNull();
  });

  it('fails plainly when the relay refuses, and leaves the assistant in charge', async () => {
    const { fetchImpl } = fakeRelay({ booking: [{ status: 429, retryAfter: 120 }] });
    const controller = new HandoffController({ relay: RELAY, targets: { booking: { kind: 'agent', label: 'Booking' } }, fetchImpl, storage: null });
    await expect(controller.start('conv-1', 'booking', envelope())).rejects.toThrow();
    expect(controller.session('conv-1')).toMatchObject({ state: 'failed', error: 'Booking is busy right now. Try again in about 2 minute(s).' });
    expect(controller.active('conv-1')).toBeNull();
  });

  it('refuses a target the page does not name', async () => {
    const { fetchImpl, calls } = fakeRelay({});
    const controller = new HandoffController({ relay: RELAY, targets: {}, fetchImpl, storage: null });
    await expect(controller.start('conv-1', 'elsewhere', envelope())).rejects.toThrow(/not a handoff target/);
    expect(calls).toHaveLength(0);
  });
});

describe('a handoff across pages', () => {
  it('resumes on the next page, showing only what was not seen, and reads a finished task once', async () => {
    const storage = memoryStorage();
    const first = fakeRelay({
      team: [
        {
          headers: { [HANDOFF_KEY_HEADER]: KEY },
          events: [
            { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_SUBMITTED' } } },
            status('TASK_STATE_WORKING', agentSays('m1', 'Hello from Sam', [ext({ handoff: 'operator', name: 'Sam' })])),
          ],
        },
      ],
    });
    const before = new HandoffController({ relay: RELAY, targets: { team: { kind: 'person', label: 'Our team' } }, fetchImpl: first.fetchImpl, storage, resumeDelayMs: 60_000 });
    const one = watch(before);
    await before.start('conv-1', 'team', envelope('team'));
    await one.until((ev) => ev.some((e) => e.type === 'message'));
    before.dispose(); // the page goes away

    // The next page: the task finished while the browser was moving, so subscribing is refused.
    const second = fakeRelay({
      team: [
        { status: 400 },
        {
          result: {
            task: {
              id: 't1',
              contextId: 'c1',
              status: { state: 'TASK_STATE_COMPLETED', message: agentSays('m3', 'All sorted.', [ext({ handoff: 'handback', outcome: 'resolved', note: 'Answered.' })]) },
              history: [agentSays('m1', 'Hello from Sam'), agentSays('m2', 'Anything else?')],
            },
          },
        },
      ],
    });
    const after = new HandoffController({ relay: RELAY, targets: { team: { kind: 'person', label: 'Our team' } }, fetchImpl: second.fetchImpl, storage });
    const two = watch(after);
    expect(after.active('conv-1')).toMatchObject({ taskId: 't1', key: KEY, operator: 'Sam' });
    await after.resume('conv-1');

    expect(second.calls.map((c) => c.method)).toEqual(['SubscribeToTask', 'GetTask']);
    expect(second.calls.every((c) => c.headers[HANDOFF_KEY_HEADER.toLowerCase()] === KEY)).toBe(true);
    expect(two.events.filter((e) => e.type === 'message').map((e) => (e as { text: string }).text)).toEqual(['Anything else?', 'All sorted.']);
    expect(after.session('conv-1')?.state).toBe('handed-back');
  });
});

describe('the handoff tools', () => {
  const targets = {
    booking: { kind: 'agent' as const, label: 'Booking', description: 'service visits' },
    team: { kind: 'person' as const, label: 'Our team' },
    ghost: { kind: 'agent' as const, label: 'Not on the relay' },
  };

  it('offer only the targets both the page and the relay name, as consequential writes', async () => {
    const { fetchImpl } = fakeRelay({});
    const controller = new HandoffController({ relay: RELAY, targets, fetchImpl, storage: null });
    const tools = await buildHandoffTools(controller, { conversationId: () => 'conv-1' });
    expect(tools.map((t) => t.name)).toEqual([TRANSFER_TO_AGENT_TOOL, TALK_TO_A_PERSON_TOOL]);
    // The team is in, so an email is not asked for.
    expect(tools[1].inputSchema!.required).not.toContain('email');
    const transfer = tools[0];
    expect((transfer.inputSchema!.properties!.target as { enum: string[] }).enum).toEqual(['booking']);
    expect(transfer.description).toContain('service visits');
    // A write: the harness asks the visitor to press Send before it runs.
    expect(decide(policyFor(transfer as never), 0)).toBe('confirm');
    expect(transfer.annotations).toMatchObject({ readOnlyHint: false, consequentialHint: true });
  });

  it('start the handoff, share the transcript only where the relay allows it, and report the session', async () => {
    const { fetchImpl, calls } = fakeRelay({ team: [{ events: [status('TASK_STATE_SUBMITTED')] }] });
    const controller = new HandoffController({ relay: RELAY, targets, fetchImpl, storage: null });
    const [, person] = await buildHandoffTools(controller, {
      conversationId: () => 'conv-9',
      transcript: () => [{ role: 'visitor', text: 'My boiler is making a noise' }],
    });
    const res = (await person.execute({ target: 'team', reason: 'Boiler noise', summary: 'Boiler noise since Monday.' }, {})) as {
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
    };
    expect(res.content[0].text).toBe('Connecting you to Our team. Our team will reply here.');
    expect(res.structuredContent[HANDOFF_SESSION_RESULT]).toEqual({ target: 'team', label: 'Our team', kind: 'person' });
    const env = (calls[0].params.message as { parts: { data?: Record<string, unknown> }[] }).parts[1].data!;
    expect(env.transcript).toEqual([{ role: 'visitor', text: 'My boiler is making a noise' }]);
    expect(env.returnTo).toMatchObject({ conversationId: 'conv-9' });
    controller.dispose();
  });

  it('ask for an email when the team is away, and send it when given', async () => {
    const { fetchImpl, calls } = fakeRelay(
      { team: [{ events: [status('TASK_STATE_SUBMITTED')] }] },
      [{ name: 'team', kind: 'person', label: 'Our team', available: false, hours: 'Mon–Fri 8–6', transcript: false }],
    );
    const controller = new HandoffController({ relay: RELAY, targets, fetchImpl, storage: null });
    const [person] = await buildHandoffTools(controller, { conversationId: () => 'conv-1' });
    // Required, so the page asks for it in a form before the visitor presses Send.
    expect(person.inputSchema!.required).toContain('email');
    // A call that arrives without one anyway is refused in words the visitor can act on.
    const away = (await person.execute({ target: 'team', reason: 'r', summary: 's' }, {})) as { isError?: boolean; content: { text: string }[] };
    expect(away.isError).toBe(true);
    expect(away.content[0].text).toBe("Our team is away now (open Mon–Fri 8–6). Leave an email address and they'll reply there.");
    expect(calls).toHaveLength(0);

    const later = (await person.execute({ target: 'team', reason: 'r', summary: 's', email: 'sam@example.com' }, {})) as { content: { text: string }[] };
    expect(later.content[0].text).toContain('will reply to sam@example.com');
    const env = (calls[0].params.message as { parts: { data?: Record<string, unknown> }[] }).parts[1].data!;
    expect(env.contact).toEqual({ email: 'sam@example.com' });
    expect(env.consent).toMatchObject({ shared: ['reason', 'summary', 'page', 'contact'] });
    controller.dispose();
  });

  it('register once, beside the page’s own tools', async () => {
    const { fetchImpl } = fakeRelay({});
    const controller = new HandoffController({ relay: RELAY, targets, fetchImpl, storage: null });
    const registered: ModelContextTool[] = [];
    const mc = {
      getTools: async () => registered.map((t) => ({ name: t.name })),
      registerTool: async (t: ModelContextTool) => void registered.push(t),
    } as unknown as ModelContext;
    expect(await registerHandoffTools(mc, controller, { conversationId: () => 'c' })).toEqual([TRANSFER_TO_AGENT_TOOL, TALK_TO_A_PERSON_TOOL]);
    expect(await registerHandoffTools(mc, controller, { conversationId: () => 'c' })).toEqual([]);
  });
});

describe('the coordinator during a handoff', () => {
  it('sends the visitor’s message to the target instead of any agent', async () => {
    const turn = vi.fn();
    const agent = { turn, stop: vi.fn(), owns: () => false } as unknown as AgentHarness;
    const controller = { active: vi.fn(() => ({ state: 'active' })), send: vi.fn(async () => {}) };
    const messages: ChatMessage[] = [];
    const coordinator = new AgentCoordinator({
      agents: { main: agent },
      rules: [],
      fallback: 'main',
      handoff: { controller: controller as never, conversationId: () => 'conv-1' },
    });
    expect(await coordinator.turn('Tuesday works', messages)).toEqual({ decision: 'handoff' });
    expect(controller.send).toHaveBeenCalledWith('conv-1', 'Tuesday works');
    expect(turn).not.toHaveBeenCalled();
  });
});

describe('the wire', () => {
  it('reads 0.3 events and states as 1.0', () => {
    expect(normaliseResponse({ kind: 'status-update', taskId: 't', status: { state: 'input-required' } })).toEqual({
      statusUpdate: { kind: 'status-update', taskId: 't', status: { state: 'TASK_STATE_INPUT_REQUIRED' } },
    });
    expect(normaliseResponse({ id: 't', status: { state: 'completed' } }).task?.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('reads an SSE stream split anywhere, and ignores keep-alives', async () => {
    const payload = `: keep-alive\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: status('TASK_STATE_WORKING') })}\n\n`;
    const body = new ReadableStream({
      start(c) {
        const bytes = new TextEncoder().encode(payload);
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const fetchImpl = (async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const { events } = await new A2AClient({ endpoint: '/x', fetchImpl }).stream('SubscribeToTask', { id: 't1' });
    const got: A2AStreamResponse[] = [];
    for await (const e of events) got.push(e);
    expect(got).toHaveLength(1);
    expect(got[0].statusUpdate?.status.state).toBe('TASK_STATE_WORKING');
  });

  it('drops the parameters that never identify a page', () => {
    expect(cleanPageUrl('https://a.example/p?surface=window&id=4&utm_source=x#top')).toBe('https://a.example/p?id=4');
  });

  it('reads a hand-back, keeping only references with a value', () => {
    expect(readHandBack([ext({ handoff: 'handback', outcome: 'odd', note: ' n ', references: [{ label: 'Ref', value: 'A1' }, { label: 'Empty', value: '' }] })])).toEqual({
      outcome: 'resolved',
      note: 'n',
      references: [{ label: 'Ref', value: 'A1' }],
    });
  });
});

describe('MCP discovery beside an A2A agent', () => {
  const mcp = { url: 'https://x.mcp.nxis.ai/mcp/server-card', type: 'application/mcp-server-card+json' };
  const card = { url: 'https://copperline.example/.well-known/agent-card.json', type: 'application/a2a-agent-card+json' };
  it('takes the MCP server card, wherever it is listed', () => {
    expect(mcpCatalogEntry({ entries: [card, mcp] })).toBe(mcp);
  });
  it('never takes an agent card for a server card', () => {
    expect(mcpCatalogEntry({ entries: [card] })).toBeUndefined();
  });
  it('still reads an older catalog with no types', () => {
    const old = { url: 'https://x/mcp/server-card' };
    expect(mcpCatalogEntry({ entries: [old] })).toBe(old);
  });
});
