// @vitest-environment jsdom
/**
 * The step surfaces in the element, end to end against a scripted Booking agent behind a relay: a reply with a
 * `surface` part draws its card under the bubble, a choice goes back on the task as an `action` part (not drawn as
 * the visitor's message, not given to the page's model), an update with no words updates the card, a ConfirmCard's
 * confirm commits, the conversation keeps every surface across a redraw, and the receipt's Back to assistant ends
 * the handoff.
 */
import './helpers/lit-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deep, deepAll, sleep, until } from './helpers/lit-dom';
import '../src/ui/agent';
import { HANDOFF_EXTENSION, buildEnvelope, type A2AStreamResponse } from '../src/handoff/index';
import { ESTIMATE, RECEIPT, SLOTS, confirmSurface } from './fixtures/surfaces';

const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });
const reply = (messageId: string, parts: unknown[], state = 'TASK_STATE_INPUT_REQUIRED'): A2AStreamResponse[] => [
  { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } },
  { statusUpdate: { taskId: 't1', contextId: 'c1', status: { state, message: { messageId, role: 'ROLE_AGENT', parts } } } } as any,
];

function relay(turns: A2AStreamResponse[][]) {
  const posts: { method: string; params: any; key: string | null }[] = [];
  const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return new Response(JSON.stringify({ targets: [{ name: 'booking', kind: 'agent', label: 'Book a visit', available: true }] }));
    const body = JSON.parse(String(init.body));
    posts.push({ method: body.method, params: body.params, key: new Headers(init.headers).get('Nxis-Handoff-Key') });
    if (body.method === 'CancelTask') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_CANCELED' } } }));
    const events = turns.shift() ?? [];
    return new Response(events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream', 'Nxis-Handoff-Key': 'k-1' },
    });
  }) as unknown as typeof fetch;
  const actions = () => posts.filter((p) => p.method === 'SendStreamingMessage' && p.params.message.parts.some((x: any) => x.data?.handoff === 'action'));
  return { fetchImpl, posts, actions };
}

describe('step surfaces in the element', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  async function handedOff(turns: A2AStreamResponse[][]) {
    const r = relay(turns);
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    document.body.append(el);
    el.handoff = { relay: '/api/handoff', targets: { booking: { kind: 'agent', label: 'Book a visit' } }, fetchImpl: r.fetchImpl };
    await el._handoff.start(el._activeId, 'booking', buildEnvelope({ target: 'booking', reason: 'r', summary: 's', conversationId: el._activeId, page: { url: 'https://fixture.example/', title: 'x' } }));
    const root = el.shadowRoot as ShadowRoot;
    await until(() => deepAll(root, 'nxis-step-windowgrid button.opt').length);
    return { el, root, r };
  }

  it('draws the surface under the reply, sends a choice as an action, and updates the card from a reply with no words', async () => {
    const hold = new Date(Date.now() + 600_000).toISOString();
    const { el, root, r } = await handedOff([
      reply('m1', [{ text: 'Pick a day and a window.' }, ext({ handoff: 'surface', messages: [SLOTS] })]),
      reply('m2', [ext({ handoff: 'surface', messages: [{ version: 'v1.0', updateDataModel: { surfaceId: 'booking-slots', path: '/booking/hold', value: hold } }] })]),
    ]);
    const remote = root.querySelector('.remote.has-surface')!;
    expect(remote.querySelector('.msg')?.textContent).toContain('Pick a day and a window.');
    expect(remote.querySelector('.surface.a2ui-scope')?.getAttribute('data-surface')).toBe('booking-slots');
    const conv = el._active();
    const model = JSON.stringify(conv.messages);

    deepAll<HTMLButtonElement>(root, 'nxis-step-windowgrid button.opt')[1].click();
    await until(() => r.actions().length);
    const sent = r.actions()[0];
    expect(sent.key).toBe('k-1');
    expect(sent.params.message.taskId).toBe('t1');
    expect(sent.params.message.parts).toEqual([
      { text: '10 am – 12 pm' },
      ext({ handoff: 'action', surfaceId: 'booking-slots', name: 'pick_window', component: 'windows', context: { date: '2026-11-25', window: 'win-10', label: '10 am – 12 pm' } }),
    ]);
    // Not the visitor's bubble, not the model's.
    expect(root.querySelectorAll('.msg.user')).toHaveLength(0);
    expect(JSON.stringify(conv.messages)).toBe(model);

    // The reply with no words updates the card where it is, and draws nothing of its own.
    await until(() => deep(root, 'nxis-step-holdcountdown .hold'));
    expect(deep(root, 'nxis-step-holdcountdown .hold')?.textContent).toMatch(/Held for you · (10:00|9:5\d) left/);
    expect(root.querySelectorAll('.remote')).toHaveLength(1);
    expect(root.querySelector('.surface')!.hasAttribute('inert')).toBe(false);
    expect(conv.items.find((it: any) => it.surface).surface[0].create.createSurface.dataModel.booking.hold).toBe(hold);
  });

  it('commits through the ConfirmCard, draws the receipt, keeps both across a redraw, and Back to assistant ends the handoff', async () => {
    const { el, root, r } = await handedOff([
      reply('m1', [{ text: 'Pick a day and a window.' }, ext({ handoff: 'surface', messages: [SLOTS] })]),
      reply('m2', [{ text: 'Here is your visit.' }, ext({ handoff: 'surface', messages: [{ version: 'v1.0', deleteSurface: { surfaceId: 'booking-slots' } }, confirmSurface(new Date(Date.now() + 581_000).toISOString())] })]),
      reply('m3', [{ text: 'Booked.' }, ext({ handoff: 'surface', messages: [RECEIPT] })]),
    ]);
    deepAll<HTMLButtonElement>(root, 'nxis-step-windowgrid button.opt')[1].click();
    await until(() => deepAll(root, 'nxis-step-confirmcard .acts button').length);
    expect(deepAll(root, 'nxis-step-windowgrid')).toHaveLength(0);

    deepAll<HTMLButtonElement>(root, 'nxis-step-confirmcard .acts button')[1].click();
    await until(() => r.actions().length > 1);
    const commit = r.actions()[1].params.message.parts[1].data;
    expect(commit).toMatchObject({ name: 'confirm_booking', commit: true, consent: { rows: [{ label: 'Address' }, { label: 'Contact' }] } });

    await until(() => deep(root, 'nxis-step-receiptcard .ref'));
    expect(deep(root, 'nxis-step-receiptcard .ref')!.textContent).toBe('CPL-4821');
    // The booking is done: the bar no longer says the agent is waiting on the visitor.
    await until(() => root.querySelector('.handoff-bar .hb-label')!.textContent!.endsWith('· done'));
    expect(root.querySelector('.handoff-bar .hb-label')!.textContent).toBe('Book a visit · handed off from the assistant · done');
    // The confirmed card stays done; the receipt is live.
    const wraps = [...root.querySelectorAll<HTMLElement>('.surface')];
    expect(wraps.map((w) => [w.dataset.surface, w.hasAttribute('inert')])).toEqual([
      ['booking-confirm', true],
      ['booking-receipt', false],
    ]);

    // A redraw (a reload, another conversation and back) draws them as kept.
    el._renderThread();
    await until(() => deep(root, 'nxis-step-receiptcard .ref'));
    expect([...root.querySelectorAll<HTMLElement>('.surface')].map((w) => w.dataset.surface)).toEqual(['booking-confirm', 'booking-receipt']);

    // Back to assistant, from the receipt: the page's own, never sent; it ends the handoff.
    const back = deepAll<HTMLButtonElement>(root, 'nxis-step-receiptcard .acts button').find((b) => b.textContent?.includes('Back to assistant'))!;
    back.click();
    await until(() => r.posts.some((p) => p.method === 'CancelTask'));
    await sleep(10);
    expect(r.actions()).toHaveLength(2);
    expect(el._handoff.active(el._activeId)).toBeNull();
    expect(root.querySelector<HTMLElement>('.surface[data-surface="booking-receipt"]')!.hasAttribute('inert')).toBe(true);
  });

  it('names the agent in an accent-tinted bar at the top while handed off, with Back to assistant', async () => {
    const { el, root } = await handedOff([reply('m1', [{ text: 'Pick a day and a window.' }, ext({ handoff: 'surface', messages: [SLOTS] })])]);
    const bar = root.querySelector<HTMLElement>('.handoff-bar')!;
    expect(bar.hidden).toBe(false);
    expect(bar.getAttribute('role')).toBe('status');
    // Under the header, above the thread.
    expect(bar.compareDocumentPosition(root.querySelector('.thread')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.compareDocumentPosition(root.querySelector('.main-head')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(bar.querySelector('.hb-label')!.textContent).toBe('Book a visit · handed off from the assistant · waiting for your reply');
    expect(bar.querySelector('.hb-label b')!.textContent).toBe('Book a visit');
    expect(bar.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(bar.querySelector('.hb-back')!.textContent).toBe('Back to assistant');
    const css = [...root.querySelectorAll('style')].map((s) => s.textContent).join('');
    expect(css).toMatch(/\.handoff-bar \{[^}]*background: var\(--blue-tint\)/);
    expect(css).not.toMatch(/\.handoff-bar \.hb-label \{[^}]*white-space: nowrap/);
    el._handoff.end(el._activeId);
  });

  it('puts an estimate\'s Sources under its card, not in the bubble', async () => {
    const card = { '@id': 'https://fixture.example/pricing#offer', '@type': 'Offer', name: 'Water heater replacement', url: 'https://fixture.example/pricing' };
    const r = relay([reply('m1', [{ text: 'The published price is $1,800 – $2,600.' }, ext({ handoff: 'surface', messages: [ESTIMATE] }), ext({ handoff: 'answer', answerId: 'a-1', cards: [card], cites: [{ claim: 0, id: card['@id'] }], claims: ['The published price is $1,800 – $2,600'] })])]);
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    document.body.append(el);
    el.handoff = { relay: '/api/handoff', targets: { quote: { kind: 'agent', label: 'Get a quote' } }, fetchImpl: r.fetchImpl };
    await el._handoff.start(el._activeId, 'quote', buildEnvelope({ target: 'quote', reason: 'r', summary: 's', conversationId: el._activeId, page: { url: 'https://fixture.example/', title: 'x' } }));
    const root = el.shadowRoot as ShadowRoot;
    await until(() => root.querySelector('.ra-src'));
    const remote = root.querySelector('.remote')!;
    const src = remote.querySelector<HTMLElement>('.ra-src')!;
    expect(src.classList.contains('ra-src-below')).toBe(true);
    expect(src.closest('.msg')).toBeNull();
    expect(src.previousElementSibling?.classList.contains('surface')).toBe(true);
    // The bubble keeps its marker, which still finds the row.
    expect(remote.querySelector('.msg .ra-mark')?.textContent).toBe('1');
    el._handoff.end(el._activeId);
  });
});

