/**
 * A {@link ModelProvider} that forwards completions to an endpoint you host.
 *
 * The browser never holds a vendor credential: the page posts to your own
 * origin, and your endpoint calls the model with a key only it can see. This is
 * the client half of that arrangement. The server half is yours to write, and
 * `docs/remote-providers.md` documents the contract it has to satisfy.
 *
 * @example
 * ```ts
 * import { createProxyProvider } from '@nxisai/agent-harness';
 *
 * const agent = document.querySelector('nxis-agent');
 * agent.modelProvider = createProxyProvider({ endpoint: '/api/agent' });
 * ```
 *
 * @module
 */
import { toolSchema } from '../harness/tools/schema.js';
import type { JsonSchema, ModelContextToolInfo, ParsedToolCall } from '../types.js';
import type { Completion, ModelProvider } from './types.js';
import type { GuardrailDecision } from '../guardrails/types.js';

/** Options for {@link createProxyProvider}. */
export interface ProxyProviderOptions {
  /**
   * Where completions are requested from.
   *
   * A same-origin path such as `/api/agent` keeps the request under the page's
   * own origin, which is what allows `credentials: 'same-origin'` to carry an
   * existing session and lets the endpoint answer "who is allowed to ask".
   */
  endpoint: string;
  /**
   * Identifies the provider in logs and debug output, not to end users.
   * Defaults to `'proxy'`.
   */
  name?: string;
  /**
   * The model's name as a visitor should read it — `'Claude'`. Shown beside
   * the input. Worth setting: without it the visitor sees {@link name}.
   */
  label?: string;
  /** Extra request headers, for an endpoint that expects its own auth. */
  headers?: Record<string, string>;
  /**
   * `fetch` implementation to use. Defaults to the global.
   *
   * Present so the provider can be tested without a network, and so a host can
   * wrap requests with its own retry or instrumentation.
   */
  fetchImpl?: typeof fetch;
}

/**
 * What an endpoint may return.
 *
 * `calls` is not part of the contract, but mapping a vendor response tends to
 * produce an array (Anthropic returns content blocks, and filtering them for
 * tool uses yields one), so it is accepted and reduced rather than ignored.
 */
interface ProxyResponse {
  text?: unknown;
  call?: ParsedToolCall;
  calls?: ParsedToolCall[];
  usage?: { promptTokens?: number; outputTokens?: number };
  model?: unknown;
}

/**
 * Reduce the page's tools to plain, serialisable data.
 *
 * `discoverTools` returns whatever the WebMCP implementation holds, and a
 * native registry returns live objects that reference the page: passing those
 * to `JSON.stringify` throws "Converting circular structure to JSON, starting
 * at object with constructor 'Window'". The local provider never hit this
 * because it reads the same three fields out before building its prompt.
 *
 * Normalising the schema here also spares every endpoint the job: WebMCP
 * carries it under four different keys and sometimes as a JSON string, and
 * `inputSchema` is the one the contract documents.
 */
function wireTools(tools: ModelContextToolInfo[]) {
  const out: { name: string; description: string; inputSchema: JsonSchema }[] = [];
  for (const tool of tools) {
    const name = tool?.name;
    // A tool without a name can't be called, and the model API refuses the whole request over it.
    if (typeof name !== 'string' || !name) {
      console.warn('[nxis] a tool with no name was left out of the request', tool);
      continue;
    }
    out.push({ name, description: tool.description ?? '', inputSchema: toolSchema(tool) });
  }
  return out;
}

/**
 * Reduce a response to the single call the harness can act on.
 *
 * The harness runs one tool per turn. An endpoint that returns several would
 * otherwise have all but the first silently dropped, so the reduction happens
 * here, once, with a warning naming what was discarded.
 */
function oneCall(body: ProxyResponse, name: string): ParsedToolCall | undefined {
  const many = Array.isArray(body.calls) ? body.calls : [];
  const all = body.call ? [body.call, ...many] : many;
  if (all.length > 1) {
    console.warn(
      `[${name}] endpoint returned ${all.length} tool calls; using "${all[0]?.name}" and ` +
        `discarding ${all.slice(1).map((c) => c?.name).join(', ')}. ` +
        'The harness runs one tool per turn.',
    );
  }
  return all[0];
}

const STAGES = ['input', 'context', 'model', 'tool', 'output', 'handoff'];
const SEVERITIES = ['info', 'warning', 'critical'];

/**
 * The typed refusal in an endpoint's answer, `{ refusal: { stage, rule, action, severity } }`, when it is one. Only
 * those four fields are kept, and only in the shapes the guardrails use: an endpoint can't put text in an event.
 */
function refusalOf(body: unknown): GuardrailDecision | null {
  const r = (body as { refusal?: Record<string, unknown> } | null)?.refusal;
  if (!r || typeof r !== 'object') return null;
  const { stage, rule, action, severity } = r;
  if (!STAGES.includes(stage as string) || typeof rule !== 'string' || !/^[a-z]+\/[a-z0-9-]{1,40}$/.test(rule)) return null;
  if (action !== 'block' || !SEVERITIES.includes(severity as string)) return null;
  return { stage, rule, action, severity } as GuardrailDecision;
}

/**
 * Build a provider that posts completions to your own endpoint.
 *
 * The returned provider deliberately has no `load()`. Its absence is what tells
 * the UI there is nothing to download, so the progress ring, byte counts and
 * stage labels are skipped, and it is why a remote provider works on devices
 * that cannot hold a local model. `countTokens` is likewise absent: token
 * metrics hide themselves rather than reporting zeroes.
 *
 * @param opts - The endpoint, and optionally a name, extra headers, or a
 * `fetch` implementation.
 * @returns A provider ready to pass as `modelProvider` or {@link HarnessOptions.provider}.
 * @throws From `complete()`, if the endpoint answers with a non-2xx status. An
 * aborted request rejects with the `AbortError` from `fetch`, which the harness
 * treats as a cancellation rather than a failure.
 */
export function createProxyProvider(opts: ProxyProviderOptions): ModelProvider {
  const { endpoint, name = 'proxy', label, headers, fetchImpl } = opts;
  /** The model the endpoint last said it used. Wins over the configured label. */
  let served: string | undefined;
  /** The conversation id the endpoint's guardrails issued (`Nxis-Conversation`), sent back with each request. */
  let conversation: string | undefined;

  return {
    name,
    /**
     * What the visitor sees beside the input: the model the endpoint last
     * reported, or the label it was configured with until one has answered.
     */
    get label() {
      return served ?? label;
    },
    /** Inference happens off-device, which the UI surfaces to the visitor. */
    local: false,
    ready: true,
    loading: false,

    async complete({ messages, tools, maxTokens, signal, cache, guardrails }) {
      const send = fetchImpl ?? fetch;
      const res = await send(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Declares which response shape this provider understands. A future
          // streaming provider asks for text/event-stream instead, so an
          // endpoint can offer both and this one keeps working unchanged.
          Accept: 'application/json',
          // Only once the endpoint has guardrails: with none, the request is as it always was.
          ...(conversation ? { 'Nxis-Conversation': conversation } : {}),
          ...(guardrails?.version ? { 'Nxis-Guardrails-Version': guardrails.version } : {}),
          ...headers,
        },
        credentials: 'same-origin',
        // Without this the stop control, Escape and edit-and-resend are all
        // inert: they abort the turn through this signal and nothing else.
        signal,
        body: JSON.stringify({ messages, tools: wireTools(tools), maxTokens, cache }),
      });

      const issued = res.headers?.get?.('Nxis-Conversation');
      if (issued) conversation = issued;
      const version = res.headers?.get?.('Nxis-Guardrails-Version') || undefined;
      // A refusal by the endpoint's guardrails: typed, and shown by the page's guardrails as one of their own.
      const refused = (refusal: GuardrailDecision): Completion => ({ text: '', guardrails: { refusal, ...(version ? { version } : {}) } });

      if (!res.ok) {
        let failed: unknown = null;
        try {
          failed = await res.json();
        } catch {
          // Not JSON: an ordinary failure.
        }
        const refusal = refusalOf(failed);
        if (refusal) return refused(refusal);
        throw new Error(`Agent endpoint ${endpoint} returned ${res.status} ${res.statusText}`);
      }

      const body = (await res.json()) as ProxyResponse;
      const refusal = refusalOf(body);
      if (refusal) return refused(refusal);
      const completion: Completion = {
        // Rendered verbatim, so an endpoint that strips its model's protocol
        // markers is the only thing standing between them and the visitor.
        text: typeof body.text === 'string' ? body.text : '',
      };
      const call = oneCall(body, name);
      if (call) completion.call = call;
      if (body.usage) {
        completion.usage = {
          promptTokens: body.usage.promptTokens ?? 0,
          outputTokens: body.usage.outputTokens ?? 0,
        };
      }
      // Which model answered, when the endpoint says. An endpoint may route
      // between models, so this is the only place the true name comes from.
      if (typeof body.model === 'string' && body.model.trim()) {
        served = body.model.trim();
        completion.model = served;
      }
      if (version) completion.guardrails = { version };
      return completion;
    },
  };
}
