// @vitest-environment happy-dom
/**
 * The guardrails chunk can't load (a network failure, a blocked script, a deploy that dropped it): no turn runs,
 * nothing reaches the model, a tool or a remote agent, and the visitor reads a clear message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/guardrails/index.js', () => ({
  createGuardrails: () => {
    throw new TypeError('Failed to fetch dynamically imported module: https://site.example/guardrails-3XK.js');
  },
}));

import '../src/ui/agent';
import { scripted } from './helpers/guard';

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('when the guardrails cannot load', () => {
  it('a headless turn rejects before the model or any tool is reached', async () => {
    const s = scripted({ tools: [{ name: 'lookup', annotations: { readOnlyHint: true } }], replies: [{ text: '', call: { name: 'lookup', args: {} } }] });
    await expect(s.turn('hello')).rejects.toThrow(/dynamically imported module/);
    expect(s.requests).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
    expect(s.messages).toHaveLength(1);
    await expect(s.harness.begin('quote', 'lookup', {}, s.messages)).rejects.toThrow();
    expect(s.calls).toHaveLength(0);
  });

  it('the element sends nothing, to the model or to a remote agent, and says why', async () => {
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    const complete = vi.fn(async () => ({ text: 'Hello.' }));
    el.modelProvider = { name: 'x', local: false, ready: true, loading: false, complete };
    el.open();
    el._els.input.value = 'hello';
    await el._onSend();
    expect(complete).not.toHaveBeenCalled();
    const said = [...el.shadowRoot.querySelectorAll('.msg')].map((m: Element) => m.textContent).join(' | ');
    expect(said).toContain('The agent could not be downloaded. Check the connection and try again — nothing was lost.');

    // Handed off: the message does not go to the target either.
    const send = vi.fn(async () => {});
    el._handoff = { active: () => true, send, dispose() {}, resume: async () => {} };
    el._els.input.value = 'are you there?';
    await el._onSend();
    expect(send).not.toHaveBeenCalled();
  });
});
