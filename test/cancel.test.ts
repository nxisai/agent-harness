/**
 * Stopping a turn.
 *
 * The provider here never resolves on its own: it settles only when the signal
 * it was handed fires. That is the whole point, because a provider that returns
 * quickly cannot tell a real cancellation from a race won by luck.
 */
import { describe, expect, it } from 'vitest';
import { AgentHarness, AgentCoordinator } from '../src/index';
import type { Completion, ModelProvider } from '../src/index';
import type { ChatMessage } from '../src/types';

/** Hangs until aborted, then rejects the way `fetch` does. */
function hangingProvider(): ModelProvider & { started: Promise<void> } {
  let begin!: () => void;
  const started = new Promise<void>((r) => (begin = r));
  return {
    name: 'hanging',
    local: false,
    ready: true,
    loading: false,
    started,
    complete({ signal }) {
      begin();
      return new Promise<Completion>((_res, rej) => {
        if (signal?.aborted) return rej(abortError());
        signal?.addEventListener('abort', () => rej(abortError()), { once: true });
      });
    },
  };
}

function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

const recorder = () => {
  const said: string[] = [];
  const stoppable: boolean[] = [];
  const bubble = { thinking() {}, update() {}, finalize: (t: string) => t && said.push(t) };
  return {
    said,
    stoppable,
    renderer: {
      streaming: () => bubble,
      message: (_r: string, t: string) => said.push(t),
      status() {},
      results() {},
      detail() {},
      toolError() {},
      dismissPrompt() {},
      stoppable: (can: boolean) => stoppable.push(can),
    } as never,
  };
};

const READ_TOOL = {
  name: 'nxis_query',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

const toolSource = { discoverTools: async () => [READ_TOOL] } as never;

describe('stopping a turn', () => {
  it('resolves as stopped rather than throwing the abort at the caller', async () => {
    const provider = hangingProvider();
    const { renderer } = recorder();
    const harness = new AgentHarness({ provider, renderer, toolSource });
    const messages: ChatMessage[] = [];

    const turn = harness.turn('what are your hours?', messages);
    await provider.started;
    harness.stop();

    await expect(turn).resolves.toEqual({ decision: 'stopped' });
  });

  it('keeps the question and leaves no answer behind', async () => {
    const provider = hangingProvider();
    const { said, renderer } = recorder();
    const harness = new AgentHarness({ provider, renderer, toolSource });
    const messages: ChatMessage[] = [];

    const turn = harness.turn('book me for Thursday', messages);
    await provider.started;
    harness.stop();
    await turn;

    // The half answer goes; a model that reads its own unfinished reply as
    // history will either continue from it or contradict it.
    expect(said).toEqual([]);
    expect(messages.filter((m) => m.role === 'assistant')).toEqual([]);
    // The question stays, so the thread and the transcript agree.
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'book me for Thursday',
    ]);
  });

  it('says when stopping is possible, and when it no longer is', async () => {
    const provider = hangingProvider();
    const { stoppable, renderer } = recorder();
    const harness = new AgentHarness({ provider, renderer, toolSource });

    const turn = harness.turn('anything', []);
    await provider.started;
    expect(stoppable[0]).toBe(true);
    harness.stop();
    await turn;
    expect(stoppable[stoppable.length - 1]).toBe(false);
  });

  it('leaves a later turn stoppable, rather than stopping it on arrival', async () => {
    const first = hangingProvider();
    const { renderer } = recorder();
    const harness = new AgentHarness({ provider: first, renderer, toolSource });

    const stopped = harness.turn('one', []);
    await first.started;
    harness.stop();
    await stopped;

    // The controller is per turn. Reused, the aborted signal from the stop
    // above would end every turn after it before the model was asked.
    const messages: ChatMessage[] = [];
    const answered = new AgentHarness({
      provider: { ...first, complete: async () => ({ text: 'Seven to five.' }) } as ModelProvider,
      renderer,
      toolSource,
    });
    await expect(answered.turn('two', messages)).resolves.toEqual({ decision: 'none' });
  });

  it('stops a turn that has not reached the model yet', async () => {
    // The regression this pins: stop() used to discard the AbortController as
    // well as aborting it, so a stop landing before the provider read the
    // signal left `stopped` reading false and the provider holding no signal.
    // Every other test here stops mid-generation, which took the working path.
    let asked = false;
    const provider: ModelProvider = {
      name: 'never-asked',
      local: false,
      ready: true,
      loading: false,
      async complete() {
        asked = true;
        return { text: 'should never be rendered' };
      },
    };
    const { said, renderer } = recorder();
    const harness = new AgentHarness({ provider, renderer, toolSource });

    const turn = harness.turn('anything', []);
    harness.stop();

    await expect(turn).resolves.toEqual({ decision: 'stopped' });
    // With the controller discarded, `stopped` read false, this check never
    // fired, and the turn ran on to render an answer nobody waited for.
    expect(asked).toBe(false);
    expect(said).toEqual([]);
  });

  it('does not claim a tool call was cancelled once it has started', async () => {
    let ran = false;
    const provider: ModelProvider = {
      name: 'caller',
      local: false,
      ready: true,
      loading: false,
      async complete() {
        return { text: '', call: { name: 'nxis_query', args: { text: 'hours' } } };
      },
    };
    const { renderer } = recorder();
    const stoppable: boolean[] = [];
    const harness = new AgentHarness({
      provider,
      renderer: {
        ...(renderer as object),
        // Stop the moment the harness says a tool is going out. The write is
        // already in flight: the honest outcome is that it completed, not that
        // it was called off.
        stoppable: (can: boolean) => {
          stoppable.push(can);
          if (!can && !ran) harness.stop();
        },
      } as never,
      toolSource: {
        discoverTools: async () => [READ_TOOL],
        execTool: async () => {
          ran = true;
          return { content: [{ type: 'text', text: '{"records":[]}' }] };
        },
      } as never,
    });

    const result = await harness.turn('hours?', []);
    expect(ran).toBe(true);
    expect(result.decision).not.toBe('stopped');
  });
});

describe('stopping a coordinated turn', () => {
  it('reaches the agent that took the turn', async () => {
    const provider = hangingProvider();
    const { renderer } = recorder();
    const agent = new AgentHarness({ provider, renderer, toolSource, name: 'retrieval' });
    const coordinator = new AgentCoordinator({
      agents: { retrieval: agent },
      rules: [],
      fallback: 'retrieval',
    });

    const messages: ChatMessage[] = [];
    const turn = coordinator.turn('what are your hours?', messages);
    await provider.started;
    coordinator.stop();

    await expect(turn).resolves.toEqual({ decision: 'stopped' });
  });
});
