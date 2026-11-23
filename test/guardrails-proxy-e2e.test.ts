// @vitest-environment happy-dom
/**
 * Remote guardrails, part 6: the page against a proxy that keeps the contract, end
 * to end with a scripted model. A policy change on the proxy applies to its next request with no page deploy, and
 * the page picks up the new version and enforces it too. If the copy can't be fetched, the page runs on the built-in
 * defaults and the proxy still refuses. The proxy here is a stand-in written to the contract; the agent-model-proxy
 * skill has the real one, with its own tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuardrails, type GuardrailDecision } from '../src/guardrails/index';
import { attach } from '../src/guardrails/remote';
import { browserCopy, parsePolicy, settingsFor, type GuardrailsPolicy } from '../src/guardrails/policy';
import { glob } from '../src/guardrails/tools';
import { createProxyProvider } from '../src/providers/proxy';
import { scripted, settle } from './helpers/guard';

/** A proxy to the contract: the copy on GET, the version check and an input-length refusal on POST. */
function proxy(initial: GuardrailsPolicy) {
  let policy = initial;
  let down = false;
  const asked: { headers: Record<string, string>; body: { messages: { role: string; content: string }[] } }[] = [];
  const answer = async (_url: string, init?: RequestInit): Promise<Response> => {
    if (!init?.method || init.method === 'GET') {
      if (down) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(browserCopy(policy)), { headers: { ETag: `"${policy.version}"` } });
    }
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body));
    asked.push({ headers, body });
    const version = headers['Nxis-Guardrails-Version'] === policy.version ? {} : { 'Nxis-Guardrails-Version': policy.version };
    const max = settingsFor({ input: policy.input }).input.maxLength;
    if (String(body.messages.at(-1)?.content ?? '').length > max) {
      return new Response(JSON.stringify({ error: 'Too long.', refusal: { stage: 'input', rule: 'input/length', action: 'block', severity: 'warning' } }), { status: 413, headers: version });
    }
    return new Response(JSON.stringify({ text: 'Hello.' }), { headers: version });
  };
  return { answer, asked, set: (p: GuardrailsPolicy) => void (policy = parsePolicy(p)), down: (d = true) => void (down = d) };
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function page(p: ReturnType<typeof proxy>) {
  vi.stubGlobal('fetch', vi.fn(p.answer));
  const decisions: GuardrailDecision[] = [];
  const config = { onDecision: (d: GuardrailDecision) => void decisions.push(d) };
  const provider = createProxyProvider({ endpoint: '/api/agent', fetchImpl: p.answer as typeof fetch });
  const s = scripted({ tools: [{ name: 'hours', annotations: { readOnlyHint: true } }], replies: [], harness: { provider, guardrails: config } });
  const g = createGuardrails(config);
  return { s, g, decisions, ready: attach(g, '/api/agent', { settingsFor, glob }) };
}

describe('the page and a proxy that keeps the contract', () => {
  it('a policy change applies at the proxy on its next request, and the page picks up the new version', async () => {
    const p = proxy(parsePolicy({ schema: 1, version: 'v1' }));
    const { s, g, decisions, ready } = page(p);
    await ready;
    await s.turn('hello');
    expect(p.asked[0].headers['Nxis-Guardrails-Version']).toBe('v1');
    expect(s.said).toEqual(['Hello.']);

    // Changed on the proxy, no page deploy: its next request is refused there, with the page's own message.
    p.set({ schema: 1, version: 'v2', input: { maxLength: 20 } });
    await s.turn('a message well over twenty characters');
    expect(s.said.at(-1)).toBe('That message is too long (over 4,000 characters). Please shorten it.');
    expect(decisions.at(-1)).toEqual({ stage: 'input', rule: 'input/length', action: 'block', severity: 'warning' });

    // The proxy said it holds v2: the page fetched it, and now refuses before sending.
    await settle(5);
    expect(g.remote?.version).toBe('v2');
    const sent = p.asked.length;
    await s.turn('another message well over twenty characters');
    expect(p.asked.length).toBe(sent);
    expect(s.said.at(-1)).toBe('That message is too long (over 20 characters). Please shorten it.');
  });

  it('when the copy cannot be fetched, the page runs on the built-in defaults, and the proxy still enforces', async () => {
    const p = proxy(parsePolicy({ schema: 1, version: 'v1', input: { maxLength: 20 } }));
    p.down();
    const { s, g, ready } = page(p);
    await ready;
    expect(g.settings().input.maxLength).toBe(4000);
    await s.turn('a message well over twenty characters');
    // The page let it go; the proxy refused it.
    expect(p.asked).toHaveLength(1);
    expect(s.said.at(-1)).toMatch(/^That message is too long/);
  });

  it('a held prompt: the page sends the proxy no system prompt', async () => {
    const p = proxy(parsePolicy({ schema: 1, version: 'v1', systemPrompt: 'SERVER PROMPT' }));
    const { s, g, ready } = page(p);
    await ready;
    expect(g.remote?.held).toBe(true);
    await s.turn('hi');
    expect(p.asked[0].body.messages.map((m) => m.role)).toEqual(['user']);
  });
});
