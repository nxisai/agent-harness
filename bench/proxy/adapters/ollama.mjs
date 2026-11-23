/**
 * A model served by Ollama on this machine.
 *
 * This is lane B: the same contract and the same proxy path as a vendor, with
 * no network egress and no spend. Its purpose in the bench is to make the
 * on-device tier comparable to a frontier model under one code path, and to let
 * the whole rig be exercised before anyone's budget is involved.
 *
 * Ollama's /api/chat speaks an OpenAI-shaped tool protocol, so the translation
 * here is small.
 *
 * @module
 */

/**
 * @param {object} args
 * @param {import('../types.mjs').WireMessage[]} args.messages
 * @param {import('../types.mjs').WireTool[]} args.tools
 * @param {number} args.maxTokens
 * @param {import('../registry.mjs').ModelEntry} args.entry
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<import('../types.mjs').Completion>}
 */
export async function complete({ messages, tools, maxTokens, entry, signal }) {
  const body = {
    model: entry.model,
    // Ollama keeps the system prompt as a turn, so the messages pass straight
    // through.
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    // Off unless the entry asks for it: the harness shows a reply's text to the
    // visitor verbatim, so a reasoning model's <think> block would reach them,
    // and it is most of a turn's latency besides.
    think: entry.think ?? false,
    options: { num_predict: maxTokens },
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description ?? '',
              parameters: t.inputSchema ?? { type: 'object', properties: {} },
            },
          })),
        }
      : {}),
  };

  const res = await fetch(`${entry.base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const out = await res.json();

  const call = out.message?.tool_calls?.[0];
  return {
    text: (out.message?.content ?? '').trim(),
    ...(call
      ? {
          call: {
            name: call.function?.name ?? '',
            // Ollama returns arguments already parsed, but older builds send a
            // JSON string. Both appear in the wild.
            args: typeof call.function?.arguments === 'string'
              ? safeParse(call.function.arguments)
              : (call.function?.arguments ?? {}),
          },
        }
      : {}),
    usage: {
      promptTokens: out.prompt_eval_count ?? 0,
      outputTokens: out.eval_count ?? 0,
    },
    model: entry.display,
    meta: { doneReason: out.done_reason ?? null },
  };
}

/** @param {string} raw */
function safeParse(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
