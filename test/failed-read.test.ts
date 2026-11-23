/**
 * A lookup the server refuses: the model made up an @id. The server's reason reaches the model, not the
 * registry's "the invocation failed", and the turn gets one more try to make the right call or say plainly
 * that there is nothing to find.
 */
import { describe, expect, it } from 'vitest';
import { failed, registerRemoteTools } from '../src/harness/tools/bridge';
import { AgentHarness } from '../src/harness/harness';

const NOT_FOUND = "MCP error -32602: Failed to get entity: NOT_FOUND: Entity with @id 'https://mcmanus-electric.example' not found";

describe('the bridge', () => {
  it("returns the server's refusal as a result, with how to find the record", () => {
    const res = failed('nxis_get', new Error(NOT_FOUND));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^Failed to get entity: NOT_FOUND: Entity with @id 'https:\/\/mcmanus-electric\.example' not found/);
    expect(res.content[0].text).toMatch(/Find it with nxis_query first/);
    expect(failed('nxis_query', new Error('MCP error -32602: bad filter')).content[0].text).toBe('bad filter');
  });

  it('does not throw a refused call into the registry', async () => {
    let execute: ((i: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text?: string }[] }>) | undefined;
    const client = {
      listTools: async () => ({ tools: [{ name: 'nxis_get' }] }),
      callTool: async () => {
        throw new Error(NOT_FOUND);
      },
    };
    const mc = { registerTool: (t: { execute: typeof execute }) => void (execute = t.execute) };
    await registerRemoteTools(client as never, mc as never, { publicTools: [] } as never);
    const res = await execute!({ id: 'https://mcmanus-electric.example' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/);
  });
});

describe('a turn whose lookup fails', () => {
  const tools = [
    { name: 'nxis_get', annotations: { readOnlyHint: true } },
    { name: 'nxis_query', annotations: { readOnlyHint: true } },
  ];

  const run = async (replies: { text: string; call?: { name: string; args: Record<string, unknown> } }[], fails: string[]) => {
    const calls: string[] = [];
    const said: string[] = [];
    const bubble = { thinking() {}, update() {}, finalize: (t: string) => t && said.push(t) };
    const renderer = {
      streaming: () => bubble,
      message: (_r: string, t: string) => said.push(t),
      status() {},
      results() {},
      toolError() {},
    };
    let n = 0;
    const provider = { ready: true, load: async () => {}, complete: async () => replies[Math.min(n++, replies.length - 1)] };
    const toolSource = {
      discoverTools: async () => tools,
      execTool: async (_t: unknown, name: string) => {
        calls.push(name);
        return fails.includes(name)
          ? { content: [{ type: 'text', text: 'Entity not found. Find it with nxis_query first.' }], isError: true }
          : { content: [{ type: 'text', text: '{"results":[]}' }] };
      },
    };
    const messages: { role: string; content: string }[] = [];
    const harness = new AgentHarness({ provider, toolSource, renderer, recommend: false } as never);
    await harness.turn('Show some reviews for McManus Electric', messages as never);
    return { calls, said, messages, completions: n };
  };

  it('tries once more, and makes the call it should have made', async () => {
    const { calls, messages } = await run(
      [
        { text: '', call: { name: 'nxis_get', args: { id: 'https://mcmanus-electric.example' } } },
        { text: '', call: { name: 'nxis_query', args: { schema_type: 'Review' } } },
        { text: 'McManus Electric has no reviews here yet.' },
      ],
      ['nxis_get'],
    );
    expect(calls).toEqual(['nxis_get', 'nxis_query']);
    // Why it failed is the server's text: data, apart from the harness's own words.
    expect(messages).toContainEqual({
      role: 'user',
      content: '[nxis_get did not go through]',
      data: 'Entity not found. Find it with nxis_query first.',
    });
  });

  it('may answer in words instead: there is nothing to find', async () => {
    const { calls, said } = await run(
      [
        { text: '', call: { name: 'nxis_get', args: { id: 'https://mcmanus-electric.example' } } },
        { text: 'McManus Electric has no written reviews here.' },
      ],
      ['nxis_get'],
    );
    expect(calls).toEqual(['nxis_get']);
    expect(said).toContain('McManus Electric has no written reviews here.');
  });

  it('tries only once', async () => {
    const { calls, completions } = await run(
      [{ text: '', call: { name: 'nxis_get', args: { id: 'x' } } }],
      ['nxis_get'],
    );
    expect(calls).toEqual(['nxis_get', 'nxis_get']);
    expect(completions).toBe(2);
  });
});
