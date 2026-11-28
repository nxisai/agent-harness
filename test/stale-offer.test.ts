// @vitest-environment happy-dom
/**
 * A card waiting for its button goes inert once the visitor moves on. In a real test run a "Hand over" offer stayed
 * live under later messages, and a typed "yes, send it" got "It's with the booking form now" though nothing had been
 * handed over: the model never learned the card wasn't pressed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

const until = async (ok: () => unknown, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('a stale offer', () => {
  it('goes inert when the visitor types instead, and the model reads that nothing was sent', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: any[] = [];
    const provider = {
      name: 'Stub',
      local: false,
      ready: true,
      loading: false,
      load: async () => {},
      complete: vi.fn(async (req: any) => {
        seen.push(JSON.stringify(req.messages ?? req));
        return { text: 'Nothing has been handed over yet.' };
      }),
    };
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    el.modelProvider = provider;
    document.body.append(el);
    el._newConversation?.(false);
    const conv = el._active();
    const item = { kind: 'action', id: 'a1', tool: 'transfer_to_agent', fields: [], stage: 'review', variant: 'handoff-agent', noun: 'handover', identity: { name: 'Book a visit' }, sentence: "I'll hand this conversation to Book a visit.", sendLabel: 'Hand over' };
    conv.items.push(item);
    el._live = { item, tool: { name: 'transfer_to_agent' }, sent: false, declining: false };
    el._renderThread();
    el._els.input.value = 'yes, send it';
    await el._onSend();
    await until(() => !el._turnActive);
    expect(item.stage).toBe('declined');
    expect(el._live).toBeNull();
    const note = conv.messages.find((m: any) => m.content === '[transfer_to_agent was not sent]');
    expect(note?.data).toMatch(/instead of pressing the card's Hand over button, so nothing was sent or handed over/);
    // Before the visitor's words, so the model reads it on this turn.
    // The card has no live buttons.
    const card = el.shadowRoot.querySelector('[data-action="a1"]');
    expect([...card.querySelectorAll('button')].some((b: Element) => b.textContent?.trim() === 'Hand over')).toBe(false);
  });
});
