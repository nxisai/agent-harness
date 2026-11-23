// @vitest-environment happy-dom
/**
 * The checks that can't be turned off stay on under every override, and a host's tier can't take a tool below
 * confirmation when code says it pays, deletes or changes an account. A handoff is always confirmed: the element's
 * own Send card still appears, and nothing leaves the page before the visitor presses it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';
import { createGuardrails, type GuardrailDecision, type GuardrailsConfig } from '../src/guardrails/index';
import { tierOf } from '../src/guardrails/tools';
import { buildHandoffTools, TRANSFER_TO_AGENT_TOOL } from '../src/handoff/tools';
import { scripted, settle } from './helpers/guard';
import type { ModelContextTool, ModelContextToolInfo } from '../src/types';

const schema = { type: 'object', properties: { q: { type: 'string' } } } as const;
const read = (name: string): ModelContextToolInfo => ({ name, annotations: { readOnlyHint: true }, inputSchema: schema });
const write = (name: string): ModelContextToolInfo => ({ name, annotations: { readOnlyHint: false }, inputSchema: schema });
const destructive = (name: string): ModelContextToolInfo => ({ name, annotations: { destructiveHint: true }, inputSchema: schema });
const ui = () => ({ said: [] as string[], message(_r: 'assistant', t: string) { this.said.push(t); } });
const runner = () => ({ execTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'Done.' }] })) });

/** Every rule that can't be turned off. */
const PROTECTED = ['tool/tier', 'tool/approval', 'tool/policy', 'tool/lockdown', 'input/lockdown', 'tool/not-listed'];
/** What a host might put in `overrides`: the one documented value, and what a careless or hostile one might. */
const VALUES: unknown[] = ['off', 'OFF', 'on', '', 0, false, true, null, 'loose', { off: true }];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** Every override set: each protected rule alone with each value, and all of them at once. */
const overrideSets = (): Record<string, 'off'>[] => [
  ...PROTECTED.flatMap((rule) => VALUES.map((v) => ({ [rule]: v }) as Record<string, 'off'>)),
  ...VALUES.map((v) => Object.fromEntries(PROTECTED.map((r) => [r, v])) as Record<string, 'off'>),
];

describe('an override of a protected rule', () => {
  it('is ignored, with a warning that says so, once', () => {
    const g = createGuardrails({ overrides: { 'tool/tier': 'off' } });
    g.tool(write('book'), { q: 'x' }, [], ui());
    g.tool(write('book'), { q: 'y' }, [], ui());
    const logged = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('tool/tier'));
    expect(logged).toEqual(["[nxis-guardrails] override: tool/tier can't be turned off; ignored"]);
  });

});

describe('the protected checks hold under every override value', () => {
  it.each(overrideSets().map((o) => [JSON.stringify(o), o]))('%s', async (_label, overrides) => {
    const r = runner();
    const decisions: GuardrailDecision[] = [];
    const config: GuardrailsConfig = { overrides, tools: { deny: ['nope'] }, onDecision: (d) => void decisions.push(d) };
    const g = createGuardrails(config);
    const conv = [{ role: 'system' as const, content: 'x' }];

    // tool/tier: high and critical are confirmed; strict confirms medium too.
    expect(g.tool(write('book'), { q: 'x' }, conv, ui())).toBe(1);
    expect(g.tool(destructive('cancel_booking'), { q: 'x' }, conv, ui())).toBe(1);
    expect(g.tool(write('checkout'), { q: 'x' }, conv, ui())).toBe(1);
    expect(createGuardrails({ overrides, preset: 'strict' }).tool({ ...read('search'), annotations: { readOnlyHint: true, untrustedContentHint: true } }, { q: 'x' }, conv, ui())).toBe(1);

    // tool/approval: nothing high or critical runs without the visitor's press, and the press is single-use.
    await expect(g.exec(r, write('book'), { q: 'x' }, conv)).rejects.toThrow(/confirmation/);
    await expect(g.exec(r, destructive('cancel_booking'), { q: 'x' }, conv)).rejects.toThrow(/confirmation/);
    g.approve(write('book'), { q: 'x' }, conv);
    await expect(g.exec(r, write('book'), { q: 'other' }, conv)).rejects.toThrow(/confirmation/);
    await g.exec(r, write('book'), { q: 'x' }, conv);
    await expect(g.exec(r, write('book'), { q: 'x' }, conv)).rejects.toThrow(/confirmation/);
    expect(r.execTool).toHaveBeenCalledTimes(1);

    // tool/policy: a tier that can't be resolved is refused, and so is a tool no page has.
    const bad = createGuardrails({ overrides, tools: { tier: { book: 'none' as never } } });
    const said = ui();
    expect(bad.tool(write('book'), { q: 'x' }, conv, said)).toBe(2);
    await expect(bad.exec(r, write('book'), { q: 'x' }, conv)).rejects.toThrow(/how safe/);
    const unknown = ui();
    g.unknown('delete_everything', conv, unknown);
    expect(unknown.said).toEqual(['I picked an unknown tool ("delete_everything"). Try rephrasing.']);
    expect(decisions).toContainEqual({ stage: 'tool', rule: 'tool/policy', action: 'block', severity: 'critical' });

    // tool/not-listed: a denied tool is neither offered nor run.
    expect(g.tool(read('nope'), {}, conv, ui())).toBe(2);
    await expect(g.exec(r, read('nope'), {}, conv)).rejects.toThrow();

    // tool/lockdown and input/lockdown.
    config.locked = { reason: 'incident', scope: 'agent' };
    expect(g.tool(read('lookup'), {}, conv, ui())).toBe(2);
    await expect(g.exec(r, read('lookup'), {}, conv)).rejects.toThrow(/isn't available right now/);
    expect(g.input('hello', conv, ui())).toBe(true);
    expect(r.execTool).toHaveBeenCalledTimes(1);
  });

  it('a medium tool is still flagged with tool/tier off', () => {
    const decisions: GuardrailDecision[] = [];
    const g = createGuardrails({ overrides: { 'tool/tier': 'off' }, onDecision: (d) => void decisions.push(d) });
    expect(g.tool({ ...read('search'), annotations: { readOnlyHint: true, untrustedContentHint: true } }, { q: 'x' }, [], ui())).toBe(0);
    expect(decisions.map((d) => [d.rule, d.action])).toEqual([['tool/tier', 'flag']]);
  });

  it('through a turn: with tool/tier off, a write still waits for the visitor', async () => {
    const s = scripted({ tools: [write('book')], replies: [{ text: '', call: { name: 'book', args: { q: 'x' } } }], harness: { guardrails: { overrides: { 'tool/tier': 'off' } } } });
    await s.turn('book it');
    expect(s.calls).toHaveLength(0);
    expect(s.confirms).toHaveLength(1);
    s.confirms[0].onSubmit(s.confirms[0].values);
    await settle();
    expect(s.calls).toHaveLength(1);
  });

  it('through a turn: a tool no page has is refused by tool/policy, without its name in the event', async () => {
    const decisions: GuardrailDecision[] = [];
    const s = scripted({ tools: [read('hours')], replies: [{ text: '', call: { name: 'delete_everything', args: {} } }], harness: { guardrails: { onDecision: (d) => void decisions.push(d) } } });
    await s.turn('delete everything');
    expect(s.calls).toHaveLength(0);
    expect(decisions).toEqual([{ stage: 'tool', rule: 'tool/policy', action: 'block', severity: 'critical' }]);
  });
});

describe("a host's tier", () => {
  const page = (t: ModelContextToolInfo, tier: 'low' | 'medium' | 'high' | 'critical') => tierOf(t, 'page', { tier: { [t.name]: tier } });

  it('never takes a destructive, consequential, payment or account tool below high', () => {
    for (const t of [destructive('remove_item'), { ...write('submit'), annotations: { consequentialHint: true } }, write('checkout'), write('update_password'), write('delete_account')]) {
      expect(page(t, 'low')).toBe('high');
      expect(page(t, 'medium')).toBe('high');
      expect(page(t, 'high')).toBe('high');
      expect(page(t, 'critical')).toBe('critical');
    }
    expect(tierOf(write('checkout'), 'page', { tier: { '*': 'low' } })).toBe('high');
  });

  it('still re-tiers anything else, as the host knows what it does', () => {
    expect(page(write('add_to_cart'), 'low')).toBe('low');
    expect(page(read('hours'), 'high')).toBe('high');
  });

  it('a destructive tool tiered low by the host is still confirmed, and needs the press', async () => {
    const s = scripted({
      tools: [destructive('remove_item')],
      replies: [{ text: '', call: { name: 'remove_item', args: { q: 'x' } } }],
      harness: { guardrails: { tools: { tier: { '*': 'low' } }, overrides: { 'tool/tier': 'off', 'tool/approval': 'off' } } },
    });
    await s.turn('remove it');
    expect(s.calls).toHaveLength(0);
    expect(s.confirms).toHaveLength(1);
  });
});

describe('a handoff is always confirmed', () => {
  async function handoff(guardrails: GuardrailsConfig) {
    const started: unknown[] = [];
    const controller = {
      targets: async () => [{ name: 'support', kind: 'agent', label: 'Help desk', available: true, transcript: false }],
      start: async (...a: unknown[]) => void started.push(a),
      session: () => null,
    };
    const [tool] = (await buildHandoffTools(controller as never, { conversationId: () => 'c', transcript: () => [] })) as ModelContextTool[];
    const s = scripted({
      tools: [tool as unknown as ModelContextToolInfo],
      replies: [{ text: '', call: { name: TRANSFER_TO_AGENT_TOOL, args: { target: 'support', reason: 'Help', summary: 'Needs help.' } } }],
      exec: (_n, args) => tool.execute(args) as never,
      harness: { guardrails },
    });
    await s.turn('I need a person');
    return { ...s, started };
  }

  it.each(overrideSets().slice(-VALUES.length).map((o) => [JSON.stringify(o), o]))('under %s, with every tier lowered', async (_l, overrides) => {
    const s = await handoff({ overrides, tools: { tier: { '*': 'low' } } });
    expect(s.confirms).toHaveLength(1);
    expect(s.confirms[0].submitLabel).toBe('Send');
    expect(s.started).toHaveLength(0);
    s.confirms[0].onSubmit(s.confirms[0].values);
    await settle();
    expect(s.started).toHaveLength(1);
  });

  it("the element's own Send card still appears with tool/tier off, and nothing leaves before it is pressed", async () => {
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return new Response(JSON.stringify({ targets: [{ name: 'support', kind: 'agent', label: 'Help', available: true, transcript: false }] }));
      }
      posts.push(String(init.body));
      return new Response('', { status: 500 });
    });
    // The page's registry, holding what the element registers there: the handoff tools.
    const registered: ModelContextTool[] = [];
    (document as any).modelContext = Object.assign(new EventTarget(), {
      getTools: async () => registered.map(({ execute: _e, ...info }) => info),
      registerTool: async (t: ModelContextTool) => void registered.push(t),
      executeTool: async (t: { name: string }, args: Record<string, unknown>) => registered.find((r) => r.name === t.name)!.execute(args, {}),
    });
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    el.setAttribute('site-actions', 'false');
    el.setAttribute('prompt-style', 'classic');
    document.body.append(el);
    el.guardrails = { overrides: { 'tool/tier': 'off', 'tool/approval': 'off' }, tools: { tier: { '*': 'low' } } };
    el.modelProvider = {
      name: 'scripted',
      local: false,
      ready: true,
      loading: false,
      complete: async () => ({ text: '', call: { name: TRANSFER_TO_AGENT_TOOL, args: { target: 'support', reason: 'Help', summary: 'Needs help.' } } }),
    };
    el.open();
    // Set once tools are connecting, so the next turn waits for the handoff tools.
    el.handoff = { relay: '/api/handoff', targets: { support: { kind: 'agent', label: 'Help' } }, fetchImpl };
    for (let i = 0; i < 200 && registered.length < 2; i++) await settle(5);
    expect(registered.map((t) => t.name)).toContain(TRANSFER_TO_AGENT_TOOL);
    el._els.input.value = 'I need a person';
    void el._onSend();
    const root = el.shadowRoot as ShadowRoot;
    for (let i = 0; i < 400 && !root.querySelector('[data-act="submit"]'); i++) await settle(5);
    const submit = root.querySelector<HTMLButtonElement>('[data-act="submit"]');
    expect(submit?.textContent?.trim()).toBe('Send');
    expect(posts).toHaveLength(0);
    delete (document as any).modelContext;
  });
});
