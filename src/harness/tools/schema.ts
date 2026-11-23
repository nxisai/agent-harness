/**
 * Reading a tool's JSON Schema, and reconciling model output against it.
 *
 * Model-agnostic: these helpers work the same whichever provider produced the
 * arguments, so they sit with the harness rather than behind
 * {@link ModelProvider}.
 *
 * @module
 */
import type {
  JsonSchema,
  ModelContextToolInfo,
  ModelContextToolResponse,
} from '../../types.js';

/**
 * Read a tool's input schema, whichever key and form it arrives in.
 *
 * Accepts every alias on {@link ModelContextToolInfo}, parses a schema supplied
 * as a JSON string, merges in any required fields the page's own markup
 * declares, and gives every node a `type` so a chat template that formats types
 * cannot fail on an untyped one.
 *
 * @param tool - The tool as reported by discovery.
 * @returns The normalised schema, or an empty object when there is none.
 */
export function toolSchema(tool: ModelContextToolInfo): JsonSchema {
  let raw: JsonSchema | string | undefined =
    tool && (tool.inputSchema ?? tool.input_schema ?? tool.parameters ?? tool.schema);
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  const schema: JsonSchema = raw && typeof raw === 'object' ? raw : {};
  // The page's own markup is authoritative about what is required: a backend
  // schema may omit fields the rendered form still demands.
  const props = schema.properties ? Object.keys(schema.properties) : [];
  if (props.length) {
    const domReq = _domRequired(props);
    if (domReq.length) schema.required = [...new Set([...(schema.required || []), ...domReq])];
  }
  // Some schemas declare properties with no `type`. Gemma's tool chat template
  // applies `| upper` to each parameter type and throws on an undefined one, so
  // every node is given a type before prompt building.
  return _normalizeSchema(schema, true);
}

/**
 * Which of a tool's required fields have no usable value.
 *
 * @param tool - The tool whose schema declares the requirements.
 * @param args - The arguments so far.
 * @returns Required field names that are absent, null, or blank.
 */
/**
 * A read's answer when it is prose rather than records.
 *
 * Some reads answer in words — where the visitor is, that they are already on
 * the page they asked for — and a surface that can only draw record cards shows
 * an empty one reading "No results found." directly under the answer it was
 * given. This is how a surface tells the two apart.
 *
 * Empty when the answer parses as JSON, or says nothing: that is records a card
 * knows how to draw, or nothing worth putting in front of anyone. The envelope
 * a registry wraps a response in is never consulted — a native
 * `document.modelContext` attaches fields of its own to every response, and
 * judging by those is what put "No results found." under an answer in words.
 *
 * @param res - The tool response, or the text it was flattened to.
 * @returns The sentence to show, or an empty string to draw records instead.
 */
export function proseAnswer(res: ModelContextToolResponse | string | null): string {
  // Always through extractResult, strings included. Chrome's native registry returns the whole
  // response serialized — '{"content":[{"type":"text","text":"You are on …"}]}' — and read as-is that
  // parses as JSON and was taken for records, so the answer only ever reached the debug trace.
  const text = extractResult(res);
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  // Decided from the answer itself, never from the envelope around it. A registry attaches its own
  // fields — `structuredContent`, a wrapper, whatever the implementation adds — and judging by
  // those is how an answer in plain words ended up drawn as an empty result card.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return '';
  } catch {
    // Not records. Words.
  }
  return trimmed;
}

export function missingRequired(tool: ModelContextToolInfo, args: Record<string, unknown> | undefined): string[] {
  const required = toolSchema(tool).required || [];
  return required.filter((k) => {
    const v = args ? args[k] : undefined;
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
}

/**
 * Map a model's argument keys onto the schema's real property names.
 *
 * Models paraphrase field names. Keys are matched exactly first, then
 * case- and punctuation-insensitively, then by prefix, then by shared word.
 * Values matching an enum are snapped to the enum's own casing. A key with no
 * plausible match is passed through unchanged.
 *
 * @param args - The arguments the model supplied.
 * @param schema - The tool's normalised schema.
 * @returns The arguments rekeyed to schema property names.
 */
export function reconcileArgs(
  args: Record<string, unknown> | undefined,
  schema: JsonSchema,
): Record<string, unknown> {
  const props = schema && schema.properties ? Object.keys(schema.properties) : [];
  if (!props.length || !args) return args || {};
  const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const toks = (s: string) =>
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (props.includes(key)) {
      out[key] = _snapEnum(value, schema.properties![key]);
      continue;
    }
    const nk = norm(key);
    let best: string | undefined = props.find((p) => norm(p) === nk);
    if (!best) best = props.find((p) => nk.startsWith(norm(p)) || norm(p).startsWith(nk));
    if (!best) {
      const ktoks = new Set(toks(key));
      let bestScore = 0;
      for (const p of props) {
        const score = toks(p).filter((t) => ktoks.has(t)).length;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      if (bestScore === 0) best = undefined;
    }
    const targetKey = best || key;
    out[targetKey] = _snapEnum(value, schema.properties![targetKey]);
  }
  return out;
}

/**
 * Flatten a tool response to text.
 *
 * @param res - The response, a plain string, or nothing.
 * @returns The response's text blocks joined, or its JSON form when it carries
 * no text. Empty for a null or undefined response.
 */
export function extractResult(res: ModelContextToolResponse | string | null | undefined): string {
  if (res == null) return '';
  if (typeof res === 'string') return unwrapResponse(res);
  if (Array.isArray(res.content)) {
    return res.content
      .map((c) => unwrapResponse((c && c.text) || ''))
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(res);
  } catch {
    return String(res);
  }
}

// ── internals ───────────────────────────────────────────────────────────────

/**
 * A response the registry stringified rather than passed through.
 *
 * A tool may answer with a response object, and a registry is free to hand
 * that back as JSON in a single text block — which puts `{"content":[{"type":
 * "text"…` in front of the user where a sentence belongs. Only a shape that is
 * plainly a tool response is unwrapped; a tool whose own result happens to be
 * JSON keeps it.
 */
function unwrapResponse(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"content"')) return text;
  try {
    const parsed = JSON.parse(trimmed) as { content?: { text?: string }[] };
    if (!Array.isArray(parsed.content)) return text;
    const inner = parsed.content
      .map((c) => (c && c.text) || '')
      .filter(Boolean)
      .join('\n');
    return inner || text;
  } catch {
    return text;
  }
}

/**
 * Give every schema node a `type`, which the chat template requires.
 *
 * Nodes with properties become `object`, nodes with items become `array`, and
 * remaining leaves become `string`. Mutates and returns the schema.
 */
function _normalizeSchema(schema: JsonSchema, isRoot = false): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.properties && typeof schema.properties === 'object') {
    if (!schema.type) schema.type = 'object';
    for (const key of Object.keys(schema.properties)) _normalizeSchema(schema.properties[key]);
  }
  if (schema.items && typeof schema.items === 'object') {
    if (!schema.type) schema.type = 'array';
    _normalizeSchema(schema.items);
  }
  if (!schema.type) schema.type = isRoot ? 'object' : 'string';
  if (isRoot && schema.type === 'object' && !schema.properties) schema.properties = {};
  return schema;
}

/** Which of these property names the page's own markup marks required. */
function _domRequired(propNames: string[]): string[] {
  const out: string[] = [];
  for (const name of propNames) {
    let el: Element | null = null;
    try {
      el = document.querySelector(`[name="${CSS.escape(name)}"]`);
    } catch {
      // Not a usable selector.
    }
    if (el && ((el as HTMLInputElement).required || el.hasAttribute('data-required'))) out.push(name);
  }
  return out;
}

/** Correct a value's casing to match its schema's enum, when one matches. */
function _snapEnum(value: unknown, propSchema: JsonSchema | undefined): unknown {
  const enumVals = propSchema && (propSchema.enum || (propSchema.items && propSchema.items.enum));
  if (!enumVals || typeof value !== 'string' || enumVals.includes(value)) return value;
  const ci = enumVals.find((e) => String(e).toLowerCase() === value.toLowerCase());
  return ci !== undefined ? ci : value;
}
