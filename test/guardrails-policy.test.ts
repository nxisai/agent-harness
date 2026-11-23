// @vitest-environment happy-dom
/**
 * Remote guardrails, part 1: the policy document, and its tighten-only merge over
 * the page's configuration. A policy can only make things stricter: every floor below is proved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuardrails, STANDARD, STRICT, type GuardrailDecision, type GuardrailsConfig } from '../src/guardrails/index';
import { settingsFor } from '../src/guardrails/defaults';
import { browserCopy, parsePolicy, PolicyError, PROTECTED_RULES, tighten, type GuardrailsPolicy } from '../src/guardrails/policy';
import type { ModelContextToolInfo } from '../src/types';

const schema = { type: 'object', properties: { q: { type: 'string' } } } as const;
const read = (name: string): ModelContextToolInfo => ({ name, annotations: { readOnlyHint: true }, inputSchema: schema });
const write = (name: string): ModelContextToolInfo => ({ name, annotations: { readOnlyHint: false }, inputSchema: schema });
const ui = () => ({ said: [] as string[], message(_r: 'assistant', t: string) { this.said.push(t); } });
const runner = () => ({ execTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'Done.' }] })) });
const policy = (p: Partial<GuardrailsPolicy> = {}): GuardrailsPolicy => ({ schema: 1, version: 'v1', ...p });

beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('the document', () => {
  it('reads a full policy', () => {
    const doc = {
      schema: 1,
      version: '2026-11-10.1',
      preset: 'strict',
      input: { maxLength: 1000, sendsPerMinute: 5 },
      tools: { allow: ['search_*'], deny: ['delete_*'], tier: { book: 'critical' }, maxPerTurn: 2, perMinute: 10, timeoutMs: 5000 },
      model: { maxSteps: 4, maxTokens: 4000 },
      conversation: { maxGenerations: 40, maxOutputTokens: 20000 },
      output: { maxLength: 2000, linkOrigins: ['https://help.example.com'] },
      overrides: { 'input/injection-phrases': 'off' },
      lockdown: { scope: 'tools', reason: 'incident 42' },
      systemPrompt: 'You help on Example.',
      somethingNewer: { ignored: true },
    };
    const p = parsePolicy(JSON.stringify(doc));
    const { somethingNewer: _drop, ...known } = doc;
    expect(p).toEqual(known);
  });

  it.each([
    [null, /JSON object/],
    ['not json', /JSON object/],
    [{ version: 'v1' }, /schema/],
    [{ schema: 2, version: 'v1' }, /schema/],
    [{ schema: 1 }, /version/],
    [{ schema: 1, version: '' }, /version/],
    [{ schema: 1, version: 'v', preset: 'lenient' }, /preset/],
    [{ schema: 1, version: 'v', input: { maxLength: -1 } }, /input.maxLength/],
    [{ schema: 1, version: 'v', input: { maxLength: '4000' } }, /input.maxLength/],
    [{ schema: 1, version: 'v', tools: { perMinute: Infinity } }, /tools.perMinute/],
    [{ schema: 1, version: 'v', tools: { allow: 'search' } }, /tools.allow/],
    [{ schema: 1, version: 'v', tools: { tier: { book: 'none' } } }, /tier/],
    [{ schema: 1, version: 'v', lockdown: { scope: 'everything' } }, /lockdown/],
    [{ schema: 1, version: 'v', systemPrompt: 42 }, /systemPrompt/],
  ])('refuses %j whole', (doc, msg) => {
    expect(() => parsePolicy(doc as never)).toThrow(PolicyError);
    expect(() => parsePolicy(doc as never)).toThrow(msg);
  });

  it('keeps only "off" overrides', () => {
    expect(parsePolicy({ schema: 1, version: 'v', overrides: { a: 'off', b: 'on', c: true } }).overrides).toEqual({ a: 'off' });
  });

  it('the browser copy never carries the system prompt, and says the proxy holds one', () => {
    const copy = browserCopy(parsePolicy({ schema: 1, version: 'v', systemPrompt: 'SECRET PROMPT', input: { maxLength: 100 } }));
    expect(copy).toEqual({ schema: 1, version: 'v', input: { maxLength: 100 }, prompt: 'proxy' });
    expect(JSON.stringify(copy)).not.toContain('SECRET PROMPT');
    expect(browserCopy(policy())).toEqual({ schema: 1, version: 'v1' });
    // The page reads its copy back.
    expect(parsePolicy(JSON.parse(JSON.stringify(copy))).prompt).toBe('proxy');
  });
});

describe('tighten-only: a policy lowers, never raises', () => {
  const numbers: [string, (p: number) => Partial<GuardrailsPolicy>, (s: ReturnType<typeof settingsFor>) => number][] = [
    ['input.maxLength', (n) => ({ input: { maxLength: n } }), (s) => s.input.maxLength],
    ['input.sendsPerMinute', (n) => ({ input: { sendsPerMinute: n } }), (s) => s.input.sendsPerMinute],
    ['tools.maxPerTurn', (n) => ({ tools: { maxPerTurn: n } }), (s) => s.tools.maxPerTurn],
    ['tools.perMinute', (n) => ({ tools: { perMinute: n } }), (s) => s.tools.perMinute],
    ['tools.timeoutMs', (n) => ({ tools: { timeoutMs: n } }), (s) => s.tools.timeoutMs],
    ['output.maxLength', (n) => ({ output: { maxLength: n } }), (s) => s.output.maxLength],
  ];

  it.each(numbers)('%s', (_name, make, get) => {
    for (const preset of ['standard', 'strict'] as const) {
      const floor = get(preset === 'strict' ? STRICT : STANDARD);
      // Higher than the built-in floor: the floor stands.
      expect(get(settingsFor(tighten({ preset }, policy(make(floor * 10)))))).toBe(floor);
      // Lower: the policy's.
      expect(get(settingsFor(tighten({ preset }, policy(make(1)))))).toBe(1);
    }
    // With nothing set by the page, a huge number in a policy still leaves the built-in floor.
    const page: GuardrailsConfig = tighten({}, policy(make(1_000_000)));
    expect(get(settingsFor(page))).toBe(get(STANDARD));
  });

  it("a page's own higher limit is lowered by the policy, never raised past it", () => {
    const page: GuardrailsConfig = { input: { maxLength: 9000 } };
    expect(settingsFor(tighten(page, policy({ input: { maxLength: 20_000 } }))).input.maxLength).toBe(9000);
    expect(settingsFor(tighten(page, policy({ input: { maxLength: 500 } }))).input.maxLength).toBe(500);
  });

  it("'standard' never switches strict off", () => {
    expect(tighten({ preset: 'strict' }, policy({ preset: 'standard' })).preset).toBe('strict');
    expect(tighten({}, policy({ preset: 'strict' })).preset).toBe('strict');
  });

  it("leaves the page's own object as it was", () => {
    const page: GuardrailsConfig = { tools: { deny: ['a'] }, input: { maxLength: 100 } };
    const before = JSON.stringify(page);
    tighten(page, policy({ tools: { deny: ['b'], allow: ['x'] }, input: { maxLength: 10 }, lockdown: { scope: 'agent', reason: 'r' } }));
    expect(JSON.stringify(page)).toBe(before);
  });
});

describe('tighten-only: tools', () => {
  it('deny is both lists', () => {
    expect(tighten({ tools: { deny: ['a'] } }, policy({ tools: { deny: ['b'] } })).tools?.deny).toEqual(['a', 'b']);
  });

  it('allow is only what both allow: a policy can narrow the list, never add to it', () => {
    const g = createGuardrails(tighten({ tools: { allow: ['search_*', 'book'] } }, policy({ tools: { allow: ['search_web', 'delete_account'] } })));
    const conv = [{ role: 'system' as const, content: 'x' }];
    expect(g.tool(read('search_web'), {}, conv, ui())).toBe(0);
    expect(g.tool(read('search_news'), {}, conv, ui())).toBe(2);
    expect(g.tool(write('book'), {}, conv, ui())).toBe(2);
    expect(g.tool(write('delete_account'), {}, conv, ui())).toBe(2);
    // A page with no allowlist takes the policy's.
    expect(tighten({}, policy({ tools: { allow: ['hours'] } })).tools?.allow).toEqual(['hours']);
  });

  it("a policy's tier raises a tool's, and the raised tool needs the visitor's bound approval", async () => {
    const decisions: GuardrailDecision[] = [];
    const g = createGuardrails(tighten({ onDecision: (d) => void decisions.push(d) }, policy({ tools: { tier: { lookup: 'high' } } })));
    const conv = [{ role: 'system' as const, content: 'x' }];
    const r = runner();
    await expect(g.tool(read('lookup'), { q: 'x' }, conv, ui())).resolves.toBe(1);
    expect(decisions).toContainEqual({ stage: 'tool', rule: 'policy/tier', action: 'confirm', severity: 'info', tool: 'lookup', tier: 'low' });
    await expect(g.exec(r, read('lookup'), { q: 'x' }, conv)).rejects.toThrow(/confirmation/);
    g.approve(read('lookup'), { q: 'x' }, conv);
    await g.exec(r, read('lookup'), { q: 'x' }, conv);
    expect(r.execTool).toHaveBeenCalledTimes(1);
  });

  it("a policy's lower tier never lowers the page's", async () => {
    const g = createGuardrails(tighten({ tools: { tier: { hours: 'high' } } }, policy({ tools: { tier: { book: 'low', hours: 'low', '*': 'low' } } })));
    const conv = [{ role: 'system' as const, content: 'x' }];
    // A write is still high (confirmed); the page's high stands; a destructive tool is still confirmed.
    expect(await g.tool(write('book'), { q: 'x' }, conv, ui())).toBe(1);
    expect(await g.tool(read('hours'), { q: 'x' }, conv, ui())).toBe(1);
    expect(await g.tool({ ...write('wipe'), annotations: { destructiveHint: true } }, { q: 'x' }, conv, ui())).toBe(1);
    await expect(g.exec(runner(), write('book'), { q: 'x' }, conv)).rejects.toThrow(/confirmation/);
  });

  it("a medium floor flags a low tool, and confirms it in strict", async () => {
    const decisions: GuardrailDecision[] = [];
    const conv = [{ role: 'system' as const, content: 'x' }];
    const std = createGuardrails(tighten({ onDecision: (d) => void decisions.push(d) }, policy({ tools: { tier: { hours: 'medium' } } })));
    expect(await std.tool(read('hours'), { q: 'x' }, conv, ui())).toBe(0);
    expect(decisions.map((d) => [d.rule, d.action])).toEqual([['policy/tier', 'flag']]);
    const strict = createGuardrails(tighten({}, policy({ preset: 'strict', tools: { tier: { hours: 'medium' } } })));
    expect(await strict.tool(read('hours'), { q: 'x' }, conv, ui())).toBe(1);
  });
});

describe('tighten-only: links, overrides, the kill switch', () => {
  it('linkOrigins narrows where links open without asking, and never adds an origin', () => {
    const el = Object.assign(new EventTarget(), {
      guardrails: tighten({ output: { linkOrigins: ['https://a.example', 'https://b.example'] } }, policy({ output: { linkOrigins: ['https://b.example', 'https://evil.example'] } })),
      getAttribute: (n: string) => (n === 'link-origins' ? 'https://c.example' : null),
    });
    const g = createGuardrails(el as never);
    expect(g.origins()).toEqual([location.origin, 'https://b.example']);
  });

  it.each(PROTECTED_RULES)('can’t turn %s off', async (rule) => {
    const merged = tighten({ tools: { deny: ['nope'] } }, policy({ overrides: { [rule]: 'off' } }));
    expect(merged.overrides?.[rule]).toBeUndefined();
    // And the check holds, even when the page's own config tried as well.
    const g = createGuardrails({ ...merged, overrides: { [rule]: 'off' } });
    const conv = [{ role: 'system' as const, content: 'x' }];
    const r = runner();
    expect(g.tool(write('book'), { q: 'x' }, conv, ui())).toBe(1);
    await expect(g.exec(r, write('book'), { q: 'x' }, conv)).rejects.toThrow(/confirmation/);
    expect(g.tool(read('nope'), {}, conv, ui())).toBe(2);
    const bad = createGuardrails(tighten({ tools: { tier: { x: 'none' as never } } }, policy({ overrides: { [rule]: 'off' } })));
    expect(bad.tool(write('x'), {}, conv, ui())).toBe(2);
    const locked = createGuardrails(tighten({}, policy({ overrides: { [rule]: 'off' }, lockdown: { scope: 'agent', reason: 'r' } })));
    expect(locked.tool(read('hours'), {}, conv, ui())).toBe(2);
    expect(locked.input('hello', conv, ui())).toBe(true);
    expect(r.execTool).not.toHaveBeenCalled();
  });

  it('turns off what a host could turn off in code', () => {
    expect(tighten({}, policy({ overrides: { 'input/injection-phrases': 'off' } })).overrides).toEqual({ 'input/injection-phrases': 'off' });
  });

  it("locks down, takes the stricter scope, and never lifts the page's own lock", () => {
    expect(tighten({}, policy({ lockdown: { scope: 'tools', reason: 'r' } })).locked).toEqual({ scope: 'tools', reason: 'r' });
    expect(tighten({ locked: { scope: 'tools', reason: 'page' } }, policy({ lockdown: { scope: 'agent', reason: 'r' } })).locked?.scope).toBe('agent');
    expect(tighten({ locked: { scope: 'agent', reason: 'page' } }, policy({ lockdown: { scope: 'tools', reason: 'r' } })).locked?.scope).toBe('agent');
    expect(tighten({ locked: { scope: 'tools', reason: 'page' } }, policy({ lockdown: null })).locked).toEqual({ scope: 'tools', reason: 'page' });
  });

  it('keeps the page’s rules, and its callbacks', () => {
    const onDecision = () => {};
    const rule = { id: 'acme/x', stage: 'input' as const, check: () => ({ action: 'allow' as const }) };
    const merged = tighten({ onDecision, rules: [rule] }, policy({ tools: { tier: { a: 'high' } } }));
    expect(merged.onDecision).toBe(onDecision);
    expect(merged.rules?.map((r) => r.id)).toEqual(['acme/x', 'policy/tier']);
  });
});
