/**
 * Chrome's native `document.modelContext`, as measured, not as assumed.
 *
 * Every shape here was taken from a live page in Chrome Beta with WebMCP
 * enabled. The polyfill accepts anything and returns what the tool returned,
 * which is why tests written against it passed while the native runtime showed
 * the visitor an empty "No results found." under a correct answer.
 */
import { describe, expect, it, vi } from 'vitest';
import { executeRegistered } from '../src/harness/tools/webmcp';
import { extractResult, proseAnswer } from '../src/harness/tools/schema';
import type { ModelContext, ModelContextToolInfo } from '../src/types';

const ANSWER =
  'You are on Royal Oak Contractors (/), one of 39 pages on this site. This site publishes no sections, so there is nothing above or beside it.';

/** What the native registry returns: the whole response, serialized. */
const NATIVE_RESPONSE = JSON.stringify({ content: [{ type: 'text', text: ANSWER }] });

/** Its exact refusals. */
const NOT_AN_OBJECT = "Failed to execute 'executeTool' on 'ModelContext': invalid input object: value is not an object";
const NOT_A_TOOL = "Failed to execute 'executeTool' on 'ModelContext': The provided value is not of type 'RegisteredTool'.";

const tool = { name: 'page_links', inputSchema: { type: 'object', properties: {} } } as ModelContextToolInfo;

/** A registry that behaves as current native Chrome does. */
function nativeRegistry() {
  const executeTool = vi.fn(async (t: unknown, input: unknown) => {
    if (typeof t === 'string') throw new TypeError(NOT_A_TOOL);
    if (typeof input !== 'object' || input === null) throw new TypeError(NOT_AN_OBJECT);
    return NATIVE_RESPONSE;
  });
  return { mc: { executeTool } as unknown as ModelContext, executeTool };
}

describe('what a native registry returns', () => {
  it('is unwrapped to the answer, for the trace and for the thread alike', () => {
    expect(extractResult(NATIVE_RESPONSE as never)).toBe(ANSWER);
    // The bug: prose was judged on the raw string, which parses as JSON and read as records.
    expect(proseAnswer(NATIVE_RESPONSE)).toBe(ANSWER);
  });

  it('still leaves real records to the cards, serialized the same way', () => {
    const records = JSON.stringify({ content: [{ type: 'text', text: '{"results":[],"total":0}' }] });
    expect(proseAnswer(records)).toBe('');
  });
});

describe('what a tool reported, through a registry that serializes it', () => {
  it('keeps isError, so a refusal is not shown as a success', async () => {
    const { asResponse } = await import('../src/harness/tools/webmcp');
    const refused = JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Email looks wrong.' }] });
    expect(asResponse(refused)).toMatchObject({ isError: true });
  });

  it('keeps structuredContent, which is how a handoff says where it went', async () => {
    const { asResponse } = await import('../src/harness/tools/webmcp');
    const handoff = JSON.stringify({ content: [], structuredContent: { 'ai.nxis/handoff': { pageUrl: '/x' } } });
    expect(asResponse(handoff).structuredContent).toEqual({ 'ai.nxis/handoff': { pageUrl: '/x' } });
  });

  it('reads plain text, a number, and nothing, as Chrome returns them', async () => {
    const { asResponse } = await import('../src/harness/tools/webmcp');
    expect(asResponse('plain string result')).toEqual({ content: [{ type: 'text', text: 'plain string result' }] });
    expect(asResponse('42')).toEqual({ content: [{ type: 'text', text: '42' }] });
    expect(asResponse('undefined')).toEqual({ content: [] });
    expect(asResponse('{not a response')).toEqual({ content: [{ type: 'text', text: '{not a response' }] });
  });

  it('reads text as the spec returns it, JSON-quoted', async () => {
    const { asResponse } = await import('../src/harness/tools/webmcp');
    expect(asResponse('"Opening the home page…"')).toEqual({ content: [{ type: 'text', text: 'Opening the home page…' }] });
    expect(asResponse('""')).toEqual({ content: [] });
  });
});

describe('calling a tool on a native registry', () => {
  it('passes the tool object and an arguments object — the only form it accepts', async () => {
    const { mc, executeTool } = nativeRegistry();
    const res = await executeRegistered(mc, tool, 'page_links', { page: 'home' });
    // Parsed back into the object the tool produced, whichever runtime answered.
    expect(res).toEqual({ content: [{ type: 'text', text: ANSWER }] });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(tool, { page: 'home' });
  });

  it('falls back to a JSON string for Chrome 153, which refuses an object before running anything', async () => {
    // Measured on Chrome 153.0.8010.53: an object input is refused with this, and the tool never runs.
    let ran = 0;
    const chrome153 = vi.fn(async (_t: unknown, input: unknown) => {
      if (typeof input !== 'string') {
        throw Object.assign(new Error('Failed to parse input arguments'), { name: 'UnknownError' });
      }
      ran++;
      return NATIVE_RESPONSE;
    });
    const res = await executeRegistered({ executeTool: chrome153 } as unknown as ModelContext, tool, 'page_links', {});
    expect(proseAnswer(res)).toBe(ANSWER);
    expect(ran).toBe(1);
    expect(chrome153).toHaveBeenLastCalledWith(tool, '{}');
  });

  it('never retries a tool that ran and threw, whatever the runtime', async () => {
    const threw = vi.fn(async () => {
      throw Object.assign(
        new Error('Tool was executed but the invocation failed. For example, the script function threw an error'),
        { name: 'UnknownError' },
      );
    });
    await expect(executeRegistered({ executeTool: threw } as unknown as ModelContext, tool, 'page_links', {})).rejects.toThrow(
      /was executed/,
    );
    expect(threw).toHaveBeenCalledTimes(1);
  });

  it('falls back to a JSON string for a runtime that wants one', async () => {
    const older = vi.fn(async (_t: unknown, input: unknown) => {
      if (typeof input !== 'string') throw new TypeError("parameter 2 is not of type 'DOMString'");
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const res = await executeRegistered({ executeTool: older } as unknown as ModelContext, tool, 'page_links', {});
    expect(extractResult(res)).toBe('ok');
    expect(older).toHaveBeenLastCalledWith(tool, '{}');
  });

  it('reports a tool that ran and failed, without trying it again in another form', async () => {
    const failing = vi.fn(async () => {
      throw new Error('The quote form rejected the email address.');
    });
    await expect(
      executeRegistered({ executeTool: failing } as unknown as ModelContext, tool, 'page_links', {}),
    ).rejects.toThrow('rejected the email');
    // It may already have submitted something; a second form of the same call could submit twice.
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('with no tool object, calls by name, as the polyfill allows', async () => {
    const byName = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    await executeRegistered({ executeTool: byName } as unknown as ModelContext, null, 'page_links', { a: 1 });
    expect(byName).toHaveBeenCalledWith('page_links', { a: 1 });
  });
});
