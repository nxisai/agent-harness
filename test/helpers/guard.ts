/**
 * A scripted turn for the guardrails' tests: a provider that answers from a list and records every request it was
 * sent (after the guardrails rendered it), a tool source that records every call, and a renderer that records what
 * was said and what was put up for confirmation.
 */
import { AgentHarness, type HarnessOptions } from '../../src/harness/harness';
import type { Completion, CompletionRequest } from '../../src/providers/types';
import type { ChatMessage, ModelContextToolInfo, ModelContextToolResponse } from '../../src/types';
import type { ConfirmRequest, AskRequest } from '../../src/harness/renderer';

export type Reply = Completion | ((req: CompletionRequest) => Completion | Promise<Completion>);

export interface Scripted {
  harness: AgentHarness;
  /** Each request the provider was sent, as the guardrails rendered it. */
  requests: CompletionRequest[];
  /** What the visitor was told, in order: messages, finalized bubbles and tool errors. */
  said: string[];
  /** Confirmations put up, in order. */
  confirms: ConfirmRequest[];
  /** Asks put up, in order. */
  asks: AskRequest[];
  /** Tool calls that ran, by name, with their arguments. */
  calls: { name: string; args: Record<string, unknown> }[];
  messages: ChatMessage[];
  /** Run a turn on the shared transcript. */
  turn(goal: string): ReturnType<AgentHarness['turn']>;
}

export function scripted(opts: {
  tools: ModelContextToolInfo[];
  replies: Reply[];
  exec?: (name: string, args: Record<string, unknown>) => ModelContextToolResponse | Promise<ModelContextToolResponse>;
  harness?: Partial<HarnessOptions>;
  messages?: ChatMessage[];
}): Scripted {
  const requests: CompletionRequest[] = [];
  const said: string[] = [];
  const confirms: ConfirmRequest[] = [];
  const asks: AskRequest[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const messages = opts.messages ?? [{ role: 'system', content: 'You help on this site.' }];
  let n = 0;
  const provider = {
    name: 'scripted',
    local: false,
    ready: true,
    loading: false,
    async complete(req: CompletionRequest): Promise<Completion> {
      requests.push(req);
      const r = opts.replies[Math.min(n++, opts.replies.length - 1)] ?? { text: '' };
      return typeof r === 'function' ? r(req) : r;
    },
  };
  const bubble = { thinking() {}, update() {}, finalize: (t: string) => void (t && said.push(t)) };
  const renderer = {
    streaming: () => bubble,
    message: (_r: string, t: string) => void said.push(t),
    status() {},
    results() {},
    detail() {},
    toolError: (_t: unknown, m: string) => void said.push(m),
    ask: (r: AskRequest) => void asks.push(r),
    confirm: (r: ConfirmRequest) => void confirms.push(r),
  };
  const toolSource = {
    discoverTools: async () => opts.tools,
    modelContext: () => null,
    execTool: async (_t: unknown, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return opts.exec ? opts.exec(name, args) : { content: [{ type: 'text', text: 'Done.' }] };
    },
  };
  const harness = new AgentHarness({ provider, toolSource, renderer, recommend: false, ...opts.harness } as never);
  return {
    harness,
    requests,
    said,
    confirms,
    asks,
    calls,
    messages,
    turn: (goal) => harness.turn(goal, messages),
  };
}

/** Let pending promises (a confirmed run) settle. */
export const settle = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
