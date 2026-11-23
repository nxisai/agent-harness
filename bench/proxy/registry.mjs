/**
 * Which models this proxy will talk to, and under what name.
 *
 * The browser names a model by a short id in `X-Nxis-Model`. That id is looked
 * up here and nothing else about the request can influence where the call goes:
 * an allowlist rather than a mapping, so a forged header cannot point the
 * container at a host of the caller's choosing. Adding a model is an edit to
 * this file and a restart, which is the intended friction — a bench whose model
 * set can change without a deploy cannot say what it measured.
 *
 * `display` is what the visitor reads beside the input, because the harness
 * shows whatever the endpoint reports as `model`. It is therefore also the
 * label in the bench report, which is why it carries the version: "Claude
 * Sonnet 5.5" and not "Claude".
 *
 * @module
 */

/**
 * Per-model configuration.
 *
 * `lane` records how the model is reached, which the report groups by:
 * `B` is served from a container on this machine, `C` from a vendor over the
 * network. Lane A — the on-device Gemma — never reaches this proxy at all, so
 * it has no entry here.
 *
 * @typedef {object} ModelEntry
 * @property {'B'|'C'} lane
 * @property {'anthropic'|'openai'|'google'|'ollama'} vendor
 * @property {string} model      The vendor's own model id.
 * @property {string} display    The name a visitor should read.
 * @property {string} [base]     Base URL, for a self-hosted backend.
 * @property {string} [keyRef]   Env var holding the credential. Never the value.
 * @property {string} [effort]   Anthropic effort level, where the model takes one.
 * @property {boolean} [think]  Let an Ollama reasoning model think aloud first. Off by default.
 * @property {number} [inputPerMTok]  USD per million input tokens, for the cost column.
 * @property {number} [outputPerMTok] USD per million output tokens.
 */

/** @type {Record<string, ModelEntry>} */
export const MODELS = {
  // Lane B — containerised, no vendor spend. Pull these with
  // `docker compose exec ollama ollama pull <model>` before a run.
  'gemma-local': {
    lane: 'B',
    vendor: 'ollama',
    model: 'gemma3:4b',
    base: 'http://ollama:11434',
    display: 'Gemma 3 4B (local)',
  },
  // The same Gemma 4 E2B the site runs in the browser (lane A), served here
  // instead, so the two lanes can be compared model for model.
  'gemma4-local': {
    lane: 'B',
    vendor: 'ollama',
    model: 'gemma4:e2b',
    base: 'http://ollama:11434',
    display: 'Gemma 4 E2B (local)',
  },
  'qwen-local': {
    lane: 'B',
    vendor: 'ollama',
    model: 'qwen3:8b',
    base: 'http://ollama:11434',
    display: 'Qwen3 8B (local)',
  },

  // Lane C — vendor APIs. Prices are for the cost column only; they are not
  // enforced anywhere, so a stale figure misreports cost without failing.
  'claude-sonnet': {
    lane: 'C',
    vendor: 'anthropic',
    model: 'claude-sonnet-5-5',
    display: 'Claude Sonnet 5.5',
    keyRef: 'ANTHROPIC_API_KEY',
    // Chat-shaped turns; the effort sweep belongs in a separate run, not mixed
    // into a model comparison where it would confound the latency column.
    effort: 'low',
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
  },
  'claude-haiku': {
    lane: 'C',
    vendor: 'anthropic',
    model: 'claude-haiku-5-5',
    display: 'Claude Haiku 5.5',
    keyRef: 'ANTHROPIC_API_KEY',
    effort: 'low',
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
  },
  // The vendor ids below are deliberately left for whoever runs the bench to
  // confirm against the vendor's own current model list. A wrong id fails loudly
  // on the first request rather than silently measuring the wrong model.
  gpt: {
    lane: 'C',
    vendor: 'openai',
    model: process.env.OPENAI_MODEL ?? '',
    display: process.env.OPENAI_DISPLAY ?? 'GPT (set OPENAI_MODEL)',
    keyRef: 'OPENAI_API_KEY',
  },
  gemini: {
    lane: 'C',
    vendor: 'google',
    model: process.env.GOOGLE_MODEL ?? '',
    display: process.env.GOOGLE_DISPLAY ?? 'Gemini (set GOOGLE_MODEL)',
    keyRef: 'GOOGLE_API_KEY',
  },
};

/** The id used when the caller names none. */
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? 'claude-sonnet';

/**
 * Resolve a model id to its entry.
 *
 * @param {string | null | undefined} id - The `X-Nxis-Model` header value.
 * @returns {{ id: string, entry: ModelEntry } | { error: string }}
 */
export function resolve(id) {
  const wanted = (id ?? '').trim() || DEFAULT_MODEL;
  const entry = Object.prototype.hasOwnProperty.call(MODELS, wanted)
    ? MODELS[wanted]
    : undefined;
  if (!entry) {
    // Naming the allowed ids is safe — they are not secrets, and a bench run
    // that mistypes one should say so immediately.
    return { error: `Unknown model "${wanted}". Known: ${Object.keys(MODELS).join(', ')}.` };
  }
  if (!entry.model) {
    return { error: `Model "${wanted}" has no vendor model id configured.` };
  }
  if (entry.keyRef && !process.env[entry.keyRef]) {
    return { error: `Model "${wanted}" needs ${entry.keyRef}, which is not set.` };
  }
  return { id: wanted, entry };
}
