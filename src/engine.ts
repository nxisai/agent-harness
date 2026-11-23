/**
 * The bundled model provider, plus the shared constants and helpers the UI
 * layer draws on.
 *
 * {@link LocalGemmaProvider} runs Gemma 4 (E2B) in the browser through
 * Transformers.js on WebGPU. The runtime is fetched from a CDN at first use
 * rather than bundled, so installing this package does not pull in a model
 * runtime, and the weights are cached by the browser after the first load.
 *
 * @module
 */
import type {
  ChatMessage,
  GenerationUsage,
  JsonSchema,
  ModelContextToolInfo,
  ParsedToolCall,
  PreloadMode,
  ProgressDetail,
  ToolDef,
} from './types.js';
import { toolSchema } from './harness/tools/schema.js';
import { assessLocalCapability, requestPersistentStorage } from './providers/capability.js';
import type {
  Completion,
  CompletionRequest,
  ModelProvider,
} from './providers/types.js';

// Re-exported so existing imports from './engine.js' keep working.
export type {
  ChatMessage,
  GenerationUsage,
  ParsedToolCall,
  PreloadMode,
  ProgressDetail,
  ToolDef,
};

// ── Config ───────────────────────────────────────────────────────────────────
export const TRANSFORMERS_CDN =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
/** The Hugging Face repository the weights are loaded from. */
export const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
/** Origin to load weights from. Empty serves them from the Hugging Face Hub. */
export const MODEL_HOST = '';
/** Path template applied under {@link MODEL_HOST}. `{model}` is substituted. */
export const MODEL_PATH_TEMPLATE = '{model}/';
/**
 * Tool calls allowed per turn: the guardrails' default `tools.maxPerTurn` (src/guardrails/defaults.ts), which
 * enforces it. A test keeps the two equal; the chunk can't import it without sharing code with the page-load graph.
 */
export const MAX_STEPS = 3;
/** Default token ceiling for one generation. */
export const MAX_NEW_TOKENS = 512;
/** How long {@link WebMcpTools.waitForTools} waits for tools to register. */
export const TOOLS_TIMEOUT_MS = 20000;

/**
 * The default instructions, used when no `systemPrompt` is supplied.
 *
 * Directs the model to call a tool as soon as it knows which one applies, with
 * whatever fields it has, because the harness collects the rest.
 */
export const SYSTEM_PROMPT = [
  'You are an in-page assistant embedded in a web form.',
  "Use the available tools to complete the user's request by filling and submitting the form.",
  "Infer each argument from the user's message and the tool's schema.",
  'Use parameter names EXACTLY as defined in the tool schema — do not rename, translate, or add suffixes like "_needs".',
  'Only include fields the user provided or that are clearly implied; never invent emails, names, or dates.',
  'Fields marked "required" in the schema must always be provided — name and email are always required.',
  // The harness collects missing fields itself, as a form or a stepper, which
  // requires the model to hand over a partial call rather than asking in prose.
  'Call the tool as soon as you know which one is right, even if some required fields are still unknown — include the fields you do have and simply omit the rest.',
  'Never ask the user to supply a missing field in prose. Leave it out of the call; the page will collect it.',
  'Call at most one tool per turn.',
].join(' ');

/**
 * Whether a load should use the browser cache, given how many previous loads
 * never returned.
 *
 * The guard counts loads that started and did not finish. A renderer killed
 * mid-load runs no handler, so the count is the only evidence the next attempt
 * has.
 *
 * | `died` | Decision | Why |
 * |---|---|---|
 * | 0 | cache | Nothing went wrong last time. |
 * | 1 | no cache | One unfinished load. Cache Storage failing on an entry this size is a known cause, so the theory gets one attempt. |
 * | 2+ | cache | It died without the cache too, so that was not the cause. Re-downloading gigabytes is itself a cause of the failure, and repeating it forever turns one crash into caching that never works again. |
 *
 * @param died - Unfinished loads recorded by the guard.
 * @param useBrowserCache - The host's setting. False always wins.
 * @returns Whether to let Transformers.js use Cache Storage this time.
 */
export function shouldUseCache(died: number, useBrowserCache: boolean): boolean {
  return useBrowserCache && died !== 1;
}

/**
 * Storage key marking a load that started but never finished.
 *
 * Written before the first byte and cleared on success or on a caught error, so
 * a value left behind means the renderer was terminated mid-load. That can
 * happen when the browser kills the process over a Cache Storage failure on an
 * entry this size, which runs no catch block, no `onerror` and no `unload`
 * handler. Persisting the attempt is what lets the next load detect it and
 * retry without the browser cache.
 */
const LOAD_GUARD_KEY = 'nxis-agent-load-guard';

/** Where the attribution badge points. */
export const NXIS_SITE_URL = 'https://nxis.ai';

// ── Brand and icons ──────────────────────────────────────────────────────────
// Inline SVG using `currentColor`, so icons inherit the surrounding theme.
export const NXIS_LOGO_SVG = `<svg viewBox="0 0 39.6 30.4" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="nx-g1" cx="20.65" cy="-40.83" fx="20.65" fy="-40.83" r="14.12" gradientTransform="translate(0 -25.62) scale(1 -1)" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#3f9cf8"/><stop offset=".22" stop-color="#3891f6"/><stop offset=".59" stop-color="#2675f3"/><stop offset=".79" stop-color="#1c64f2"/>
    </radialGradient>
    <radialGradient id="nx-g2" cx="8.54" cy="485.55" fx="8.54" fy="485.55" r="11.08" gradientTransform="translate(0 -294)" href="#nx-g1"/>
    <radialGradient id="nx-g3" cx="31.03" cy="479.6" fx="31.03" fy="479.6" r="10.02" gradientTransform="translate(0 -294)" href="#nx-g1"/>
  </defs>
  <path fill="url(#nx-g1)" d="M33.65.1c-1,1.7-1.9,3.2-2.7,4.7-4.8,8.3-9.6,16.6-14.4,24.9-.3.5-.5.6-1.1.6h-7.8c.2-.2.2-.4.3-.6C13.55,20,19.15,10.3,24.75.6c.2-.4.5-.6,1-.6h7.1c.3.1.4.1.8.1h0Z"/>
  <path fill="url(#nx-g2)" d="M17.15.1c-1.2,2.1-2.3,4-3.5,6-1.7,2.9-3.3,5.8-5,8.6-.2.4-.3.7,0,1.2.6.9,1.1,1.8,1.6,2.7.1.2.2.5.1.6-1.3,2.3-2.7,4.7-4.1,7.1-.2-.3-.3-.4-.4-.6-1.9-3.3-3.8-6.6-5.7-9.8-.2-.4-.2-.7,0-1.1C2.85,10.1,5.55,5.4,8.25.7c.3-.4.6-.6,1.1-.6C11.85.1,14.45,0,17.15.1h0Z"/>
  <path fill="url(#nx-g3)" d="M22.45,30.3c4.4-7.6,8.7-15,13-22.5.1.2.2.3.3.5,1.2,2.1,2.4,4.2,3.7,6.3.2.4.2.7,0,1-2.7,4.7-5.5,9.4-8.2,14.2-.2.4-.5.6-1,.6-2.5-.1-5.1,0-7.8-.1h0Z"/>
</svg>`;

/** Heroicon `check-circle`, for a success state. */
export const ICON_CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>';
/** Heroicon `exclamation-triangle`, for an error state. */
export const ICON_WARN =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/></svg>';
/** Heroicon `arrow-long-right`, for send and submit controls. */
export const ICON_ARROW =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"/></svg>';
/** Heroicon `cog-6-tooth`, for settings. */
export const ICON_GEAR =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>';
/** Heroicon `plus`, for a new conversation. */
export const ICON_PLUS =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>';
/** Heroicon `bars-3`, for the conversation drawer. */
export const ICON_MENU =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5"/></svg>';
// Heroicons v2, outline 24. Inlined because the element renders into a shadow
// root as a single file, where an icon font or sprite sheet would be a second
// network request.

/** Heroicon `stop`, shown on the send button while a turn can be stopped. */
export const ICON_STOP =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z"/></svg>';
/** Heroicon `clipboard-document`, for copying a message. */
export const ICON_COPY =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184"/></svg>';
/** Heroicon `pencil-square`, for editing a message. */
export const ICON_PENCIL =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"/></svg>';
/** Heroicon `arrow-path`, for sending a message again. */
export const ICON_REDO =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>';
/** Heroicon `check`, the confirmation shown after a copy. */
export const ICON_CHECK_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';
/** Heroicon `trash`, for deleting a conversation. */
export const ICON_TRASH =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>';

// ── Text helpers ─────────────────────────────────────────────────────────────
export function humanize(s: unknown): string {
  return String(s).replace(/[_-]+/g, ' ').trim();
}
/** Lower-case the first character, for a name used mid-sentence. */
export function lcFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
/** Escape `&`, `<`, `>` and `"` for interpolation into markup. */
export function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}

// ── Gemma 4 tool-call parsing ────────────────────────────────────────────────
// Gemma 4 emits: <|tool_call>call:NAME{param:<|"|>string<|"|>,num:42}<tool_call|>
/**
 * Matches a tool call in Gemma's output.
 *
 * The name class allows `-` and `.`, which appear in tool names generated from
 * a page's Schema.org actions (`quote-form`, `booking-form`). A narrower class
 * both fails to parse the call and fails to strip it, leaving the raw marker
 * visible as if it were the reply.
 */
const TOOL_CALL_RE = /<\|tool_call>\s*call:([A-Za-z0-9_.\-]+)\s*\{([\s\S]*?)\}\s*<tool_call\|>/;
const STR_DELIM = '<|"|>';

function coerce(raw: string): string | number | boolean | null {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, '');
}

function parseArgs(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const s = body.trim();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === ',' || s[i] === ' ' || s[i] === '\n')) i++;
    const colon = s.indexOf(':', i);
    if (colon === -1) break;
    const key = s.slice(i, colon).trim().replace(/^["']|["']$/g, '');
    i = colon + 1;
    while (s[i] === ' ') i++;
    let value: unknown;
    if (s.startsWith(STR_DELIM, i)) {
      const start = i + STR_DELIM.length;
      const end = s.indexOf(STR_DELIM, start);
      value = s.slice(start, end === -1 ? s.length : end);
      i = end === -1 ? s.length : end + STR_DELIM.length;
    } else {
      let end = s.indexOf(',', i);
      if (end === -1) end = s.length;
      value = coerce(s.slice(i, end));
      i = end;
    }
    if (key) args[key] = value;
  }
  return args;
}

/** Extract a tool call from model output, or null for a plain answer. */
export function parseToolCall(text: string): ParsedToolCall | null {
  const m = text.match(TOOL_CALL_RE);
  if (!m) return null;
  return { name: m[1], args: parseArgs(m[2]) };
}

/** Strip tool-call blocks and special tokens for human-readable display. */
export function stripMarkers(text: string): string {
  return text
    .replace(new RegExp(TOOL_CALL_RE.source, 'g'), '') // whole tool-call blocks
    .split(STR_DELIM)
    .join('"') // string delimiter → quote (before token sweep)
    .replace(/<\|[^>]*>|<[^|>]*\|>/g, '') // stray Gemma <|…> / <…|> tokens (turn, tool_call, …)
    .replace(/<start_of_turn>\s*\w*/g, '') // start-of-turn marker + role word
    .replace(/<end_of_turn>|<eos>|<bos>|<pad>/g, '') // remaining plain markers
    // The piped form `<|start_of_turn>model` loses its marker to the sweep
    // above, leaving the bare role word to be removed here.
    .replace(/^\s*(?:model|assistant|user)\b[:\s]*/i, '')
    .trim();
}

/** Options for {@link LocalGemmaProvider}. */
export interface AgentEngineOptions {
  modelHost?: string;
  modelPathTemplate?: string;
  /** Override the generic form-filling SYSTEM_PROMPT (e.g. a domain skill). */
  systemPrompt?: string;
  onStatus?: (text: string, isError?: boolean) => void;
  onProgress?: (pct: number, detail?: ProgressDetail) => void;
  /**
   * Whether Transformers.js may keep model files in Cache Storage.
   *
   * Defaults to true, which is the difference between downloading the weights
   * once and on every visit. Set false only where the cache itself is failing.
   */
  useBrowserCache?: boolean;
  /**
   * What to do when the device cannot run the model.
   *
   * `'enforce'` (the default) refuses to load, so a phone is never asked to
   * hold 3.4 GB and never has its tab killed. `'warn'` logs and loads anyway.
   * `'off'` skips the check entirely.
   *
   * Loosen it only where you know the device: the failure it prevents cannot
   * be caught, and it takes the host page down with it.
   */
  capabilityCheck?: 'enforce' | 'warn' | 'off';
}

// ── Engine ───────────────────────────────────────────────────────────────────
interface LoadedEngine {
  tokenizer: any;
  model: any;
}

/**
 * The default provider: Gemma 4 (E2B) running on WebGPU in the browser.
 *
 * Owns everything model-specific, including fetching Transformers.js and the
 * weights, applying the chat template, and parsing Gemma's tool-call markers,
 * so that the harness sees only text and structured calls.
 *
 * @example
 * ```ts
 * const provider = new LocalGemmaProvider({ useBrowserCache: true });
 * const harness = new AgentHarness({ renderer, provider });
 * ```
 */
export class LocalGemmaProvider implements ModelProvider {
  readonly name = 'gemma-4-e2b';
  readonly label = 'Gemma 4 E2B';
  readonly local = true;

  modelHost: string;
  modelPathTemplate: string;
  systemPrompt: string;
  onStatus: (text: string, isError?: boolean) => void;
  onProgress: (pct: number, detail?: ProgressDetail) => void;
  useBrowserCache: boolean;
  capabilityCheck: 'enforce' | 'warn' | 'off';
  /** True when this load dropped the cache because the last one never returned. */
  cacheDisabledAfterCrash = false;
  engine: LoadedEngine | null;
  T: any; // transformers module (loaded from CDN)
  private _enginePromise: Promise<LoadedEngine> | null;
  private _progress: Map<string, { loaded: number; total: number }>;

  constructor(opts: AgentEngineOptions = {}) {
    this.modelHost = opts.modelHost || MODEL_HOST;
    this.modelPathTemplate = opts.modelPathTemplate || MODEL_PATH_TEMPLATE;
    this.systemPrompt = opts.systemPrompt || SYSTEM_PROMPT;
    this.onStatus = opts.onStatus || (() => {});
    this.onProgress = opts.onProgress || (() => {});
    this.useBrowserCache = opts.useBrowserCache !== false;
    this.capabilityCheck = opts.capabilityCheck ?? 'enforce';
    this.engine = null; // { tokenizer, model }
    this.T = null; // transformers module
    this._enginePromise = null; // in-flight load (dedupes preload/open/send)
    this._progress = new Map();
  }

  /**
   * Whether the weights are loaded and usable right now.
   *
   * Side-effect free: reading it does not start a load. Use it to distinguish a
   * first visit, where a load takes tens of seconds, from a warm one.
   */
  get ready(): boolean {
    return !!this.engine;
  }

  /**
   * Whether a load is in flight.
   *
   * Distinct from {@link LocalGemmaProvider.ready}: both false means nothing
   * has been requested yet, while `loading` alone means a download is running.
   */
  get loading(): boolean {
    return !!this._enginePromise && !this.engine;
  }
  private _status(text: string, isError = false): void {
    this.onStatus(text, isError);
  }

  /**
   * Begin downloading the weights in the background.
   *
   * @param mode - `'idle'` waits for the browser to be free, keeping the
   * download off the critical path of the host page. `'eager'` starts at once,
   * which spends hundreds of megabytes of a visitor's bandwidth before they
   * have asked for anything, and suits only pages where the agent is the point.
   */
  schedulePreload(mode: Exclude<PreloadMode, 'none'> = 'idle'): void {
    if (!('gpu' in navigator)) return;
    const start = () =>
      this.ensureEngine().catch(() => {
        /* surfaced on use */
      });
    if (mode === 'eager') {
      start();
      return;
    }
    if ('requestIdleCallback' in window) (window as any).requestIdleCallback(start, { timeout: 3000 });
    else setTimeout(start, 1200);
  }

  /** Single shared promise so preload + open + send never double-download. */
  ensureEngine(): Promise<LoadedEngine> {
    if (this.engine) return Promise.resolve(this.engine);
    if (!this._enginePromise) {
      this._enginePromise = this._loadEngine();
      this._enginePromise.catch(() => {
        // A rejection reached a handler, so the guard has served its purpose.
        // Only a load that never returns at all should cost the next its cache.
        this._writeGuard(0);
        this._enginePromise = null;
      }); // allow retry
    }
    return this._enginePromise;
  }

  private async _loadEngine(): Promise<LoadedEngine> {
    if (!('gpu' in navigator)) {
      throw new Error('WebGPU is not available. Use Chrome/Edge 113+ with WebGPU enabled.');
    }

    // Decided before a byte is fetched. An out-of-memory kill runs no handler,
    // so there is nothing to catch afterwards and nothing to apologise with.
    if (this.capabilityCheck !== 'off') {
      const verdict = await assessLocalCapability();
      if (!verdict.ok) {
        if (this.capabilityCheck === 'enforce') {
          throw new Error(
            `This device cannot run the on-device model (${verdict.reason}). ` +
              'Use a remote provider here: see createProxyProvider.',
          );
        }
        console.warn(
          `[nxis] loading the local model on a device that failed the ` +
            `capability check (${verdict.reason}). The tab may be terminated.`,
        );
      }
    }

    // See shouldUseCache for what the count means.
    const died = this._readGuard();
    const useCache = shouldUseCache(died, this.useBrowserCache);
    this._writeGuard(died + 1);
    this.cacheDisabledAfterCrash = !useCache && this.useBrowserCache;

    // Best-effort storage is evicted under pressure, and a multi-gigabyte model
    // is first to go, which looks exactly like caching never having worked.
    if (useCache) {
      const persisted = await requestPersistentStorage();
      if (!persisted) {
        console.info(
          '[nxis] storage is best-effort; the browser may evict the model between visits.',
        );
      }
    }

    this._resetProgress();
    this._status(
      this.cacheDisabledAfterCrash
        ? 'Last load did not finish — retrying without the browser cache…'
        : 'Loading runtime…',
    );
    // The specifier is a URL, not a package: Transformers.js is fetched at
    // runtime and must never be bundled. Each bundler needs its own directive,
    // and omitting one is not harmless. Turbopack, which does not recognise
    // @vite-ignore, compiles this into an external require that has no browser
    // implementation and throws when the agent is opened.
    const T = await import(
      /* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ TRANSFORMERS_CDN
    );
    this.T = T;

    if (T.env && !useCache) {
      // Both flags are needed: `useBrowserCache` governs Cache Storage, and
      // the custom cache is the fallback path that would otherwise be used.
      T.env.useBrowserCache = false;
      T.env.useCustomCache = false;
    }

    const host = (this.modelHost || '').trim();
    if (host && T.env) {
      T.env.remoteHost = host.endsWith('/') ? host : host + '/';
      T.env.remotePathTemplate = this.modelPathTemplate || MODEL_PATH_TEMPLATE;
    }

    const ModelClass =
      T.Gemma4ForConditionalGeneration || T.AutoModelForImageTextToText || T.AutoModelForCausalLM;
    if (!ModelClass)
      throw new Error('This Transformers.js build has no Gemma 4 model class — bump the version.');

    // Text-only function calling, so the tokenizer rather than AutoProcessor,
    // which would build Gemma 4's unused image and audio preprocessors.
    this._resetProgress();
    this._status('Loading tokenizer…');
    const tokenizer = await T.AutoTokenizer.from_pretrained(MODEL_ID, {
      progress_callback: (p: any) => this._trackProgress(p),
    });

    this._resetProgress();
    this._status('Downloading Gemma 4 E2B — first run fetches several GB (cached afterward)…');
    const model = await ModelClass.from_pretrained(MODEL_ID, {
      dtype: 'q4f16',
      device: 'webgpu',
      progress_callback: (p: any) => this._trackProgress(p),
    });

    this.engine = { tokenizer, model };
    // The load returned, so the guard can be cleared.
    this._writeGuard(0);
    this.onProgress(0);
    await this._warmup(); // compile WebGPU kernels so the first real reply is fast
    this._status('Model ready');
    return this.engine;
  }

  private async _warmup(): Promise<void> {
    try {
      this._status('Warming up…');
      const { tokenizer, model } = this.engine!;
      const inputs = await tokenizer.apply_chat_template([{ role: 'user', content: 'hi' }], {
        add_generation_prompt: true,
        add_special_tokens: false,
        return_dict: true,
      });
      await model.generate({ ...inputs, max_new_tokens: 1, do_sample: false });
    } catch {
      /* best-effort */
    }
  }

  private _trackProgress(p: any): void {
    if (p && p.status === 'progress' && p.file) {
      this._progress.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let loaded = 0;
      let total = 0;
      for (const v of this._progress.values()) {
        loaded += v.loaded;
        total += v.total;
      }
      if (total > 0) {
        // Uncapped, and allowed to decrease. Clamping it to never fall means
        // the tokenizer's few files reach 100% within a second and hold the
        // indicator full for the rest of the multi-minute weight download.
        this.onProgress((loaded / total) * 100, { loaded, total });
      }
    }
    // `ready` is intentionally not handled: it fires once per artefact, so the
    // tokenizer's arrives mid-download and resetting on it would drop the
    // indicator to nothing and back. The counters reset when the next load
    // starts instead.
  }

  /** How many loads have started and not come back. Survives the tab dying. */
  private _readGuard(): number {
    try {
      return Number(localStorage.getItem(LOAD_GUARD_KEY)) || 0;
    } catch {
      return 0; // storage disabled — the guard degrades to "no history"
    }
  }

  private _writeGuard(n: number): void {
    try {
      if (n > 0) localStorage.setItem(LOAD_GUARD_KEY, String(n));
      else localStorage.removeItem(LOAD_GUARD_KEY);
    } catch {
      /* storage disabled */
    }
  }

  /**
   * Begin measuring a new load stage from zero.
   *
   * Stages are measured separately because they differ by orders of magnitude
   * in size and the label names one at a time. Pooling them would report the
   * tokenizer's completion as progress on the weights.
   */
  private _resetProgress(): void {
    this._progress.clear();
  }

  /**
   * Generate one completion.
   *
   * Gemma expresses tool calls as markers within its output, so they are parsed
   * here and reported as {@link Completion.call}, leaving the harness with text
   * it can render directly.
   *
   * @param req - The conversation, tools, abort signal and token callback.
   * @returns The generated text with markers stripped, and the tool call it
   * contained, if any.
   */
  async complete(req: CompletionRequest): Promise<Completion> {
    const text = await this.generate(req.messages, this.buildToolDefs(req.tools), {
      onToken: req.onToken,
      maxNewTokens: req.maxTokens,
      signal: req.signal,
    });
    return { text: stripMarkers(text), call: parseToolCall(text) ?? undefined };
  }

  /** Satisfies `ModelProvider.load`; the work is in ensureEngine. */
  async load(): Promise<void> {
    await this.ensureEngine();
  }

  /** Satisfies `ModelProvider.preload`. */
  preload(mode: Exclude<PreloadMode, 'none'> = 'idle'): void {
    this.schedulePreload(mode);
  }

  buildToolDefs(tools: ModelContextToolInfo[]): ToolDef[] {
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: toolSchema(t) },
    }));
  }

  /** Token count of arbitrary text via the loaded tokenizer (0 if unavailable). */
  async countTokens(text: string): Promise<number> {
    try {
      await this.ensureEngine();
      return this.engine!.tokenizer.encode(text).length;
    } catch {
      return 0;
    }
  }

  /**
   * Run one generation.
   *
   * @param messages - The conversation, including the system prompt.
   * @param toolDefs - Tool definitions in the form the chat template expects.
   * @param options - Streaming, usage reporting, token cap and abort signal.
   * @returns The generated text, with protocol markers stripped.
   * @throws `AbortError` if the signal is already aborted when called.
   */
  async generate(
    messages: ChatMessage[],
    toolDefs: ToolDef[],
    {
      onToken,
      onUsage,
      maxNewTokens,
      signal,
    }: {
      onToken?: (text: string) => void;
      onUsage?: (usage: GenerationUsage) => void;
      /**
       * Token ceiling, for generations that are not answers.
       *
       * Defaults to {@link MAX_NEW_TOKENS}. Lower it for short outputs such as
       * a routing decision, which would otherwise run to the full answer budget.
       */
      maxNewTokens?: number;
      /** Aborts the generation, which stops at the next token. */
      signal?: AbortSignal;
    } = {},
  ): Promise<string> {
    await this.ensureEngine();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { tokenizer, model } = this.engine!;
    const inputs = await tokenizer.apply_chat_template(messages, {
      tools: toolDefs,
      add_generation_prompt: true,
      enable_thinking: false,
      tokenize: true,
      add_special_tokens: false,
      return_dict: true,
    });

    let streamed = '';
    const streamer = new this.T.TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: false,
      callback_function: (t: string) => {
        streamed += t;
        if (onToken) onToken(stripMarkers(streamed));
      },
    });

    // Generation stops at the next token once this is tripped. A fresh instance
    // per call, since the class holds its interrupted flag and a reused one
    // would stop every later generation immediately.
    const stopper = new this.T.InterruptableStoppingCriteria();
    const onAbort = () => stopper.interrupt();
    signal?.addEventListener('abort', onAbort, { once: true });

    let output;
    try {
      output = await model.generate({
        ...inputs,
        max_new_tokens: maxNewTokens ?? MAX_NEW_TOKENS,
        do_sample: false,
        stopping_criteria: stopper,
        streamer,
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    let decoded = streamed;
    try {
      const promptLen = inputs.input_ids.dims.at(-1);
      const newTokens = output.slice(null, [promptLen, null]);
      decoded = tokenizer.batch_decode(newTokens, { skip_special_tokens: false })[0];
      if (onUsage) onUsage({ promptTokens: promptLen, outputTokens: output.dims.at(-1) - promptLen });
    } catch {
      /* fall back to streamed text */
    }
    return decoded;
  }
}

/**
 * @deprecated Use {@link LocalGemmaProvider}. The harness takes a
 * {@link ModelProvider}, of which this is one implementation.
 */
export const AgentEngine = LocalGemmaProvider;
/** @deprecated Use {@link LocalGemmaProvider}. */
export type AgentEngine = LocalGemmaProvider;
