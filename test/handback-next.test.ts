// @vitest-environment jsdom
/**
 * A hand-back that asks for another agent. In a real test run, "Book a visit too" on the Quote agent's receipt handed
 * back to the page's assistant and then nothing happened until the visitor typed. A hand-back's `next` now draws the
 * Hand over card for that agent at once, without asking the model. Also: a question about what was already done is
 * answered, not handed over (the handoff tool's description says so), and the panel reopens at the end of the thread.
 */
import './helpers/lit-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepAll, sleep, until } from './helpers/lit-dom';
import '../src/ui/agent';
import { HANDOFF_EXTENSION, readHandBack, type A2AStreamResponse } from '../src/handoff/index';
import { handoffToolInfo } from '../src/handoff/tools';
import type { ModelContextTool } from '../src/types';

const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });
const NEXT = { target: 'booking', reason: 'Wants to book a visit too', summary: 'Quote CL-1 sent for a water heater. The visitor would like to book a visit.' };

describe("a hand-back's next, read strictly", () => {
  const read = (next: unknown) => readHandBack([ext({ handoff: 'handback', outcome: 'transferred', note: 'n', next }) as any])?.next;

  it('keeps three short strings, trimmed', () => {
    expect(read({ target: ' booking ', reason: 'r\u0007x', summary: 's', extra: 1 })).toEqual({ target: 'booking', reason: 'r x', summary: 's' });
  });

  it('drops one with a missing, empty, non-string or too long field', () => {
    for (const bad of [null, 'booking', { target: 'booking', reason: 'r' }, { target: '', reason: 'r', summary: 's' }, { target: 'booking', reason: 3, summary: 's' }, { target: 'x'.repeat(65), reason: 'r', summary: 's' }, { target: 'b', reason: 'r'.repeat(201), summary: 's' }, { target: 'b', reason: 'r', summary: 's'.repeat(1001) }])
      expect(read(bad)).toBeUndefined();
  });
});

describe("the agent handoff tool's description", () => {
  it('says a question about what was already done is answered from the hand-back', () => {
    const info = handoffToolInfo('agent', [{ name: 'booking', kind: 'agent', label: 'Booking', available: true } as any]);
    expect(info.description).toContain("Not for a question about what was already done (a reference, what was sent, what's next): answer that from the hand-back.");
  });
});

let task = 0;
function turn(parts: unknown[], state = 'TASK_STATE_INPUT_REQUIRED'): A2AStreamResponse[] {
  const id = `t${++task}`;
  return [
    { task: { id, contextId: `c${task}`, status: { state: 'TASK_STATE_WORKING' } } },
    { statusUpdate: { taskId: id, contextId: `c${task}`, status: { state, message: { messageId: `m${task}`, role: 'ROLE_AGENT', parts } } } } as any,
  ];
}

function relay(script: Record<string, A2AStreamResponse[][]>, available = true) {
  const posts: { target: string; method: string; params: any }[] = [];
  const fetchImpl = vi.fn(async (u: unknown, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      if (String(u) !== '/api/handoff') return new Response('', { status: 404 });
      return new Response(
        JSON.stringify({
          targets: [
            { name: 'quote', kind: 'agent', label: 'Get a quote', available: true },
            { name: 'booking', kind: 'agent', label: 'Book a visit', available },
          ],
        }),
      );
    }
    const target = String(u).split('/').pop()!;
    const body = JSON.parse(String(init.body));
    posts.push({ target, method: body.method, params: body.params });
    const events = (script[target] ?? []).shift() ?? [];
    return new Response(events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream', 'Nxis-Handoff-Key': `k-${target}` },
    });
  }) as unknown as typeof fetch;
  const envelopes = () =>
    posts
      .filter((p) => p.method === 'SendStreamingMessage' && !p.params.message.taskId)
      .map((p) => ({ target: p.target, ...p.params.message.parts.find((x: any) => x.data?.handoff === 'envelope')?.data }));
  return { fetchImpl, envelopes };
}

async function element(r: ReturnType<typeof relay>) {
  const el = document.createElement('nxis-agent') as any;
  el.setAttribute('preload', 'none');
  el.setAttribute('discover', 'false');
  const complete = vi.fn(async () => ({ text: 'From the model.' }));
  el.modelProvider = { name: 'Stub', local: false, ready: true, loading: false, load: async () => {}, complete };
  document.body.append(el);
  const registered: ModelContextTool[] = [];
  const mc = { getTools: async () => registered, registerTool: async (t: ModelContextTool) => void registered.push(t), addEventListener() {}, removeEventListener() {}, executeTool: (t: any, args: any) => registered.find((x) => x.name === (t?.name ?? t))!.execute(args, undefined as never) };
  el.toolSource.modelContext = () => mc;
  el.handoff = {
    relay: '/api/handoff',
    targets: { quote: { kind: 'agent', label: 'Get a quote' }, booking: { kind: 'agent', label: 'Book a visit' } },
    fetchImpl: r.fetchImpl,
  };
  await el._registerHandoff();
  const handTo = (target: string) => registered.find((t) => t.name === 'transfer_to_agent')!.execute({ target, reason: 'r', summary: 's' } as never, undefined as never);
  return { el, root: el.shadowRoot as ShadowRoot, handTo, complete };
}

const buttons = (root: ShadowRoot, label: string) => deepAll<HTMLButtonElement>(root, 'button').filter((b) => b.textContent?.trim() === label);
const handBack = (next: unknown) => [turn([{ text: "I'll pass you back to book a visit." }, ext({ handoff: 'handback', outcome: 'transferred', note: 'Quote sent. The visitor would like to book a visit too.', next })], 'TASK_STATE_COMPLETED')];

describe('a hand-back with next, in the element', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // jsdom has no CSS.escape; the card's ids are plain.
    (globalThis as any).CSS ??= { escape: (s: string) => s };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('draws the Hand over card for that agent at once, without the model or a visitor message, and hands over on the press', async () => {
    const r = relay({ quote: handBack(NEXT), booking: [turn([{ text: 'Pick a day.' }])] });
    const { el, root, handTo, complete } = await element(r);
    await handTo('quote');
    await until(() => buttons(root, 'Hand over').length, 3000);
    expect(complete).not.toHaveBeenCalled();
    expect(root.querySelectorAll('.msg.user')).toHaveLength(0);
    const card = buttons(root, 'Hand over')[0].closest('[data-action]')!;
    expect(card.textContent).toContain('Book a visit');
    expect(card.textContent).toContain(NEXT.summary);

    buttons(root, 'Hand over')[0].click();
    await until(() => r.envelopes().length > 1, 400);
    expect(r.envelopes()[1]).toMatchObject({ target: 'booking', reason: NEXT.reason, summary: NEXT.summary });
    expect(complete).not.toHaveBeenCalled();
    await until(() => el._handoff.active(el._activeId)?.target === 'booking');

    // A reload offers nothing again.
    document.body.innerHTML = '';
    const again = document.createElement('nxis-agent') as any;
    again.setAttribute('preload', 'none');
    document.body.append(again);
    again.handoff = { relay: '/api/handoff', targets: { quote: { kind: 'agent', label: 'Get a quote' }, booking: { kind: 'agent', label: 'Book a visit' } }, fetchImpl: r.fetchImpl };
    await sleep(100);
    expect(again._active().items.filter((it: any) => it.kind === 'action')).toHaveLength(1);
    expect(again._live).toBeFalsy();
  }, 15000);

  it('offers nothing for an agent that is away, the one handing back, or one not listed', async () => {
    for (const [next, available] of [
      [NEXT, false],
      [{ ...NEXT, target: 'quote' }, true],
      [{ ...NEXT, target: 'billing' }, true],
    ] as const) {
      const r = relay({ quote: handBack(next) }, available);
      const { el, root, handTo, complete } = await element(r);
      await handTo('quote');
      await until(() => !el._handoff.active(el._activeId));
      await sleep(100);
      expect(buttons(root, 'Hand over')).toHaveLength(0);
      expect(el._turnActive).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      // The model reads the note, as before.
      expect(el._active().messages.some((m: any) => m.content === '[Get a quote handed the conversation back]')).toBe(true);
      document.body.innerHTML = '';
      localStorage.clear();
    }
  });
});

describe('reopening the panel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('opens at the end of the thread, or where the visitor left it', () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    const t = el._els.thread as HTMLElement;
    let top = 0;
    Object.defineProperty(t, 'scrollHeight', { configurable: true, get: () => 900 });
    Object.defineProperty(t, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(t, 'scrollTop', { configurable: true, get: () => top, set: (v) => (top = Math.min(v, 600)) });
    el.open();
    expect(top).toBe(600);
    top = 120;
    el.close();
    top = 0;
    el.open();
    expect(top).toBe(120);
  });
});
