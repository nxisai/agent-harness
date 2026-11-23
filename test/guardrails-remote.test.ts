// @vitest-environment happy-dom
/**
 * Remote guardrails, part 4: a system prompt the proxy holds. When the policy says
 * so, the page sends a remote model no system prompt (the proxy uses its own, with its own canary); an on-device
 * model still gets the page's. The policy's merge applies on every read of the configuration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuardrails, type RemotePolicy } from '../src/guardrails/index';
import { tighten } from '../src/guardrails/policy';
import { scripted } from './helpers/guard';
import type { CompletionRequest } from '../src/providers/types';

beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

/** A provider that records what it was sent. */
function provider(local: boolean) {
  const sent: CompletionRequest[] = [];
  return { sent, p: { name: 'p', local, ready: true, loading: false, complete: async (r: CompletionRequest) => (sent.push(r), { text: 'Hi.' }) } };
}

const remote = (r: Partial<RemotePolicy> = {}): RemotePolicy => ({ merge: (c) => c, ...r });

describe('a system prompt the proxy holds', () => {
  it('a remote model is sent no system prompt, and no canary', async () => {
    const g = createGuardrails({});
    g.remote = remote({ held: true });
    const { p, sent } = provider(false);
    const conv = [{ role: 'system' as const, content: 'PAGE PROMPT' }, { role: 'user' as const, content: 'hi' }];
    await g.model(p as never).complete({ messages: conv, tools: [] });
    expect(sent[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(JSON.stringify(sent[0])).not.toContain('PAGE PROMPT');
    expect(JSON.stringify(sent[0])).not.toContain('Private marker');
  });

  it('an on-device model still gets the page’s prompt: it has no proxy', async () => {
    const g = createGuardrails({});
    g.remote = remote({ held: true });
    const { p, sent } = provider(true);
    await g.model(p as never).complete({ messages: [{ role: 'system', content: 'PAGE PROMPT' }, { role: 'user', content: 'hi' }], tools: [] });
    expect(sent[0].messages[0].content).toContain('PAGE PROMPT');
    expect(sent[0].messages[0].content).toContain('Private marker');
  });

  it('without a held prompt, the page’s prompt goes as before', async () => {
    const g = createGuardrails({});
    g.remote = remote({ held: false });
    const { p, sent } = provider(false);
    await g.model(p as never).complete({ messages: [{ role: 'system', content: 'PAGE PROMPT' }, { role: 'user', content: 'hi' }], tools: [] });
    expect(sent[0].messages[0]).toMatchObject({ role: 'system' });
    expect(sent[0].messages[0].content).toContain('PAGE PROMPT');
  });

  it('through a turn', async () => {
    const s = scripted({ tools: [{ name: 'hours', annotations: { readOnlyHint: true } }], replies: [{ text: 'Hello.' }] });
    await s.turn('hi');
    expect(s.requests[0].messages[0].role).toBe('system');
    const g = createGuardrails(s.harness['opts'].guardrails as never);
    g.remote = remote({ held: true });
    await s.turn('again');
    expect(s.requests[1].messages.some((m) => m.role === 'system')).toBe(false);
  });
});

describe("the policy's merge", () => {
  it('applies on every read of the configuration, and never changes the page’s own', () => {
    const page = { input: { maxLength: 3000 } };
    const g = createGuardrails(page);
    expect(g.settings().input.maxLength).toBe(3000);
    g.remote = remote({ merge: (c) => tighten(c, { schema: 1, version: 'v', input: { maxLength: 100 } }) });
    expect(g.settings().input.maxLength).toBe(100);
    expect(page.input.maxLength).toBe(3000);
    g.remote = null;
    expect(g.settings().input.maxLength).toBe(3000);
  });

  it('on the element, over its property and its attribute', () => {
    const el = Object.assign(new EventTarget(), { guardrails: {}, getAttribute: (n: string) => (n === 'guardrails' ? 'strict' : null) });
    const g = createGuardrails(el as never);
    g.remote = remote({ merge: (c) => tighten(c, { schema: 1, version: 'v', input: { maxLength: 100 } }) });
    expect(g.config.preset).toBe('strict');
    expect(g.settings().input.maxLength).toBe(100);
  });
});
