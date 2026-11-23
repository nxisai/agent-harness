// @vitest-environment happy-dom
/**
 * Remote guardrails, part 5: `guardrails-src`. The element fetches the model proxy's
 * policy copy (in a chunk of its own), caches it with its ETag, merges it tighten-only, sends the version it holds
 * and fetches again when the proxy holds another. The proxy's refusals are typed, and the element says them with its
 * own messages and raises the same `nxis-guardrail` event. A fetch that fails leaves the built-in defaults.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';
import { createGuardrails, type GuardrailDecision } from '../src/guardrails/index';
import { attach } from '../src/guardrails/remote';
import { settingsFor } from '../src/guardrails/defaults';
import { glob } from '../src/guardrails/tools';
import { createProxyProvider } from '../src/providers/proxy';
import { scripted, settle } from './helpers/guard';

const KIT = { settingsFor, glob };
const copy = (p: object = {}) => JSON.stringify({ schema: 1, version: 'v1', ...p });

/** A policy endpoint the test controls: what it serves, with an ETag, and every request it was sent. */
function policyServer(initial: string | null) {
  let body = initial;
  let fail = false;
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const etag = () => `"${(body ?? '').length}-${body?.slice(-12)}"`;
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, headers });
    if (fail) throw new TypeError('Failed to fetch');
    if (body === null) return new Response('{"error":"Method not allowed."}', { status: 405 });
    if (headers['If-None-Match'] === etag()) return new Response(null, { status: 304, headers: { ETag: etag() } });
    return new Response(body, { headers: { ETag: etag(), 'Content-Type': 'application/json' } });
  });
  return { impl, seen, serve: (b: string | null) => void (body = b), fail: (f = true) => void (fail = f) };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('fetching the copy', () => {
  it('merges it tighten-only, and holds its version', async () => {
    const server = policyServer(copy({ input: { maxLength: 100 }, tools: { deny: ['delete_*'] } }));
    vi.stubGlobal('fetch', server.impl);
    const g = createGuardrails({ input: { maxLength: 3000 } });
    await attach(g, '/api/agent', KIT);
    expect(g.settings().input.maxLength).toBe(100);
    expect(g.config.tools?.deny).toEqual(['delete_*']);
    expect(g.remote?.version).toBe('v1');
    expect(g.remote?.held).toBe(false);
    expect(server.seen[0]).toMatchObject({ url: '/api/agent', headers: { Accept: 'application/json' } });
  });

  it('revalidates with its ETag, and reads the cached copy on a 304', async () => {
    const server = policyServer(copy({ input: { maxLength: 100 } }));
    vi.stubGlobal('fetch', server.impl);
    await attach(createGuardrails({}), '/api/agent', KIT);
    const g = createGuardrails({});
    await attach(g, '/api/agent', KIT);
    expect(server.seen[1].headers['If-None-Match']).toMatch(/^"/);
    expect(g.settings().input.maxLength).toBe(100);
  });

  it('says when the proxy holds the system prompt', async () => {
    vi.stubGlobal('fetch', policyServer(copy({ prompt: 'proxy' })).impl);
    const g = createGuardrails({});
    await attach(g, '/api/agent', KIT);
    expect(g.remote?.held).toBe(true);
  });

  it.each([
    ['the network fails', (s: ReturnType<typeof policyServer>) => s.fail()],
    ['there is no policy (405)', (s: ReturnType<typeof policyServer>) => s.serve(null)],
    ['the copy is malformed', (s: ReturnType<typeof policyServer>) => s.serve('{"schema":1,"version":"v","input":{"maxLength":-1}}')],
    ['the copy is another schema', (s: ReturnType<typeof policyServer>) => s.serve('{"schema":2,"version":"v"}')],
  ])('when %s, the built-in defaults apply', async (_n, breakIt) => {
    const server = policyServer(copy());
    breakIt(server);
    vi.stubGlobal('fetch', server.impl);
    const g = createGuardrails({});
    await attach(g, '/api/agent', KIT);
    expect(g.settings().input.maxLength).toBe(4000);
    expect(g.config).toEqual({});
    expect(warn.mock.calls.some((c) => String(c[0]).includes('using the built-in defaults'))).toBe(true);
  });

  it('a copy that loaded is kept when a later fetch fails: it can only be stricter', async () => {
    const server = policyServer(copy({ input: { maxLength: 100 } }));
    vi.stubGlobal('fetch', server.impl);
    const g = createGuardrails({});
    await attach(g, '/api/agent', KIT);
    server.fail();
    g.remote!.stale!('v2');
    await settle(5);
    expect(g.settings().input.maxLength).toBe(100);
  });
});

describe('the version check', () => {
  const conv = () => [{ role: 'system' as const, content: 'x' }, { role: 'user' as const, content: 'hi' }];

  it('sends the version held, and fetches again when the proxy holds another', async () => {
    const server = policyServer(copy({ version: 'v1' }));
    vi.stubGlobal('fetch', server.impl);
    const g = createGuardrails({});
    await attach(g, '/api/agent', KIT);
    const seen: unknown[] = [];
    const provider = {
      name: 'p',
      local: false,
      ready: true,
      loading: false,
      complete: async (r: { guardrails?: unknown }) => (seen.push(r.guardrails), { text: 'Hi.', guardrails: { version: 'v2' } }),
    };
    server.serve(copy({ version: 'v2', input: { maxLength: 50 } }));
    await g.model(provider as never).complete({ messages: conv(), tools: [] });
    expect(seen[0]).toEqual({ version: 'v1' });
    await settle(5);
    expect(g.remote?.version).toBe('v2');
    expect(g.settings().input.maxLength).toBe(50);
    // Told again about the same version, it doesn't fetch again.
    const fetches = server.seen.length;
    await g.model(provider as never).complete({ messages: conv(), tools: [] });
    await settle(5);
    expect(server.seen.length).toBe(fetches);
  });
});

describe("the proxy's refusals", () => {
  /** A proxy endpoint answering with a refusal, through the real proxy provider. */
  function refusing(status: number, refusal: object, headers: Record<string, string> = {}) {
    const sent: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      sent.push(init);
      return new Response(JSON.stringify({ error: 'Refused.', refusal }), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    }) as unknown as typeof fetch;
    return { provider: createProxyProvider({ endpoint: '/api/agent', fetchImpl }), sent };
  }

  it.each([
    [413, 'input', 'input/length', 'warning', 'That message is too long (over 4,000 characters). Please shorten it.'],
    [429, 'input', 'input/rate', 'warning', "You're sending messages quickly. Wait a moment, then try again."],
    [503, 'input', 'input/lockdown', 'critical', "The assistant isn't available right now. Please try again later."],
    // The proxy's spend cap, or the organization's credits used up: said as a pause.
    [503, 'input', 'spend/cap', 'critical', "The assistant isn't available right now. Please try again later."],
    [503, 'input', 'spend/credits', 'critical', "The assistant isn't available right now. Please try again later."],
    [503, 'tool', 'tool/lockdown', 'critical', "I can't take actions right now, but I can still answer questions."],
    [403, 'tool', 'tool/not-listed', 'warning', "I can't use that here."],
    [422, 'tool', 'tool/policy', 'critical', "I can't tell how safe that is, so I won't do it."],
    [429, 'model', 'model/budget', 'warning', "I've gone round too many times on this one. What next?"],
    [422, 'output', 'output/canary', 'critical', "I can't share that."],
    [422, 'output', 'output/secret', 'critical', "I can't show that reply: it looked like it held a password or a key."],
    [403, 'tool', 'tool/something-new', 'warning', "I can't help with that here."],
  ])('%i %s: said with the page’s own message, and reported as a decision', async (status, stage, rule, severity, said) => {
    const { provider } = refusing(status, { stage, rule, action: 'block', severity });
    const decisions: GuardrailDecision[] = [];
    const s = scripted({ tools: [{ name: 'hours', annotations: { readOnlyHint: true } }], replies: [], harness: { provider, guardrails: { onDecision: (d) => void decisions.push(d) } } });
    await s.turn('hello');
    expect(s.said).toEqual([said]);
    // A refusal that reads as a question ("What next?") gets the harness's one nudge to call a tool, as the local
    // budget refusal does, and the proxy refuses that too: the same decision.
    expect(decisions[0]).toEqual({ stage, rule, action: 'block', severity });
    expect(new Set(decisions.map((d) => JSON.stringify(d))).size).toBe(1);
  });

  it('only the four typed fields are kept; anything else is an ordinary failure', async () => {
    const odd = refusing(403, { stage: 'input', rule: 'input/rate', action: 'block', severity: 'warning', detail: 'visitor said: secret' });
    const done = await odd.provider.complete({ messages: [], tools: [] });
    expect(done.guardrails?.refusal).toEqual({ stage: 'input', rule: 'input/rate', action: 'block', severity: 'warning' });
    for (const bad of [{ stage: 'everywhere', rule: 'input/rate', action: 'block', severity: 'warning' }, { stage: 'input', rule: 'Hello <b>there</b>', action: 'block', severity: 'warning' }, { stage: 'input', rule: 'input/rate', action: 'allow', severity: 'warning' }]) {
      await expect(refusing(403, bad).provider.complete({ messages: [], tools: [] })).rejects.toThrow(/returned 403/);
    }
  });

  it('through the element: the event fires on it, with the same detail', async () => {
    const { provider } = refusing(429, { stage: 'input', rule: 'input/rate', action: 'block', severity: 'warning' });
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    (document as any).modelContext = Object.assign(new EventTarget(), { getTools: async () => [{ name: 'hours', annotations: { readOnlyHint: true } }], registerTool: async () => {} });
    el.modelProvider = provider;
    const events: unknown[] = [];
    el.addEventListener('nxis-guardrail', (e: CustomEvent) => events.push(e.detail));
    el.open();
    el._els.input.value = 'hello';
    await el._onSend();
    for (let i = 0; i < 100 && !events.length; i++) await settle(5);
    expect(events).toEqual([{ stage: 'input', rule: 'input/rate', action: 'block', severity: 'warning' }]);
    const said = [...el.shadowRoot.querySelectorAll('.msg.assistant')].map((m: Element) => m.textContent).join(' | ');
    expect(said).toContain("You're sending messages quickly.");
    delete (document as any).modelContext;
  });
});

describe('the proxy provider, with guardrails at the endpoint', () => {
  it('sends the conversation id it was issued, and the version held; neither before', async () => {
    const sent: Record<string, string>[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ text: 'Hi.' }), { headers: n++ === 0 ? { 'Nxis-Conversation': 'v1.abc.123.sig', 'Nxis-Guardrails-Version': 'v9' } : {} });
    }) as unknown as typeof fetch;
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl });
    const first = await p.complete({ messages: [], tools: [] });
    expect(first.guardrails).toEqual({ version: 'v9' });
    expect(Object.keys(sent[0]).filter((k) => k.startsWith('Nxis'))).toEqual([]);
    await p.complete({ messages: [], tools: [], guardrails: { version: 'v9' } });
    expect(sent[1]).toMatchObject({ 'Nxis-Conversation': 'v1.abc.123.sig', 'Nxis-Guardrails-Version': 'v9' });
  });
});

describe('guardrails-src on the element', () => {
  it('loads the policy chunk and applies the copy; without it, nothing is fetched', async () => {
    const server = policyServer(copy({ input: { maxLength: 20 } }));
    vi.stubGlobal('fetch', server.impl);
    const plain = document.createElement('nxis-agent') as any;
    plain.setAttribute('preload', 'none');
    plain.setAttribute('discover', 'false');
    document.body.append(plain);
    plain.open();
    for (let i = 0; i < 50 && !plain._g; i++) await settle(5);
    expect(plain._g.remote).toBeNull();
    expect(server.seen).toHaveLength(0);

    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    el.setAttribute('guardrails-src', '/api/agent');
    document.body.append(el);
    el.open();
    for (let i = 0; i < 100 && !el._g?.remote?.version; i++) await settle(5);
    expect(server.seen.map((s) => s.url)).toEqual(['/api/agent']);
    expect(el._g.settings().input.maxLength).toBe(20);
    // The page's own lockdown still works, and the policy never lifts it.
    el.guardrails.lockdown('incident', 'agent');
    expect(el._g.config.locked?.scope).toBe('agent');
  });
});
