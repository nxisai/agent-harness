// @vitest-environment happy-dom
/**
 * 👍 and 👎 on a remote agent's answers: a scripted Support Agent answers with an `answerId`, the element draws the
 * controls under the answer, and a click sends a `feedback` part with `SendMessage` on the same task. It is sent
 * once, never drawn as the visitor's, never given to the page's model, and the controls are disabled once the task is
 * over. The bench's `feedback` case field clicks the same controls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';
import {
  HANDOFF_EXTENSION,
  HANDOFF_UI,
  HandoffController,
  buildEnvelope,
  feedbackMessage,
  type A2AStreamResponse,
  type HandoffEvent,
} from '../src/handoff/index';
import { feedbackState } from '../src/ui/feedback';
// @ts-expect-error The bench is plain JavaScript, with no declarations.
import { AGENT_HOST, clickFeedback, FEEDBACK_SELECTOR } from '../bench/runner/remote.mjs';

const ext = (data: Record<string, unknown>) => ({ data, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } });
const HOWTO = { '@id': 'https://fixture.example/help/x200-filter', '@type': 'HowTo', name: 'Replacing the X200 filter', url: 'https://fixture.example/help/x200-filter' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => unknown) => {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(5);
};

const answerTurn = (messageId: string, answerId: string, state = 'TASK_STATE_INPUT_REQUIRED'): A2AStreamResponse[] => [
  { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } },
  {
    statusUpdate: {
      taskId: 't1',
      contextId: 'c1',
      status: {
        state: state as 'TASK_STATE_INPUT_REQUIRED',
        message: { messageId, role: 'ROLE_AGENT', parts: [{ text: 'Lift the cover, then slide the filter out.' }, ext({ handoff: 'answer', answerId, cards: [HOWTO], cites: [{ claim: 0, id: HOWTO['@id'] }] })] },
      },
    },
  },
];

/**
 * A relay in front of a scripted Support Agent. Streamed turns answer from `turns`; `SendMessage` (feedback)
 * answers as the agent does: to 👎 with one line, to 👍 with nothing new, echoing the feedback in the history.
 */
function relay(turns: A2AStreamResponse[][]) {
  const posts: { method: string; params: any; key: string | null }[] = [];
  const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return new Response(JSON.stringify({ targets: [{ name: 'support', kind: 'agent', label: 'Help', available: true, transcript: false }] }));
    const body = JSON.parse(String(init.body));
    posts.push({ method: body.method, params: body.params, key: new Headers(init.headers).get('Nxis-Handoff-Key') });
    if (body.method === 'SendMessage') {
      const fb = body.params.message.parts[0].data;
      const reply = fb.value === 'down' ? { messageId: `r-${fb.answerId}`, role: 'ROLE_AGENT', parts: [{ text: 'Thanks. Would you like me to pass this to the team?' }] } : undefined;
      const task = { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_INPUT_REQUIRED', ...(reply ? { message: reply } : {}) }, history: [body.params.message] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task } }));
    }
    const events = turns.shift() ?? [];
    return new Response(events.map((e) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: e })}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream', 'Nxis-Handoff-Key': 'k-1' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, posts, feedback: () => posts.filter((p) => p.method === 'SendMessage') };
}

const envelope = (conversationId: string) => buildEnvelope({ target: 'support', reason: 'r', summary: 's', conversationId, page: { url: 'https://fixture.example/', title: 'x' } });

describe('the capability and the part', () => {
  it('declares feedback beside cards, not as something shared', () => {
    expect(HANDOFF_UI).toEqual({ cards: 2, feedback: 1 });
    const env = envelope('c');
    expect(env.ui).toEqual({ cards: 2, feedback: 1 });
    expect(env.consent.shared).not.toContain('ui');
  });

  it('is a feedback part alone, on the task, with no text', () => {
    const m = feedbackMessage('a-1', 'down', { taskId: 't1', contextId: 'c1' });
    expect(m).toMatchObject({ role: 'ROLE_USER', taskId: 't1', contextId: 'c1' });
    expect(m.parts).toEqual([ext({ handoff: 'feedback', answerId: 'a-1', value: 'down' })]);
  });
});

describe('HandoffController.feedback', () => {
  it('sends SendMessage on the same task with the relay key, once per answer, and reports the reply to 👎', async () => {
    const r = relay([answerTurn('m1', 'a-1')]);
    const controller = new HandoffController({ relay: '/api/handoff', targets: { support: { kind: 'agent', label: 'Help' } }, fetchImpl: r.fetchImpl, storage: null });
    const got: HandoffEvent[] = [];
    controller.addEventListener('handoff', (e) => got.push((e as CustomEvent<HandoffEvent>).detail));
    await controller.start('conv-1', 'support', envelope('conv-1'));
    await until(() => controller.session('conv-1')?.state === 'awaiting-visitor');

    expect(await controller.feedback('conv-1', 'a-1', 'down')).toBe(true);
    expect(r.feedback()).toHaveLength(1);
    const [sent] = r.feedback();
    expect(sent.key).toBe('k-1');
    expect(sent.params.message).toMatchObject({ role: 'ROLE_USER', taskId: 't1', contextId: 'c1', parts: [{ data: { handoff: 'feedback', answerId: 'a-1', value: 'down' } }] });
    // The agent's one line comes through like any reply; the feedback echoed in the history does not.
    const messages = got.filter((e): e is Extract<HandoffEvent, { type: 'message' }> => e.type === 'message').map((e) => e.text);
    expect(messages).toEqual(['Lift the cover, then slide the filter out.', 'Thanks. Would you like me to pass this to the team?']);

    // At most once per answer, whichever way.
    expect(await controller.feedback('conv-1', 'a-1', 'up')).toBe(false);
    expect(await controller.feedback('conv-1', 'a-1', 'down')).toBe(false);
    expect(r.feedback()).toHaveLength(1);
    expect(controller.session('conv-1')?.feedback).toEqual({ 'a-1': 'down' });
    controller.dispose();
  });

  it('sends nothing once the task is over, or with no handoff', async () => {
    const r = relay([answerTurn('m1', 'a-1', 'TASK_STATE_COMPLETED')]);
    const controller = new HandoffController({ relay: '/api/handoff', targets: { support: { kind: 'agent', label: 'Help' } }, fetchImpl: r.fetchImpl, storage: null });
    await controller.start('conv-1', 'support', envelope('conv-1'));
    await until(() => controller.session('conv-1')?.state === 'ended');
    expect(await controller.feedback('conv-1', 'a-1', 'up')).toBe(false);
    expect(await controller.feedback('conv-2', 'a-1', 'up')).toBe(false);
    expect(r.feedback()).toHaveLength(0);
    controller.dispose();
  });
});

describe('the controls in the thread', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  /** The element, handed off to the scripted Support Agent, with its first answer drawn. */
  async function handedOff(turns: A2AStreamResponse[][]) {
    const r = relay(turns);
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    document.body.append(el);
    el.handoff = { relay: '/api/handoff', targets: { support: { kind: 'agent', label: 'Help' } }, fetchImpl: r.fetchImpl };
    await el._handoff.start(el._activeId, 'support', envelope(el._activeId));
    const root = el.shadowRoot as ShadowRoot;
    await until(() => root.querySelector('.remote[data-answer-id] [data-feedback]'));
    return { el, root, r };
  }
  const buttons = (root: ShadowRoot, answerId = 'a-1') => [...root.querySelectorAll<HTMLButtonElement>(`.remote[data-answer-id="${answerId}"] [data-feedback]`)];

  it('draws 👍 and 👎 on the answer as labelled icon toggle buttons in a named group, the bench\'s hook', async () => {
    const { root } = await handedOff([answerTurn('m1', 'a-1')]);
    const group = root.querySelector('.remote[data-answer-id="a-1"] .fb')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Was this answer helpful?');
    expect(buttons(root).map((b) => [b.dataset.feedback, b.getAttribute('aria-label'), b.getAttribute('aria-pressed'), b.disabled, b.type])).toEqual([
      ['up', 'Helpful', 'false', false, 'button'],
      ['down', 'Not helpful', 'false', false, 'button'],
    ]);
    expect(root.querySelector(FEEDBACK_SELECTOR('up'))).toBe(buttons(root)[0]);
    expect(root.querySelector('style[data-fb]')).not.toBeNull();
    // Each draws an icon, not an emoji: an outline one at rest and a solid one for pressed, hidden from assistive
    // technology (the button's label names it), drawn in the button's own colour.
    for (const b of buttons(root)) {
      expect(b.textContent).toBe('');
      expect([...b.querySelectorAll('svg')].map((s) => [s.getAttribute('class'), s.getAttribute('aria-hidden')])).toEqual([
        ['fb-o', 'true'],
        ['fb-s', 'true'],
      ]);
      expect(b.querySelector('.fb-o')!.getAttribute('stroke')).toBe('currentColor');
      expect(b.querySelector('.fb-s')!.getAttribute('fill')).toBe('currentColor');
    }
  });

  it('a click sends feedback once, and it is neither the visitor\'s message nor the model\'s', async () => {
    const { el, root, r } = await handedOff([answerTurn('m1', 'a-1')]);
    const conv = el._active();
    const modelBefore = JSON.stringify(conv.messages);
    const [up, down] = buttons(root);
    up.click();
    up.click();
    down.click();
    await until(() => r.feedback().length);
    await sleep(20);
    expect(r.feedback()).toHaveLength(1);
    expect(r.feedback()[0].params.message.parts[0].data).toEqual({ handoff: 'feedback', answerId: 'a-1', value: 'up' });
    expect(buttons(root).map((b) => [b.getAttribute('aria-pressed'), b.disabled])).toEqual([
      ['true', true],
      ['false', true],
    ]);
    // Nothing drawn as the visitor's, nothing for the model.
    expect(conv.items.filter((it: any) => it.kind === 'msg' && it.role === 'user')).toEqual([]);
    expect(root.querySelectorAll('.msg.user')).toHaveLength(0);
    expect(JSON.stringify(conv.messages)).toBe(modelBefore);
    expect(JSON.stringify(conv.messages)).not.toContain('feedback');
    // Kept with the answer: drawn again, it is still pressed and still can't be given twice.
    expect(conv.items.find((it: any) => it.kind === 'remote').feedback).toBe('up');
    el._renderThread();
    await until(() => buttons(root).length);
    expect(buttons(root).map((b) => [b.getAttribute('aria-pressed'), b.disabled])).toEqual([
      ['true', true],
      ['false', true],
    ]);
  });

  it('is disabled once the task is over', async () => {
    const done: A2AStreamResponse[] = [
      { statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED', message: { messageId: 'm2', role: 'ROLE_AGENT', parts: [{ text: 'Glad that helped.' }, ext({ handoff: 'handback', outcome: 'resolved', note: 'Answered.' })] } } } },
    ];
    const { el, root, r } = await handedOff([answerTurn('m1', 'a-1'), done]);
    expect(buttons(root).every((b) => !b.disabled)).toBe(true);
    await el._handoff.send(el._activeId, 'Thanks, that worked.');
    await until(() => buttons(root).every((b) => b.disabled));
    expect(buttons(root).map((b) => [b.getAttribute('aria-pressed'), b.disabled])).toEqual([
      ['false', true],
      ['false', true],
    ]);
    buttons(root)[1].click();
    await sleep(20);
    expect(r.feedback()).toHaveLength(0);
  });

  it('enables only an answer from the task that is open', () => {
    const open = { taskId: 't2', contextId: 'c2' } as any;
    expect(feedbackState({ task: 't2' }, open)).toEqual({ value: undefined, enabled: true });
    expect(feedbackState({ task: 't1' }, open).enabled).toBe(false);
    expect(feedbackState({}, open).enabled).toBe(false);
    expect(feedbackState({ task: 't2' }, null).enabled).toBe(false);
    expect(feedbackState({ task: 'c3' }, { contextId: 'c3' } as any).enabled).toBe(true);
  });

  /** The runner's `page`, as far as clickFeedback uses it: Playwright's locator, piercing the element's shadow root. */
  const page = (root: ShadowRoot) => ({
    locator: (selector: string) => {
      const all = () => [...root.querySelectorAll<HTMLButtonElement>(selector.replace(`${AGENT_HOST} `, ''))];
      const last = {
        waitFor: async ({ timeout }: { timeout: number }) => {
          for (const end = Date.now() + timeout; !all().length && Date.now() < end; ) await sleep(10);
          if (!all().length) throw new Error('timeout');
        },
        count: async () => all().length,
        isDisabled: async () => all().at(-1)!.disabled,
        click: async () => all().at(-1)!.click(),
        getAttribute: async (name: string) => all().at(-1)!.getAttribute(name),
      };
      return { last: () => last };
    },
  });

  it("the bench's feedback case field clicks 👎 on the last answer against the scripted Support Agent", async () => {
    const { root, r } = await handedOff([answerTurn('m1', 'a-1')]);
    expect(await clickFeedback(page(root), 'down')).toEqual({ clicked: true, detail: '' });
    await until(() => root.textContent?.includes('pass this to the team'));
    expect(r.feedback().map((p) => p.params.message.parts[0].data)).toEqual([{ handoff: 'feedback', answerId: 'a-1', value: 'down' }]);
    // The agent's reply to 👎 is drawn as its own; it has no answer, so no controls.
    expect(root.querySelectorAll('.remote')).toHaveLength(2);
    expect(root.querySelectorAll('.remote[data-answer-id]')).toHaveLength(1);
    // A second vote on the same answer: the case fails, saying why.
    expect(await clickFeedback(page(root), 'up')).toMatchObject({ clicked: false, detail: expect.stringContaining('disabled') });
  });
});
