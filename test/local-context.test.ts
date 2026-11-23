/**
 * The fallback registry against the WebMCP spec.
 *
 * The full conformance suite lives with `@nxisai/webmcp` (`npm run
 * conformance`), which runs this registry too. These are the behaviours the
 * harness leans on, and the path a result takes from a tool to the thread.
 */
import { describe, expect, it } from 'vitest';
import { LocalModelContext } from '../src/harness/tools/local-context';
import { asResponse, executeRegistered } from '../src/harness/tools/webmcp';
import type { ModelContextTool, ModelContextToolInfo } from '../src/types';

const tool = (over: Partial<ModelContextTool> = {}): ModelContextTool => ({
  name: 'page_links',
  description: 'Where this page leads',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text', text: 'You are on the home page.' }] }),
  ...over,
});

async function registered(mc: LocalModelContext, name = 'page_links'): Promise<ModelContextToolInfo> {
  return (await mc.getTools()).find((t) => t.name === name)!;
}

describe('registering', () => {
  it('rejects, never throws: a duplicate, a bad name or an empty description is an InvalidStateError', async () => {
    const mc = new LocalModelContext();
    await mc.registerTool(tool());
    for (const bad of [tool(), tool({ name: 'has space' }), tool({ name: 'x'.repeat(129) }), tool({ name: 'ok', description: '' })]) {
      let returned: unknown;
      expect(() => (returned = mc.registerTool(bad))).not.toThrow();
      await expect(returned).rejects.toMatchObject({ name: 'InvalidStateError' });
    }
  });

  it('rejects a tool missing a required member, or with a schema that is not an object, as a TypeError', async () => {
    const mc = new LocalModelContext();
    for (const bad of [{ name: 'a', description: 'd' }, { name: 'a', execute: async () => 1 }, tool({ inputSchema: '{}' as never })]) {
      await expect(mc.registerTool(bad as ModelContextTool)).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('resolves after toolchange', async () => {
    const mc = new LocalModelContext();
    const order: string[] = [];
    mc.addEventListener('toolchange', () => order.push('toolchange'));
    await mc.registerTool(tool()).then(() => order.push('resolved'));
    expect(order).toEqual(['toolchange', 'resolved']);
  });
});

describe('listing', () => {
  it('sorts by name and reports the spec’s four hints, dropping the rest', async () => {
    const mc = new LocalModelContext();
    await mc.registerTool(tool({ name: 'open_page', annotations: { readOnlyHint: true, 'ai.nxis/actionId': 'urn:x' } }));
    await mc.registerTool(tool());
    const tools = await mc.getTools();
    expect(tools.map((t) => t.name)).toEqual(['open_page', 'page_links']);
    expect(tools[0].annotations).toEqual({
      consequentialHint: false,
      debugging: false,
      readOnlyHint: true,
      untrustedContentHint: false,
    });
    expect(tools[0]).toMatchObject({ title: '', origin: 'http://localhost' });
    expect(tools[1]).not.toHaveProperty('annotations');
  });
});

describe('executing', () => {
  it('requires an input object, and resolves with the result as JSON — text quoted', async () => {
    const mc = new LocalModelContext();
    await mc.registerTool(tool({ name: 'say', execute: async () => 'Done.' }));
    const say = await registered(mc, 'say');
    await expect(mc.executeTool(say)).rejects.toBeInstanceOf(TypeError);
    await expect(mc.executeTool(say, {})).resolves.toBe('"Done."');
  });

  it('rejects with UnknownError for a tool that throws or returns nothing JSON can hold', async () => {
    const mc = new LocalModelContext();
    await mc.registerTool(tool({ name: 'boom', execute: async () => { throw new Error('x'); } }));
    await mc.registerTool(tool({ name: 'nothing', execute: async () => undefined as never }));
    await expect(mc.executeTool(await registered(mc, 'boom'), {})).rejects.toMatchObject({ name: 'UnknownError' });
    await expect(mc.executeTool(await registered(mc, 'nothing'), {})).rejects.toMatchObject({ name: 'UnknownError' });
  });

  it('fires toolactivated, and on abort toolcancel, with the signal the tool was given', async () => {
    const mc = new LocalModelContext();
    let signal: AbortSignal | undefined;
    await mc.registerTool(tool({ name: 'slow', execute: (_i, o) => new Promise(() => void (signal = (o as { signal: AbortSignal }).signal)) }));
    const events: string[] = [];
    for (const type of ['toolactivated', 'toolcancel']) {
      mc.addEventListener(type, (e) => events.push(`${type} ${(e as Event & { toolName: string }).toolName}`));
    }
    const controller = new AbortController();
    const running = mc.executeTool(await registered(mc, 'slow'), {}, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort('stop');
    await expect(running).rejects.toBe('stop');
    await new Promise((r) => setTimeout(r, 5));
    expect(signal?.aborted).toBe(true);
    expect(events).toEqual(['toolactivated slow', 'toolcancel slow']);
  });
});

describe('from a tool to the thread', () => {
  it('comes back as the response the tool returned, through executeRegistered', async () => {
    const mc = new LocalModelContext();
    await mc.registerTool(tool());
    const res = await executeRegistered(mc, await registered(mc), 'page_links', {});
    expect(res).toEqual({ content: [{ type: 'text', text: 'You are on the home page.' }] });
  });

  it('keeps isError and structuredContent', async () => {
    const mc = new LocalModelContext();
    const response = { isError: true, content: [{ type: 'text', text: 'No.' }], structuredContent: { a: 1 } };
    await mc.registerTool(tool({ execute: async () => response }));
    expect(await executeRegistered(mc, await registered(mc), 'page_links', {})).toEqual(response);
  });

  it('reads a tool that returned text as that text, unquoted', async () => {
    const mc = new LocalModelContext();
    await mc.registerTool(tool({ execute: async () => 'Opening the home page…' as never }));
    const raw = await mc.executeTool(await registered(mc), {});
    expect(asResponse(raw)).toEqual({ content: [{ type: 'text', text: 'Opening the home page…' }] });
  });
});
