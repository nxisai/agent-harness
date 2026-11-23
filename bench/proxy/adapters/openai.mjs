/**
 * An OpenAI chat-completions model.
 *
 * Plain `fetch` rather than the vendor SDK: this adapter needs three fields out
 * of the response and adding a dependency per vendor makes the container
 * heavier without making the translation clearer.
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
  const base = entry.base ?? 'https://api.openai.com/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env[entry.keyRef]}`,
    },
    body: JSON.stringify({
      model: entry.model,
      max_completion_tokens: maxTokens,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
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
    }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const out = await res.json();
  const choice = out.choices?.[0];
  const call = choice?.message?.tool_calls?.[0];

  return {
    text: (choice?.message?.content ?? '').trim(),
    ...(call
      ? { call: { name: call.function?.name ?? '', args: safeParse(call.function?.arguments) } }
      : {}),
    usage: {
      promptTokens: out.usage?.prompt_tokens ?? 0,
      outputTokens: out.usage?.completion_tokens ?? 0,
    },
    model: entry.display,
    meta: { finishReason: choice?.finish_reason ?? null },
  };
}

/** @param {unknown} raw - Arguments arrive as a JSON string on this API. */
function safeParse(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
