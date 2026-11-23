/**
 * The model provider interface.
 *
 * A provider supplies one completion at a time. Everything else the harness
 * does (discovering tools, reading their schemas, deciding whether to ask,
 * confirm or run) is the same whichever model answers.
 *
 * Completions are structured rather than plain text: a provider reports a tool
 * call as {@link Completion.call}, whether its model expresses that as a native
 * tool-use block or as markers in the text it generates.
 *
 * @see The bundled {@link LocalGemmaProvider}, and `docs/remote-providers.md`
 * for a worked remote implementation.
 *
 * @module
 */
import type {
  ChatMessage,
  GenerationUsage,
  ModelContextToolInfo,
  ParsedToolCall,
  PreloadMode,
} from '../types.js';
import type { GuardrailDecision } from '../guardrails/types.js';

/**
 * What the harness knows about which parts of a request will repeat.
 *
 * Advisory. The harness caches nothing itself; acting on the hint is a
 * provider's decision, and only worthwhile where the backend supports prompt
 * caching. Both fields go false when a handoff between agents changes the
 * system prompt and the tool set.
 */
export interface CacheHint {
  /** How many leading messages will be identical on the next request. */
  stableMessages: number;
  /** Whether the tool definitions are unchanged since the previous request. */
  toolsStable: boolean;
}

/** One request for a completion. */
export interface CompletionRequest {
  /** The conversation so far, including the system prompt. */
  messages: ChatMessage[];
  /**
   * The tools available for this turn, as raw WebMCP entries.
   *
   * Providers translate these into whatever their model expects.
   */
  tools: ModelContextToolInfo[];
  /** Ceiling on generated tokens. Providers may apply their own default. */
  maxTokens?: number;
  /**
   * Aborts when the user stops the turn, closes the panel, or starts another.
   *
   * Honour it: pass it to `fetch`, or interrupt local generation. Rejecting
   * with an `AbortError` is correct, and the harness treats it as a
   * cancellation rather than a failure.
   */
  signal?: AbortSignal;
  /**
   * Called as text arrives, with the whole answer so far rather than the newest
   * fragment. Optional: a provider that does not stream simply omits it.
   */
  onToken?(textSoFar: string): void;
  /** What the harness knows about reuse. Advisory; see {@link CacheHint}. */
  cache?: CacheHint;
  /**
   * The guardrails policy version the page holds, from the model proxy (`guardrails-src`). A proxy provider sends it
   * as `Nxis-Guardrails-Version`; others ignore it.
   */
  guardrails?: { version?: string };
}

/** What a provider returns for one request. */
export interface Completion {
  /**
   * Text to show the user, rendered verbatim. Strip any protocol markers in the
   * provider: the harness does no parsing of its own.
   */
  text: string;
  /**
   * The tool the model asked for, if any. At most one per completion; a model
   * that returns several calls should report the first and drop the rest.
   */
  call?: ParsedToolCall;
  /** Token counts, when the provider can report them. */
  usage?: GenerationUsage;
  /**
   * The model that produced this completion, as a visitor should read it.
   *
   * For a provider that cannot know in advance — an endpoint that routes
   * between models, or falls back to a cheaper one under load — this is how
   * the name shown beside the input stays true.
   */
  model?: string;
  /**
   * What the model proxy's guardrails said, when it has them: the policy version it holds now (when it differs from
   * the page's), and a refusal, typed, when it refused this request. A refused completion's `text` is empty; the
   * guardrails show the same message, and raise the same `nxis-guardrail` event, as for their own decision.
   */
  guardrails?: { version?: string; refusal?: GuardrailDecision };
}

/**
 * A source of model completions.
 *
 * Implement `complete` and the four readonly fields; everything else is
 * optional. See `docs/remote-providers.md` for a worked example.
 */
export interface ModelProvider {
  /** Identifies the provider in logs and debug output, not to end users. */
  readonly name: string;
  /**
   * The model's name as a visitor should read it — `'Gemma 4 E2B'`.
   *
   * Shown beside the input, so someone can see what is answering them.
   * Falls back to {@link name} when absent.
   */
  readonly label?: string;
  /**
   * Whether inference happens on the user's device.
   *
   * Surfaced in the UI, so that a page sending conversations to a remote
   * service says so.
   */
  readonly local: boolean;

  /** Whether the provider can answer a request right now. */
  readonly ready: boolean;
  /** Whether a load is in flight. Always false when there is nothing to load. */
  readonly loading: boolean;

  /**
   * Prepare the model, resolving once it is ready.
   *
   * Omit it entirely when there is nothing to prepare: its absence is what
   * tells the UI to skip the download progress treatment.
   */
  load?(): Promise<void>;
  /**
   * Begin loading ahead of the first turn.
   *
   * @param mode - How eagerly to load, from the element's `preload` attribute.
   */
  preload?(mode: Exclude<PreloadMode, 'none'>): void;

  /**
   * Produce one completion.
   *
   * @param req - The conversation, the available tools, and the abort signal.
   * @returns The generated text and the tool call it implies, if any.
   */
  complete(req: CompletionRequest): Promise<Completion>;
  /**
   * Count tokens in a string.
   *
   * Optional. A provider that cannot count causes token metrics to be hidden
   * rather than estimated.
   */
  countTokens?(text: string): Promise<number>;
}
