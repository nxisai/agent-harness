/**
 * A turn whose tool call is already decided.
 *
 * A handoff from the NxisAI app names one business's form. Left to choose, a
 * model sometimes asks for the details in prose instead of opening it; this
 * path never asks the model, and what follows is an ordinary turn's.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentHarness } from '../src/index';
import type { ModelContextToolInfo } from '../src/types';

const quoteForm = {
  name: 'quote_form_anywhere',
  inputSchema: {
    type: 'object',
    properties: {
      business: { type: 'string', enum: ['McManus Electric', 'Sparkwise Electrical'] },
      full_name: { type: 'string' },
      email: { type: 'string' },
    },
    required: ['business', 'full_name', 'email'],
  },
} as unknown as ModelContextToolInfo;

function setup(tools: ModelContextToolInfo[] = [quoteForm]) {
  const asked: { tool: string; values: Record<string, unknown> }[] = [];
  const renderer = {
    streaming: () => ({ thinking() {}, update() {}, finalize() {} }),
    message() {},
    status() {},
    ask: (req: { tool: ModelContextToolInfo; resolution: { values: Record<string, unknown> } }) =>
      asked.push({ tool: req.tool.name, values: req.resolution.values }),
    confirm() {},
  };
  const complete = vi.fn(async () => ({ text: 'Could you provide your name and email?' }));
  const provider = { ready: true, load: async () => {}, complete };
  const toolSource = { discoverTools: async () => tools, execTool: vi.fn() };
  const harness = new AgentHarness({ provider, toolSource, renderer } as never);
  return { harness, asked, complete, toolSource };
}

describe('beginning a turn with a known call', () => {
  it('opens the form for that business without asking the model', async () => {
    const { harness, asked, complete, toolSource } = setup();
    const messages: { role: string; content: string }[] = [];
    const result = await harness.begin(
      'Get a quote from McManus Electric',
      'quote_form_anywhere',
      { business: 'McManus Electric' },
      messages as never,
    );

    expect(complete).not.toHaveBeenCalled();
    expect(result.decision).toBe('ask');
    expect(asked).toEqual([{ tool: 'quote_form_anywhere', values: { business: 'McManus Electric' } }]);
    expect(toolSource.execTool).not.toHaveBeenCalled();
    // The transcript reads as if the model had made the call, so the next turn continues from it.
    const said = messages.filter((m) => m.role !== 'system');
    expect(said.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(said[1].content).toMatch(/\[called quote_form_anywhere with \{"business":"McManus Electric"\}\]/);
  });

  it('says so when this agent has no such tool, and leaves the transcript alone', async () => {
    const { harness, complete } = setup([]);
    const messages: unknown[] = [];
    const result = await harness.begin('Get a quote', 'quote_form_anywhere', {}, messages as never);
    expect(result.decision).toBe('unavailable');
    expect(complete).not.toHaveBeenCalled();
    expect(messages.filter((m) => (m as { role: string }).role !== 'system')).toEqual([]);
  });
});
