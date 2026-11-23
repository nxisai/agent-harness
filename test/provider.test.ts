/**
 * The provider seam.
 *
 * These run a real turn with a canned provider, which was impossible before the
 * split: `turn()` needed an engine, and an engine needed WebGPU and a
 * multi-gigabyte download. A fake that returns `{ text, call }` is now the
 * whole dependency.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentHarness } from '../src/index';
import type { Completion, CompletionRequest, ModelProvider } from '../src/index';

/** A provider that says whatever the test tells it to. */
function fakeProvider(replies: Completion[]): ModelProvider & { seen: CompletionRequest[] } {
  const seen: CompletionRequest[] = [];
  let i = 0;
  return {
    name: 'fake',
    local: false,
    ready: true,
    loading: false,
    seen,
    async complete(req) {
      seen.push(req);
      return replies[Math.min(i++, replies.length - 1)];
    },
  };
}

const recorder = () => {
  const said: string[] = [];
  const bubble = { thinking() {}, update() {}, finalize: (t: string) => t && said.push(t) };
  return {
    said,
    renderer: {
      streaming: () => bubble,
      message: (_r: string, t: string) => said.push(t),
      status() {},
      results() {},
      detail() {},
      toolError() {},
      dismissPrompt() {},
    } as never,
  };
};

const READ_TOOL = {
  name: 'nxis_query',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

describe('a turn, with no model', () => {
  it('renders what the provider said', async () => {
    const provider = fakeProvider([{ text: 'We open at seven.' }]);
    const { said, renderer } = recorder();
    const harness = new AgentHarness({
      provider,
      renderer,
      toolSource: { discoverTools: async () => [READ_TOOL] } as never,
    });

    const result = await harness.turn('what are your hours', []);
    expect(said).toContain('We open at seven.');
    expect(result.decision).toBe('none');
  });

  it('acts on a structured call without any text to parse', async () => {
    // The point of the seam: this provider never emitted a marker, and the
    // harness never looked for one.
    const execTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"results":[]}' }] }));
    const provider = fakeProvider([{ text: '', call: { name: 'nxis_query', args: { text: 'plumbers' } } }]);
    const { renderer } = recorder();
    const harness = new AgentHarness({
      provider,
      renderer,
      toolSource: { discoverTools: async () => [READ_TOOL], execTool } as never,
    });

    await harness.turn('find plumbers', []);
    expect(execTool).toHaveBeenCalledTimes(1);
    expect(execTool.mock.calls[0][2]).toMatchObject({ text: 'plumbers' });
  });

  it('writes a line when the provider returned only a call', async () => {
    const provider = fakeProvider([{ text: '', call: { name: 'nxis_query', args: {} } }]);
    const { said, renderer } = recorder();
    const harness = new AgentHarness({
      provider,
      renderer,
      toolSource: {
        discoverTools: async () => [READ_TOOL],
        execTool: async () => ({ content: [] }),
      } as never,
    });

    await harness.turn('find plumbers', []);
    expect(said[0]).toBe('Looking that up.');
  });

  it('keeps the call in the transcript so the model remembers asking', async () => {
    // A structured call has no text form, so one is written for the model's own
    // memory. Without it the model asks for the same tool again next turn.
    const provider = fakeProvider([{ text: 'One moment.', call: { name: 'nxis_query', args: { text: 'x' } } }]);
    const { renderer } = recorder();
    const harness = new AgentHarness({
      provider,
      renderer,
      toolSource: {
        discoverTools: async () => [READ_TOOL],
        execTool: async () => ({ content: [] }),
      } as never,
    });

    const messages: { role: string; content: string }[] = [];
    await harness.turn('find plumbers', messages as never);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toContain('One moment.');
    expect(assistant?.content).toContain('nxis_query');
  });

  it('tells the provider what is stable, and what stopped being stable', async () => {
    const provider = fakeProvider([{ text: 'ok' }, { text: 'ok' }, { text: 'ok' }]);
    const { renderer } = recorder();
    const harness = new AgentHarness({
      provider,
      renderer,
      systemPrompt: 'You are A.',
      toolSource: { discoverTools: async () => [READ_TOOL] } as never,
    });

    const messages: never[] = [];
    await harness.turn('one', messages);
    await harness.turn('two', messages);

    // First request has nothing to compare against; the second repeats both.
    expect(provider.seen[0].cache).toEqual({ stableMessages: 0, toolsStable: false });
    expect(provider.seen[1].cache).toEqual({ stableMessages: 1, toolsStable: true });
  });

  it('marks the prefix unstable when the agent changes', async () => {
    // A handoff swaps the system message and the tool slice, which is exactly
    // when a cached prefix must not be reused.
    const provider = fakeProvider([{ text: 'ok' }, { text: 'ok' }]);
    const { renderer } = recorder();
    const toolSource = { discoverTools: async () => [READ_TOOL] } as never;
    const messages: never[] = [];

    const a = new AgentHarness({ provider, renderer, systemPrompt: 'You are A.', toolSource });
    await a.turn('one', messages);
    await a.turn('two', messages);
    expect(provider.seen[1].cache).toMatchObject({ stableMessages: 1 });

    const b = new AgentHarness({ provider, renderer, systemPrompt: 'You are B.', toolSource });
    await b.turn('three', messages);
    expect(provider.seen[2].cache).toMatchObject({ stableMessages: 0 });
  });

  it('passes an abort signal, and stop() fires it', async () => {
    const provider = fakeProvider([{ text: 'ok' }]);
    const { renderer } = recorder();
    const harness = new AgentHarness({
      provider,
      renderer,
      toolSource: { discoverTools: async () => [READ_TOOL] } as never,
    });

    await harness.turn('hello', []);
    const signal = provider.seen[0].signal;
    expect(signal?.aborted).toBe(false);
    harness.stop();
    expect(signal?.aborted).toBe(true);
  });
});
