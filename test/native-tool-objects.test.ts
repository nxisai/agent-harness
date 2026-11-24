/**
 * Tools whose fields aren't own properties, as Chrome's native `getTools()` returns them:
 * every field an accessor on the prototype, so an object spread copies nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderTools } from '../src/guardrails/index';
import { refreshHandoffTools } from '../src/handoff/tools';
import { createProxyProvider } from '../src/index';
import type { ModelContextToolInfo } from '../src/types';

const SCHEMA = { type: 'object', properties: { q: { type: 'string', description: 'What to look for.' } }, required: ['q'] };

/** Like Chrome's `Tool`: class getters, no own properties. */
class NativeTool {
  #name: string;
  constructor(name: string) {
    this.#name = name;
  }
  get name() {
    return this.#name;
  }
  get description() {
    return `Looks things up (${this.#name}).`;
  }
  get title() {
    return '';
  }
  get inputSchema() {
    return SCHEMA;
  }
  get annotations() {
    return { readOnlyHint: true };
  }
  get origin() {
    return 'https://example.com';
  }
}

/** A plain object whose name is there but not enumerable. */
function hiddenName(name: string): ModelContextToolInfo {
  const t = { description: `Looks things up (${name}).`, inputSchema: SCHEMA } as ModelContextToolInfo;
  Object.defineProperty(t, 'name', { value: name, enumerable: false });
  return t;
}

const native = (name: string) => new NativeTool(name) as unknown as ModelContextToolInfo;
const src = { origin: () => 'mcp' as const, hinted: () => false };

describe('tools that keep their fields off the object', () => {
  it('are what a spread loses: the premise', () => {
    expect(Object.keys({ ...native('search') })).toEqual([]);
    expect(Object.keys({ ...hiddenName('fetch') })).not.toContain('name');
  });

  it('keep name and schema through renderTools, with the description wrapped; own tools are unchanged', () => {
    const own = native('open_page');
    const out = renderTools([native('search'), hiddenName('fetch'), own], 'bbbbbbbbbbbb', src);
    expect(out[0].name).toBe('search');
    expect(out[0].inputSchema).toEqual(SCHEMA);
    expect(out[0].annotations).toEqual({ readOnlyHint: true });
    expect(out[0].origin).toBe('https://example.com');
    expect(out[0].description).toBe(
      '<data-bbbbbbbbbbbb source="mcp tool description" trust="untrusted">\nLooks things up (search).\n</data-bbbbbbbbbbbb>',
    );
    expect(out[1].name).toBe('fetch');
    expect(out[1].inputSchema).toEqual(SCHEMA);
    expect(out[1].description).toContain('source="mcp tool description" trust="untrusted"');
    expect(out[2]).toBe(own);
  });

  it('keep their name through refreshHandoffTools, and a handoff tool is built afresh', () => {
    const [kept, handoff] = refreshHandoffTools([native('search'), native('transfer_to_agent')], [
      { kind: 'agent', name: 'support', label: 'Support', description: 'Answers questions.', available: true } as never,
    ]);
    expect(kept.name).toBe('search');
    expect(handoff.name).toBe('transfer_to_agent');
    expect(handoff.origin).toBe('https://example.com');
    expect(Object.keys(handoff.inputSchema as object)).toContain('properties');
  });

  it('reach the proxy with name, wrapped description and schema', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl });
    const tools = renderTools([native('search'), hiddenName('fetch'), native('open_page')], 'bbbbbbbbbbbb', src);
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], tools });
    const sent = JSON.parse(calls[0].body as string).tools as { name: string; description: string; inputSchema: { properties?: object } }[];
    expect(sent.map((t) => t.name)).toEqual(['search', 'fetch', 'open_page']);
    expect(sent[0].description).toContain('trust="untrusted"');
    expect(sent[1].description).toContain('trust="untrusted"');
    expect(sent[2].description).toBe('Looks things up (open_page).');
    for (const t of sent) expect(Object.keys(t.inputSchema.properties ?? {})).toEqual(['q']);
  });

  it('a tool with no name is left out of the proxy request, with a warning', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createProxyProvider({ endpoint: '/api/agent', fetchImpl });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [{ description: 'Nameless.' } as ModelContextToolInfo, native('search')] });
    expect(JSON.parse(calls[0].body as string).tools.map((t: { name: string }) => t.name)).toEqual(['search']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no name'), expect.anything());
    warn.mockRestore();
  });
});
