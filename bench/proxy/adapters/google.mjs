/**
 * A Gemini model through the Generative Language API.
 *
 * The shape differs more than the others: turns are `contents` with `parts`,
 * the assistant role is `model`, the system prompt is `systemInstruction`, and
 * a tool call arrives as a `functionCall` part rather than its own block.
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
/** The schema keywords Gemini's function declarations accept. Anything else is refused outright. */
const GEMINI_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'default', 'example',
  'properties', 'required', 'items', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'anyOf', 'propertyOrdering',
]);

/**
 * A tool's input schema in the subset Gemini accepts.
 *
 * The other vendors ignore keywords they do not know; Gemini rejects the whole
 * request ("Unknown name nxis:valueLabels"), and a site's form tools carry
 * NxisAI's own keywords. Unknown keys are dropped, recursively; enum values
 * become strings, which is all Gemini allows; `required` keeps only
 * properties that exist.
 *
 * @param {any} schema
 * @returns {any}
 */
export function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, geminiSchema(s)]));
    } else if (k === 'items' || k === 'anyOf') {
      out[k] = geminiSchema(v);
    } else if (k === 'enum' && Array.isArray(v)) {
      out.enum = v.map(String);
    } else {
      out[k] = v;
    }
  }
  if (Array.isArray(out.required) && out.properties) {
    out.required = out.required.filter((name) => name in out.properties);
    if (!out.required.length) delete out.required;
  }
  return out;
}

export async function complete({ messages, tools, maxTokens, entry, signal }) {
  const base = entry.base ?? 'https://generativelanguage.googleapis.com/v1beta';
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const contents = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const res = await fetch(
    `${base}/models/${encodeURIComponent(entry.model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The key goes in a header, never the query string: a URL ends up in
        // logs and proxy traces.
        'x-goog-api-key': process.env[entry.keyRef],
      },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: maxTokens },
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    description: t.description ?? '',
                    parameters: geminiSchema(t.inputSchema ?? { type: 'object', properties: {} }),
                  })),
                },
              ],
            }
          : {}),
      }),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    throw new Error(`google ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const out = await res.json();
  const parts = out.candidates?.[0]?.content?.parts ?? [];
  const fn = parts.find((p) => p.functionCall)?.functionCall;

  return {
    text: parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim(),
    ...(fn ? { call: { name: fn.name ?? '', args: fn.args ?? {} } } : {}),
    usage: {
      promptTokens: out.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: out.usageMetadata?.candidatesTokenCount ?? 0,
    },
    model: entry.display,
    meta: { finishReason: out.candidates?.[0]?.finishReason ?? null },
  };
}
