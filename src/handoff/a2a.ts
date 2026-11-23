/**
 * A small A2A 1.0 client, over JSON-RPC, for talking to a site's handoff relay.
 *
 * Only what a handoff needs: send a message (streamed or not), read a task,
 * subscribe to one, cancel one. The official `@a2a-js/sdk` covers the whole
 * protocol, but brings a JWT library and protobuf and gRPC peers with it, and
 * this harness ships nothing it doesn't use.
 *
 * The wire format is A2A 1.0's JSON: parts and stream events are told apart by
 * which member they carry (`text`, `data`, `statusUpdate`, …), and enums are
 * their names (`TASK_STATE_WORKING`, `ROLE_USER`). Servers still on 0.3 send
 * `kind` discriminators and lower-case states; those are read too.
 *
 * @see https://a2a-protocol.org/latest/specification/
 * @module
 */

/** The A2A protocol version this client speaks, sent as `A2A-Version`. */
export const A2A_VERSION = '1.0';

/** A task's state, by its A2A 1.0 name. */
export type A2ATaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

/** One piece of a message or artifact. Which member is present says what it is. */
export interface A2APart {
  text?: string;
  data?: unknown;
  url?: string;
  raw?: string;
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

/** A message, from the visitor (`ROLE_USER`) or the target (`ROLE_AGENT`). */
export interface A2AMessage {
  messageId: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

/** Where a task stands, and the message that goes with it, if any. */
export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

/** Output a task produced. */
export interface A2AArtifact {
  artifactId?: string;
  name?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

/** A unit of work at the target. */
export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

/** One event on a stream, or the result of a send: exactly one member is set. */
export interface A2AStreamResponse {
  task?: A2ATask;
  message?: A2AMessage;
  statusUpdate?: { taskId: string; contextId?: string; status: A2ATaskStatus; metadata?: Record<string, unknown> };
  artifactUpdate?: { taskId: string; contextId?: string; artifact: A2AArtifact; append?: boolean; lastChunk?: boolean };
}

/** An error the relay or the target answered with. */
export class A2AError extends Error {
  constructor(
    message: string,
    /** The JSON-RPC error code, or the HTTP status when the relay refused before A2A. */
    readonly code: number,
    /** The HTTP status of the response. */
    readonly status?: number,
    /** Seconds to wait, from `Retry-After`, when the relay is rate limiting. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'A2AError';
  }
}

/** Options for {@link A2AClient}. */
export interface A2AClientOptions {
  /** Where requests go: the relay's URL for one target, `/api/handoff/booking`. */
  endpoint: string;
  /** Extensions to announce in `A2A-Extensions`. */
  extensions?: string[];
  /** `fetch` to use. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/** What a call returned, with the response headers the relay may have set. */
export interface A2AReply<T> {
  result: T;
  headers: Headers;
}

/** A stream of events, and the response headers it opened with. */
export interface A2AStream {
  events: AsyncGenerator<A2AStreamResponse, void, undefined>;
  headers: Headers;
}

let nextId = 1;

/** A2A over JSON-RPC to one endpoint. */
export class A2AClient {
  constructor(private readonly opts: A2AClientOptions) {}

  /**
   * Call a method that answers once: `SendMessage`, `GetTask`, `CancelTask`.
   *
   * @throws {@link A2AError} when the relay refuses or the target answers with an error.
   */
  async call<T>(
    method: string,
    params: unknown,
    init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<A2AReply<T>> {
    const res = await this.post(method, params, 'application/json', init);
    const body = (await res.json().catch(() => null)) as { result?: T; error?: { code: number; message: string } } | null;
    if (!body) throw new A2AError(`Empty answer to ${method}`, -32603, res.status);
    if (body.error) throw new A2AError(body.error.message, body.error.code, res.status);
    return { result: body.result as T, headers: res.headers };
  }

  /**
   * Call a method that answers with a stream: `SendStreamingMessage`, `SubscribeToTask`.
   *
   * The generator ends when the server closes the stream, which it does at a
   * terminal state, or earlier if the host cuts the response off.
   *
   * @throws {@link A2AError} when the relay refuses; an error event on the stream
   * is thrown from the generator.
   */
  async stream(
    method: string,
    params: unknown,
    init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<A2AStream> {
    const res = await this.post(method, params, 'text/event-stream', init);
    const type = res.headers.get('content-type') ?? '';
    // A server may answer a streaming request with a single JSON response: an
    // error, or a target without streaming that replied at once.
    if (!type.includes('text/event-stream')) {
      const body = (await res.json().catch(() => null)) as
        | { result?: A2AStreamResponse; error?: { code: number; message: string } }
        | null;
      if (body?.error) throw new A2AError(body.error.message, body.error.code, res.status);
      const once = body?.result;
      return {
        headers: res.headers,
        events: (async function* () {
          if (once) yield normaliseResponse(once);
        })(),
      };
    }
    return { headers: res.headers, events: readEvents(res, init.signal) };
  }

  private async post(
    method: string,
    params: unknown,
    accept: string,
    init: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(this.opts.endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      signal: init.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: accept,
        'A2A-Version': A2A_VERSION,
        ...(this.opts.extensions?.length ? { 'A2A-Extensions': this.opts.extensions.join(',') } : {}),
        ...init.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    if (!res.ok) {
      const retry = Number(res.headers.get('retry-after'));
      let message = `${method} refused (${res.status})`;
      try {
        const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
        const text = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message);
        if (text) message = text;
      } catch {
        // Not JSON: keep the status line.
      }
      throw new A2AError(message, res.status, res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    return res;
  }
}

/** Server-sent events off a response body, as A2A stream responses. */
async function* readEvents(res: Response, signal?: AbortSignal): AsyncGenerator<A2AStreamResponse, void, undefined> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = boundary(buffer)) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^(\r?\n){2}/, '');
        const event = parseBlock(block);
        if (event) yield event;
      }
    }
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock?.();
  }
}

/** Where the first complete event block ends, or -1. */
function boundary(buffer: string): number {
  const m = /\r?\n\r?\n/.exec(buffer);
  return m ? m.index : -1;
}

/** One SSE block's `data:` lines, as a stream response; null for comments and keep-alives. */
function parseBlock(block: string): A2AStreamResponse | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data.trim()) return null;
  const body = JSON.parse(data) as { result?: A2AStreamResponse; error?: { code: number; message: string } };
  if (body.error) throw new A2AError(body.error.message, body.error.code);
  return body.result ? normaliseResponse(body.result) : null;
}

/** 0.3 event and state names, read as 1.0's. */
const LEGACY_STATES: Record<string, A2ATaskState> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  rejected: 'TASK_STATE_REJECTED',
  'auth-required': 'TASK_STATE_AUTH_REQUIRED',
};

/** A task state by its 1.0 name, whichever version sent it. */
export function taskState(raw: unknown): A2ATaskState {
  const s = String(raw ?? '');
  if (s.startsWith('TASK_STATE_')) return s as A2ATaskState;
  return LEGACY_STATES[s] ?? 'TASK_STATE_UNSPECIFIED';
}

/** A result in 1.0's shape, whether it came as 1.0 or 0.3 (`kind` discriminators). */
export function normaliseResponse(raw: A2AStreamResponse | Record<string, unknown>): A2AStreamResponse {
  const r = raw as Record<string, unknown>;
  if (r.task || r.message || r.statusUpdate || r.artifactUpdate) {
    const out = { ...(r as A2AStreamResponse) };
    if (out.task) out.task = { ...out.task, status: { ...out.task.status, state: taskState(out.task.status?.state) } };
    if (out.statusUpdate) {
      out.statusUpdate = { ...out.statusUpdate, status: { ...out.statusUpdate.status, state: taskState(out.statusUpdate.status?.state) } };
    }
    return out;
  }
  switch (r.kind) {
    case 'task':
      return normaliseResponse({ task: r as unknown as A2ATask });
    case 'message':
      return { message: r as unknown as A2AMessage };
    case 'status-update':
      return normaliseResponse({ statusUpdate: r as unknown as A2AStreamResponse['statusUpdate'] });
    case 'artifact-update':
      return { artifactUpdate: r as unknown as A2AStreamResponse['artifactUpdate'] };
    default:
      // A bare task, as `GetTask` returns one.
      if (typeof r.id === 'string' && r.status) return normaliseResponse({ task: r as unknown as A2ATask });
      return {};
  }
}

/** Whether a state ends the task. */
export function isTerminal(state: A2ATaskState): boolean {
  return (
    state === 'TASK_STATE_COMPLETED' ||
    state === 'TASK_STATE_FAILED' ||
    state === 'TASK_STATE_CANCELED' ||
    state === 'TASK_STATE_REJECTED'
  );
}

/** A message id, unique enough for one conversation. */
export function newMessageId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
