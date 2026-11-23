/**
 * A WebMCP registry for pages that have none of their own.
 *
 * `document.modelContext` is normally installed by the browser, a page script
 * or an extension. Where none is present, discovered remote tools would have
 * nowhere to be registered, and a site with a working MCP server would still
 * offer the agent no tools.
 *
 * '''It is built to the WebMCP spec''' (https://webmachinelearning.github.io/webmcp/),
 * step for step, as `@nxisai/webmcp` is, and `npm run conformance` there checks
 * both against it. A registry kinder than the spec lets code pass every test
 * here and fail in a browser that follows it — which is how an answer in words
 * once reached visitors as an empty "No results found." card. In short:
 *
 * - `registerTool` never throws; every failure rejects. A missing `name`,
 *   `description` or `execute`, or an `inputSchema` that is not an object, is a
 *   `TypeError`; a duplicate name, one outside 1–128 of `[A-Za-z0-9_.-]`, or an
 *   empty description is an `InvalidStateError`. It resolves after `toolchange`.
 * - `getTools` lists tools sorted by name, with `title` (`""` when absent),
 *   `origin` and `window`; `inputSchema` and `annotations` only when given, the
 *   annotations as the spec's four hints.
 * - `executeTool` takes a tool as `getTools` reports it and an input object —
 *   required. The tool gets a copy of the input through JSON, and `{ signal }`.
 *   The result comes back serialized as JSON, so a string arrives quoted; a
 *   tool that throws, or returns what JSON cannot hold (`undefined`), rejects
 *   with `UnknownError`. Input is not checked against the schema.
 * - `toolactivated` fires as a tool starts, `toolcancel` when a caller aborts it.
 *
 * Browsers are not there yet: Chrome 155 returns strings unquoted, `"undefined"`
 * for nothing, accepts an omitted input and fires neither new event; Chrome 153
 * wants the input as a JSON string. {@link executeRegistered} and
 * {@link asResponse} take all of them.
 *
 * @module
 */
import type {
  ModelContext,
  ModelContextTool,
  ModelContextToolInfo,
  ModelContextToolResponse,
} from '../../types.js';

/** Set on the instance so a later, real provider can be told apart from ours. */
export const LOCAL_CONTEXT_FLAG = '__nxisLocalModelContext';

/** The spec's four hints, as `getTools` reports them. */
type Hints = { consequentialHint: boolean; debugging: boolean; readOnlyHint: boolean; untrustedContentHint: boolean };

/** A registered tool, as the spec's "tool definition" holds it. */
interface ToolDefinition {
  name: string;
  title: string | null;
  description: string;
  /** The schema as JSON; `""` when there was none. */
  inputSchema: string;
  annotations: Hints | null;
  execute: ModelContextTool['execute'];
}

/** An execution in flight. `started` stands in for the spec's local pending execution. */
interface PendingExecution {
  toolName: string;
  controller: AbortController;
  started: boolean;
  complete: (result: string | null, success: boolean) => void;
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function domException(message: string, name: string): Error {
  if (typeof DOMException === 'function') return new DOMException(message, name);
  return Object.assign(new Error(message), { name });
}

/** "Queue a global task": after the current task and its microtasks. */
const queueTask = (steps: () => void): void => void setTimeout(steps, 0);

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

/** `JSON.stringify`, with a `TypeError` where it yields nothing, as Infra's serializer has it. */
function serializeJSON(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('The value cannot be serialized as JSON.');
  return json;
}

function dictionary(value: unknown, type: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new TypeError(`The provided value is not of type '${type}'.`);
  return value as Record<string, unknown>;
}

function required(dict: Record<string, unknown>, member: string, type: string): unknown {
  if (dict[member] === undefined) {
    throw new TypeError(`Failed to read the '${member}' property from '${type}': Required member is undefined.`);
  }
  return dict[member];
}

function toHints(value: unknown): Hints {
  const dict = dictionary(value, 'ToolAnnotations');
  const hint = (key: keyof Hints) => (dict[key] === undefined ? false : Boolean(dict[key]));
  return {
    consequentialHint: hint('consequentialHint'),
    debugging: hint('debugging'),
    readOnlyHint: hint('readOnlyHint'),
    untrustedContentHint: hint('untrustedContentHint'),
  };
}

function toSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (typeof AbortSignal === 'function' && !(value instanceof AbortSignal)) {
    throw new TypeError("Failed to read the 'signal' property: The provided value is not of type 'AbortSignal'.");
  }
  return value as AbortSignal;
}

const ownWindow = (): object => (typeof window !== 'undefined' ? window : globalThis);
const isWindow = (value: unknown): boolean =>
  typeof window === 'undefined' ? value === globalThis : isObject(value) && (value as { window?: unknown }).window === value;
/** Outside a browser `http://localhost` stands in: an opaque origin would refuse every call. */
const ownOrigin = (): string => (typeof location !== 'undefined' ? location.origin : 'http://localhost');

function isTrustworthy(url: URL): boolean {
  if (url.origin === 'null') return false;
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
  const host = url.hostname;
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '[::1]';
}

/** `SecurityError` for an origin that doesn't parse or isn't potentially trustworthy. */
function checkOrigins(origins: unknown, member: string): void {
  if (origins === undefined) return;
  if (!isObject(origins) || typeof (origins as Partial<Iterable<unknown>>)[Symbol.iterator] !== 'function') {
    throw new TypeError(`Failed to read the '${member}' property: The provided value cannot be converted to a sequence.`);
  }
  for (const origin of origins as Iterable<unknown>) {
    let url: URL;
    try {
      url = new URL(`${origin as string}`);
    } catch {
      throw domException(`"${origin}" is not a valid origin.`, 'SecurityError');
    }
    if (!isTrustworthy(url)) throw domException(`"${origin}" is not a potentially trustworthy origin.`, 'SecurityError');
  }
}

/** The spec's opening checks: an origin-keyed agent cluster, unless the page is a `file:` one. */
function accessError(): Error | null {
  const keyed = (globalThis as { originAgentCluster?: unknown }).originAgentCluster;
  const scheme = typeof location !== 'undefined' ? location.protocol : '';
  return keyed === false && scheme !== 'file:'
    ? domException("This page's agent cluster is not origin-keyed.", 'SecurityError')
    : null;
}

type Handler = ((event: Event) => unknown) | null;

/** An event carrying the name of the tool it concerns: `toolactivated`, `toolcancel`. */
class ToolEvent extends Event {
  constructor(
    type: string,
    readonly toolName: string,
  ) {
    super(type);
  }
}

/**
 * An in-memory tool registry built to the WebMCP spec.
 *
 * Installed by {@link ensureModelContext} on pages that have no registry of
 * their own, so that discovered remote tools have somewhere to live.
 */
export class LocalModelContext extends EventTarget implements ModelContext {
  readonly [LOCAL_CONTEXT_FLAG] = true;
  private readonly _tools = new Map<string, ToolDefinition>();
  private readonly _pending = new Map<symbol, PendingExecution>();
  private readonly _handlers: Record<string, Handler> = {};
  private readonly _listeners: Record<string, EventListener> = {};

  get ontoolchange(): Handler {
    return this._handlers.toolchange ?? null;
  }
  set ontoolchange(handler: Handler) {
    this._setHandler('toolchange', handler);
  }
  get ontoolactivated(): Handler {
    return this._handlers.toolactivated ?? null;
  }
  set ontoolactivated(handler: Handler) {
    this._setHandler('toolactivated', handler);
  }
  get ontoolcancel(): Handler {
    return this._handlers.toolcancel ?? null;
  }
  set ontoolcancel(handler: Handler) {
    this._setHandler('toolcancel', handler);
  }

  registerTool(tool: ModelContextTool, options: unknown = {}): Promise<void> {
    const type = 'ModelContextTool';
    let definition: ToolDefinition;
    let signal: AbortSignal | undefined;
    let schema: unknown;
    let exposedTo: unknown;
    try {
      // Members in lexicographic order, as WebIDL converts a dictionary.
      const dict = dictionary(tool, type);
      const annotations = dict.annotations === undefined ? null : toHints(dict.annotations);
      const description = `${required(dict, 'description', type) as string}`;
      const execute = required(dict, 'execute', type);
      if (typeof execute !== 'function') {
        throw new TypeError(`Failed to read the 'execute' property from '${type}': The provided value is not a function.`);
      }
      schema = dict.inputSchema;
      if (schema !== undefined && !isObject(schema)) {
        throw new TypeError(`Failed to read the 'inputSchema' property from '${type}': The provided value is not of type 'object'.`);
      }
      const name = `${required(dict, 'name', type) as string}`;
      const title = dict.title === undefined ? null : `${dict.title as string}`;
      definition = { name, title, description, inputSchema: '', annotations, execute: execute as ToolDefinition['execute'] };
      const opts = dictionary(options, 'ModelContextRegisterToolOptions');
      exposedTo = opts.exposedTo;
      signal = toSignal(opts.signal);
    } catch (error) {
      return Promise.reject(error);
    }

    const denied = accessError();
    if (denied) return Promise.reject(denied);
    const { name } = definition;
    if (this._tools.has(name)) {
      return Promise.reject(domException(`A tool named "${name}" is already registered.`, 'InvalidStateError'));
    }
    if (!TOOL_NAME.test(name)) {
      return Promise.reject(
        domException(`"${name}" is not a valid tool name: 1 to 128 ASCII letters, digits, "_", "-" or ".".`, 'InvalidStateError'),
      );
    }
    if (definition.description === '') {
      return Promise.reject(domException("A tool's description must not be empty.", 'InvalidStateError'));
    }
    if (schema !== undefined) {
      try {
        definition.inputSchema = serializeJSON(schema);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    try {
      checkOrigins(exposedTo, 'exposedTo');
    } catch (error) {
      return Promise.reject(error);
    }

    let settle!: { resolve: () => void; reject: (reason: unknown) => void };
    const promise = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    if (signal) {
      const s = signal;
      s.addEventListener(
        'abort',
        () => {
          if (this._tools.delete(name)) this._notifyToolChange();
          settle.reject(s.reason);
        },
        { once: true },
      );
    }
    this._tools.set(name, definition);
    this._notifyToolChange();
    queueTask(() => settle.resolve());
    return promise;
  }

  getTools(options: unknown = {}): Promise<ModelContextToolInfo[]> {
    try {
      checkOrigins(dictionary(options, 'ModelContextGetToolOptions').fromOrigins, 'fromOrigins');
    } catch (error) {
      return Promise.reject(error);
    }
    const denied = accessError();
    if (denied) return Promise.reject(denied);
    return new Promise((resolve) => {
      const origin = ownOrigin();
      const win = ownWindow();
      const tools = [...this._tools.values()].map((t) => {
        // Members in lexicographic order, as WebIDL creates a dictionary; absent ones are left out.
        const info: Record<string, unknown> = {};
        if (t.annotations) info.annotations = { ...t.annotations };
        info.description = t.description;
        if (t.inputSchema !== '') info.inputSchema = JSON.parse(t.inputSchema);
        info.name = t.name;
        info.origin = origin;
        info.title = t.title ?? '';
        info.window = win;
        return info as unknown as ModelContextToolInfo;
      });
      tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      queueTask(() => resolve(tools));
    });
  }

  executeTool(tool: string | object, inputObject?: unknown, options: unknown = {}): Promise<ModelContextToolResponse> {
    const type = 'RegisteredTool';
    let name: string;
    let origin: string;
    let win: unknown;
    let signal: AbortSignal | undefined;
    try {
      const dict = dictionary(tool, type);
      if (dict.annotations !== undefined) toHints(dict.annotations);
      required(dict, 'description', type);
      if (dict.inputSchema !== undefined && !isObject(dict.inputSchema)) {
        throw new TypeError(`Failed to read the 'inputSchema' property from '${type}': The provided value is not of type 'object'.`);
      }
      name = `${required(dict, 'name', type) as string}`;
      origin = `${required(dict, 'origin', type) as string}`;
      win = required(dict, 'window', type);
      if (!isWindow(win)) {
        throw new TypeError(`Failed to read the 'window' property from '${type}': The provided value is not of type 'Window'.`);
      }
      signal = toSignal(dictionary(options, 'ModelContextExecuteToolOptions').signal);
    } catch (error) {
      return Promise.reject(error);
    }
    const denied = accessError();
    if (denied) return Promise.reject(denied);

    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(origin).origin;
    } catch {
      return Promise.reject(domException(`"${origin}" is not a valid origin.`, 'NotSupportedError'));
    }
    if (expectedOrigin === 'null') return Promise.reject(domException("A tool's origin must not be opaque.", 'NotSupportedError'));
    if (!isObject(inputObject)) {
      return Promise.reject(new TypeError("Failed to execute 'executeTool' on 'ModelContext': The input is not an object."));
    }
    let inputArguments: string;
    try {
      inputArguments = serializeJSON(inputObject);
    } catch (error) {
      return Promise.reject(error);
    }

    let settle!: { resolve: (value: string) => void; reject: (reason: unknown) => void };
    const promise = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
    const uuid = Symbol('tool execution');
    if (signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      const s = signal;
      s.addEventListener(
        'abort',
        () => {
          settle.reject(s.reason);
          queueTask(() => this._cancel(uuid));
        },
        { once: true },
      );
    }

    const fail = () => queueTask(() => settle.reject(domException('The tool could not be executed.', 'UnknownError')));
    queueTask(() => {
      if (win !== ownWindow() || ownOrigin() !== expectedOrigin || !this._tools.has(name)) return fail();
      const execution: PendingExecution = {
        toolName: name,
        controller: new AbortController(),
        started: false,
        complete: (result, success) => {
          if (!this._pending.delete(uuid)) return;
          queueTask(() =>
            success
              ? settle.resolve(result as string)
              : settle.reject(domException("The tool's execution failed.", 'UnknownError')),
          );
        },
      };
      this._pending.set(uuid, execution);
      queueTask(() => this._runTool(name, inputArguments, execution));
    });
    // A string, as the spec resolves it. Typed as a response for the callers that read it through
    // `asResponse` in webmcp.ts.
    return promise as unknown as Promise<ModelContextToolResponse>;
  }

  /** The spec's tool execute steps, then its imperative execute steps. */
  private _runTool(name: string, inputArguments: string, execution: PendingExecution): void {
    const definition = this._tools.get(name);
    if (!definition) return execution.complete(null, false);
    let input: unknown;
    try {
      input = JSON.parse(inputArguments);
    } catch {
      return execution.complete(null, false);
    }
    if (!isObject(input)) return execution.complete(null, false);

    this.dispatchEvent(new ToolEvent('toolactivated', name));
    execution.started = true;
    let toolPromise: Promise<unknown>;
    try {
      // A WebIDL callback: `this` undefined, and a synchronous throw is a rejection.
      toolPromise = Promise.resolve(
        definition.execute.call(undefined, input as Record<string, unknown>, { signal: execution.controller.signal }),
      );
    } catch (error) {
      toolPromise = Promise.reject(error);
    }
    toolPromise.then(
      (value) => {
        if (!execution.started) return; // cancelled before the tool settled
        execution.started = false;
        let serialized: string;
        try {
          serialized = serializeJSON(value);
        } catch {
          return execution.complete(null, false);
        }
        execution.complete(serialized, true);
      },
      () => {
        if (!execution.started) return;
        execution.started = false;
        execution.complete(null, false);
      },
    );
  }

  /** The spec's "cancel a pending tool execution". */
  private _cancel(uuid: symbol): void {
    const execution = this._pending.get(uuid);
    if (!execution) return;
    this._pending.delete(uuid);
    queueTask(() => {
      if (!execution.started) return;
      execution.started = false;
      execution.controller.abort();
      this.dispatchEvent(new ToolEvent('toolcancel', execution.toolName));
    });
  }

  private _notifyToolChange(): void {
    queueTask(() => this.dispatchEvent(new Event('toolchange')));
  }

  /** An event handler attribute: one listener, kept in its place however often the handler changes. */
  private _setHandler(type: string, handler: Handler): void {
    const value = typeof handler === 'function' ? handler : null;
    this._handlers[type] = value;
    if (value && !this._listeners[type]) {
      const listener: EventListener = (event) => {
        if (this._handlers[type]?.call(this, event) === false) event.preventDefault();
      };
      this._listeners[type] = listener;
      this.addEventListener(type, listener);
    } else if (!value && this._listeners[type]) {
      this.removeEventListener(type, this._listeners[type]);
      delete this._listeners[type];
    }
  }
}

/**
 * Install a {@link LocalModelContext} on `document` if the page has no registry.
 *
 * Never replaces an existing provider, which owns the page's own action tools.
 *
 * @returns The page's registry, whether pre-existing or newly installed.
 */
export function ensureModelContext(): ModelContext {
  const existing = document.modelContext ?? navigator.modelContext ?? null;
  if (existing) return existing;
  const local = new LocalModelContext();
  document.modelContext = local;
  return local;
}
