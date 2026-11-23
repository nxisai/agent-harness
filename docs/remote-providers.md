# Running the agent on a remote model

The harness ships two providers: `LocalGemmaProvider`, which runs Gemma 4 in the browser over WebGPU, and `createProxyProvider`, which forwards completions to an endpoint you host. This page covers the second, with a worked Claude endpoint.

You write the endpoint; the harness writes the client. What passes between them is the contract below, and it is what we keep stable.

## The client

```ts
import { createProxyProvider } from '@nxisai/agent-harness';

const agent = document.querySelector('nxis-agent');
agent.modelProvider = createProxyProvider({ endpoint: '/api/agent' });
```

Headless, the same provider goes to the harness directly:

```ts
const harness = new AgentHarness({
  renderer,
  provider: createProxyProvider({ endpoint: '/api/agent' }),
});
```

Options: `endpoint` is required; `name` labels it in logs and debug output; `headers` adds request headers for an endpoint expecting its own auth; `fetchImpl` substitutes `fetch`, for tests or for wrapping requests with retry or instrumentation.

The provider has no `load()` and no `countTokens()`, and their absence is meaningful. No `load` tells the UI to skip the download treatment (the charging ring, the byte counts, the stage labels); no `countTokens` hides the token metrics rather than reporting zeroes. `local: false` makes the header badge read `Remote` instead of `On-device`, so a page sending conversations off-device says so.

## The contract

Your endpoint receives a POST with `Accept: application/json` and this body:

```ts
{
  messages: ChatMessage[],              // the conversation, system prompt included
  tools: { name, description, inputSchema }[],   // this agent's slice only
  maxTokens?: number,
  cache?: { stableMessages: number, toolsStable: boolean }
}
```

It answers with:

```ts
{
  text: string,                          // rendered verbatim
  call?: { name: string, args: object }, // at most one
  usage?: { promptTokens: number, outputTokens: number },
  model?: string                         // shown beside the input: "Claude Sonnet 5"
}
```

`model` is optional, and worth sending. The agent shows the visitor which model is answering, and only the endpoint knows for certain — it may route between models, or fall back to a cheaper one under load. Send the name as a person should read it. Until an endpoint has answered, the element shows the `label` the provider was created with, then `name`.

Tools arrive normalised to those three fields. WebMCP carries a schema under four different keys and sometimes as a JSON string; `createProxyProvider` resolves that before sending, so an endpoint reads `inputSchema` and nothing else. It is also what keeps the request serialisable: a native WebMCP registry hands back live objects that reference the page, and stringifying one throws.

Four rules, and each one is silent when broken, which is why they are written down:

**`text` is rendered verbatim.** Strip any protocol markers in the endpoint. The harness does no parsing.

**At most one call per completion.** The harness runs one tool per completion. `createProxyProvider` takes the first and warns about the rest, including when they arrive as a `calls` array, so a mapping mistake is loud rather than invisible. A turn can be several completions: after a read the harness asks again, with the result as the newest message (a `user` message carrying the result in a data block), and the model calls the next read or answers in words. Only the first request of a turn ends with the visitor's own message, which is how an endpoint tells a new turn from a step of one. A step can come with no tools, when the model may only answer.

**Honour the abort.** `createProxyProvider` passes `signal` to `fetch` for you; your endpoint should likewise abandon its upstream request. Rejecting with an `AbortError` is correct: the harness treats it as a cancellation and resolves the turn as `'stopped'`, not as a failure.

**Answer with JSON while the request asks for it.** The `Accept` header is how streaming arrives later without breaking anything: a future streaming provider will ask for `text/event-stream`, and an endpoint that only speaks JSON keeps working with this one.

**The cache hint is advice.** `{ stableMessages, toolsStable }` says what the harness knows will repeat: the system prompt while the conversation stays with one agent, the tool slice while it does not change. Both go false at a specialist handoff. Whether to act on it is your backend's decision.

### With guardrails at the proxy

An endpoint may also enforce the page's guardrails, from a policy it holds. It then serves the policy copy on GET, issues a conversation id, checks the policy version, and refuses with a typed `refusal`. `createProxyProvider` reads all of it, and an endpoint without guardrails needs none of it. See [guardrails-policy.md](guardrails-policy.md#the-proxy-contract-with-guardrails).

## Put a proxy on your own origin

Do not call a vendor API from the browser. A key in page source is a key anyone can read, and there is no rate limit, no audit, and no CORS story. Put an endpoint on the same origin as the page:

```
browser (provider)  →  POST /api/agent  (your origin, session cookie)  →  vendor API (your key)
```

Same origin also means your existing session auth applies, so you can answer "who is allowed to ask" before spending anything.

## The endpoint

A Next route handler. The mapping in both directions is the part worth reading: WebMCP tool schemas go out as Claude tools, and Claude's `tool_use` block comes back as `Completion.call`.

```ts
// app/api/agent/route.ts
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  // Your auth, your rate limiting. The browser cannot enforce either.
  const { messages, tools, maxTokens, cache } = await request.json();

  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const turns = messages.filter((m) => m.role !== 'system');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: maxTokens ?? 1024,
    // The harness says when a prefix is worth caching; whether to act on it is
    // yours. Claude caches from the marked block backwards.
    system: cache?.toolsStable
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    })),
    messages: turns,
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // At most one call: the harness handles one tool per turn.
  const use = response.content.find((b) => b.type === 'tool_use');

  return Response.json({
    text,
    call: use ? { name: use.name, args: use.input } : undefined,
    usage: {
      promptTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    // The model that actually answered, from the response rather than the
    // request, so a fallback shows up as itself.
    model: response.model,
  });
}
```

## Writing a provider by hand

`createProxyProvider` covers the case above. Write your own `ModelProvider` when the transport is not an HTTP POST of this shape: a WebSocket, a shared worker, an SDK that manages its own connection.

```ts
interface ModelProvider {
  readonly name: string;
  readonly local: boolean;      // false for anything off-device
  readonly ready: boolean;
  readonly loading: boolean;
  load?(): Promise<void>;       // omit it: nothing to download
  preload?(mode): void;         // omit it
  complete(req: CompletionRequest): Promise<Completion>;
  countTokens?(text): Promise<number>;   // omit it: hides the token metrics
}
```

Implement `complete` and the four readonly fields. The four rules above still apply, and nothing enforces them for you.

## Streaming

`onToken` is called with the whole answer so far, not the newest fragment. Nothing in the harness requires a stream: a provider that resolves once shows the thinking indicator until it does. If you want tokens as they arrive, stream from your endpoint and call `onToken` as you read.

```ts
async complete({ messages, tools, maxTokens, signal, onToken }) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    signal,
    body: JSON.stringify({ messages, tools, maxTokens, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Agent endpoint returned ${res.status}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  let call;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'text') {
        text += event.delta;
        onToken?.(text);        // the whole answer so far
      }
      if (event.type === 'tool_use') call = { name: event.name, args: event.input };
    }
  }
  return { text: text.trim(), call };
}
```

On the endpoint, map your vendor's stream to those events. Claude's `content_block_delta` carries `text_delta` for prose, and the `tool_use` block's input arrives as `input_json_delta` fragments that have to be concatenated and parsed once the block stops.

## Notes

The four rules under [The contract](#the-contract) are the ones that bite. One more is worth knowing when writing the endpoint:

**Tool results go back as user turns.** The harness writes them into the transcript itself, as `[nxis_query returned]` followed by the result in a data block (`<data-…>…</data-…>`, drawn by the guardrails) for a read, and `[booking-form submitted with: …]` for a write. Your provider receives the rendered copy: plain `{ role, content }` turns, with the untrusted parts already inside their blocks. Your endpoint therefore does not need Claude's `tool_use` and `tool_result` block pairing unless you want the model to see it that way; plain turns are what arrives.
