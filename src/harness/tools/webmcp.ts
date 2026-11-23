/**
 * Tool discovery and execution over WebMCP.
 *
 * Discovery and execution work the same way whichever model is answering, so
 * they sit with the harness rather than behind {@link ModelProvider}.
 *
 * @module
 */
import { TOOLS_TIMEOUT_MS } from '../../engine.js';
import { reportSubmitted } from './report.js';
import type {
  ModelContext,
  ModelContextToolInfo,
  ModelContextToolResponse,
} from '../../types.js';

/**
 * The default tool source, backed by the page's `document.modelContext`.
 *
 * Supply an instance as {@link HarnessOptions.toolSource}, or substitute any
 * object with the same shape to draw tools from somewhere else.
 */
export class WebMcpTools {
  /**
   * The page's model context.
   *
   * @returns The context, or null on a page where WebMCP is not present.
   */
  modelContext(): ModelContext | null {
    return document.modelContext || navigator.modelContext || null;
  }

  /**
   * Wait for tools to appear on a model context.
   *
   * Tools register asynchronously, so a context can be present but empty for a
   * short time after page load. Polls, and also listens for `toolchange`.
   *
   * @param mc - The context to watch.
   * @param signal - Abort to stop waiting early. Resolves empty when aborted.
   * @returns The registered tools, or an empty array if none appear within
   * {@link TOOLS_TIMEOUT_MS}.
   */
  waitForTools(mc: ModelContext, signal?: AbortSignal): Promise<ModelContextToolInfo[]> {
    return new Promise((resolve) => {
      let done = false;
      const finish = async (tools?: ModelContextToolInfo[]) => {
        if (done) return;
        done = true;
        clearInterval(iv);
        clearTimeout(to);
        mc.removeEventListener('toolchange', onChange);
        signal?.removeEventListener('abort', onAbort);
        resolve(tools || (await mc.getTools()));
      };
      const onAbort = () => finish([]);
      if (signal?.aborted) return finish([]);
      signal?.addEventListener('abort', onAbort, { once: true });
      const check = async () => {
        const tools = await mc.getTools();
        if (tools && tools.length) finish(tools);
      };
      const onChange = () => check();
      mc.addEventListener('toolchange', onChange);
      const iv = setInterval(check, 800);
      const to = setTimeout(() => finish(), TOOLS_TIMEOUT_MS);
      check();
    });
  }

  /**
   * Every tool registered on the page.
   *
   * @param signal - Abort to stop waiting for tools to appear.
   * @returns The registered tools, or an empty array when WebMCP is absent,
   * discovery fails, or the wait is aborted.
   */
  async discoverTools(signal?: AbortSignal): Promise<ModelContextToolInfo[]> {
    const mc = this.modelContext();
    if (!mc) return [];
    try {
      return await this.waitForTools(mc, signal);
    } catch {
      return [];
    }
  }

  /**
   * Call a tool.
   *
   * Handles each runtime's calling convention — see {@link executeRegistered} —
   * trying the spec's form first and falling back when the context rejects it.
   *
   * @param toolObj - The tool as reported by discovery, or null to call by name.
   * @param name - The tool's name, used for the fallback call.
   * @param args - The arguments to send.
   * @returns The tool's response.
   * @throws If WebMCP is not available, or the tool itself throws.
   */
  async execTool(
    toolObj: ModelContextToolInfo | null,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ModelContextToolResponse> {
    const mc = this.modelContext();
    if (!mc) throw new Error('WebMCP is not available on this page.');
    return executeRegistered(mc, toolObj, name, args);
  }
}

/**
 * A registry refusing the SHAPE of a call, as opposed to the tool failing.
 *
 * Every message here was measured to come back before the tool's own code ran,
 * which is what makes trying another form safe. Chrome 153 refuses an object
 * input with "Failed to parse input arguments" having run nothing; a tool that
 * ran and threw says "Tool was executed but the invocation failed", which is
 * deliberately not here — it may already have done something.
 */
const REFUSED_SHAPE =
  /RegisteredTool|not of type|not an object|invalid input|Failed to parse input arguments|arguments required|No tool registered|NotFound/i;

/**
 * Call a registered tool the way the runtime in front of us accepts.
 *
 * Runtimes disagree, and each refuses the others' forms. Measured:
 *
 * - Chrome 155 (Beta), and the WebMCP spec: the registered tool object and an
 *   arguments *object*. A JSON string is refused ("invalid input object: value
 *   is not an object"), and so is a name ("not of type 'RegisteredTool'").
 * - Chrome 153 (stable): the tool object and a JSON *string*, required. An
 *   object is refused, before the tool runs, with "Failed to parse input
 *   arguments".
 * - Older polyfills (`@nxisai/webmcp` 0.1) took a name. Today's, and the
 *   harness's own registry, follow the spec.
 *
 * So: object, then string, then name — each tried only when the one before was
 * refused for its shape. A tool that ran and failed is reported as it failed,
 * never retried in another form, since it may already have done something.
 *
 * @returns The tool's response as an object, whichever runtime answered — see
 * {@link asResponse}.
 */
export async function executeRegistered(
  mc: ModelContext,
  toolObj: ModelContextToolInfo | null,
  name: string,
  args: Record<string, unknown>,
): Promise<ModelContextToolResponse> {
  const input = args ?? {};
  const attempts: (() => Promise<ModelContextToolResponse>)[] = [
    ...(toolObj
      ? [
          () => mc.executeTool(toolObj as unknown as object, input),
          () => mc.executeTool(toolObj as unknown as object, JSON.stringify(input)),
        ]
      : []),
    () => mc.executeTool(name, input),
  ];
  let refused: unknown;
  for (const attempt of attempts) {
    try {
      const res = asResponse(await attempt());
      // Every page form runs through here, whichever way it was reached: the one place to count it.
      reportSubmitted(toolObj, name, res);
      return res;
    } catch (err) {
      if (!REFUSED_SHAPE.test(String((err as Error)?.message || err))) throw err;
      refused = err;
    }
  }
  throw refused;
}

/**
 * Whatever a registry returned, as the response object the tool produced.
 *
 * The spec's `executeTool` resolves with a string — the tool's result
 * serialized — and native Chrome does exactly that. Read as text, a tool that
 * reported `isError` looks like a success and its `structuredContent` is gone:
 * a form that refused the input would be shown as sent. Parsing it back here,
 * once, gives every caller the same object whichever runtime answered.
 *
 * A tool that returned text comes back as that text. Under the spec every
 * result is JSON, so text arrives quoted (`"\"Done\""`); Chrome 155 passes it
 * unquoted, and `"undefined"` for a tool that returned nothing. Both read the
 * same here.
 */
export function asResponse(raw: unknown): ModelContextToolResponse {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as ModelContextToolResponse;
  if (typeof raw !== 'string') return { content: raw === undefined ? [] : [{ type: 'text', text: String(raw) }] };
  const trimmed = raw.trim();
  if (trimmed === 'undefined' || trimmed === '') return { content: [] };
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'string') return { content: parsed ? [{ type: 'text', text: parsed }] : [] };
      if (parsed && Array.isArray((parsed as ModelContextToolResponse).content)) return parsed as ModelContextToolResponse;
    } catch {
      // Not JSON; the tool's own text.
    }
  }
  return { content: [{ type: 'text', text: raw }] };
}
