/**
 * Claude, through the official SDK.
 *
 * Calls Claude the way a site's own model endpoint does, so a bench result for
 * Claude describes the code path a real visitor gets rather than a bench-only
 * reimplementation.
 *
 * @module
 */
import Anthropic from '@anthropic-ai/sdk';

/** One client per process; constructing it per request leaks sockets. */
let client;

/**
 * Ask Claude for the next turn.
 *
 * @param {object} args
 * @param {import('../types.mjs').WireMessage[]} args.messages
 * @param {import('../types.mjs').WireTool[]} args.tools
 * @param {number} args.maxTokens
 * @param {import('../registry.mjs').ModelEntry} args.entry
 * @param {{ stableMessages?: number, toolsStable?: boolean }} [args.cache]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<import('../types.mjs').Completion>}
 */
export async function complete({ messages, tools, maxTokens, entry, cache, signal }) {
  client ??= new Anthropic();

  // Claude takes the system prompt as its own field rather than a turn.
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const turns = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const defs = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

  // The harness's cache hint is advice, and this is the one adapter that can
  // act on it: a breakpoint on the tool list and on the stable message prefix
  // is what makes a repeated run cost a fraction of the first.
  const cacheable = (cache?.toolsStable ?? false) && defs.length > 0;
  if (cacheable) defs[defs.length - 1].cache_control = { type: 'ephemeral' };

  const reply = await client.messages.create(
    {
      model: entry.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      ...(defs.length ? { tools: defs } : {}),
      // Forced tool choice is rejected on this model family, and the bench
      // wants to measure whether the model elects to call a tool anyway.
      ...(entry.effort ? { output_config: { effort: entry.effort } } : {}),
      messages: turns,
    },
    signal ? { signal } : undefined,
  );

  const text = reply.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // At most one: the harness runs a single tool per turn, and returning more
  // has the rest discarded with a warning.
  const use = reply.content.find((b) => b.type === 'tool_use');

  return {
    text,
    ...(use ? { call: { name: use.name, args: use.input } } : {}),
    usage: {
      promptTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
    },
    model: entry.display,
    // Recorded rather than returned to the page: the bench reports whether the
    // cache hint was acted on, and a zero here across a repeat run means a
    // silent invalidator.
    meta: {
      stopReason: reply.stop_reason,
      cacheRead: reply.usage.cache_read_input_tokens ?? 0,
      cacheWrite: reply.usage.cache_creation_input_tokens ?? 0,
    },
  };
}
