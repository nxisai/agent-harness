/**
 * Registers a remote MCP server's tools as WebMCP tools on the page.
 *
 * Each registered tool proxies to the connected client's `tools/call` and maps
 * the result back to a WebMCP response, so the agent sees one unified toolset
 * and treats remote and on-page tools alike.
 *
 * Remote schemas are often deeply nested, which small on-device models fill
 * unreliably. Known read tools are therefore registered with a flattened schema
 * that is expanded back to the server's shape before the call. Tools without a
 * mapping keep their native schema.
 *
 * @module
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { isRateLimited, retryAfterMs, withRetry } from './retry.js';
import { TRACK_TOOL } from './report.js';
import { toolOrigins } from '../policy.js';
import type {
  JsonSchema,
  McpServerInfo,
  ModelContext,
  ModelContextContent,
} from '../../types.js';

interface RemoteTool {
  name: string;
  /** MCP's display name, when the server gives one. */
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
}

/** A model-friendly override for a known remote tool: the flat schema shown to
 * the agent, plus a mapper expanding those arguments to the server's shape.
 */
interface ToolOverride {
  description: string;
  inputSchema: JsonSchema;
  mapArgs: (input: Record<string, unknown>) => Record<string, unknown>;
  /** Known-safe reads. Asserted here because we define these surfaces. */
  readOnly: true;
  /** Make the call itself, when the tool does more than map its arguments: `call` is one request to the server. */
  run?: (input: Record<string, unknown>, call: (args: Record<string, unknown>) => Promise<CallResult>) => Promise<CallResult>;
}

/** A server's answer to one call, as much of it as the bridge reads. */
export interface CallResult {
  content?: unknown;
  isError?: unknown;
  structuredContent?: unknown;
}

const isSet = (v: unknown): boolean => v != null && String(v).trim() !== '';

/** Simplified surfaces for the public typed-retrieval tools. */
const TOOL_OVERRIDES: Record<string, ToolOverride> = {
  nxis_list_types: {
    description:
      "Lists the schema.org types present in this site's data (with counts), to pick one for nxis_query. " +
      'A step, not an answer: after it, search with nxis_query, then answer from those results.',
    inputSchema: { type: 'object', properties: {} },
    mapArgs: () => ({}),
    readOnly: true,
  },

  nxis_get: {
    description:
      'Fetches one entity by its JSON-LD @id. Only pass an @id copied from an nxis_query result: never build one ' +
      "from a name or a website. To find a record by name, use nxis_query. Returns the full record.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The JSON-LD @id of the entity to fetch.' },
      },
      required: ['id'],
    },
    mapArgs: (i) => ({ id: i.id }),
    readOnly: true,
  },

  nxis_query: {
    description:
      "Searches the site's typed records by schema.org type, with optional natural-language text " +
      '(use it for locations or keywords), numeric or exact filters on any field, and sorting. ' +
      'Call nxis_list_types first to pick a valid type. Reviews of one business or product are records of type ' +
      'Review, filtered by what they review: {"itemReviewed.name": "<its name>"}. ' +
      // The records are the answer; a page's search or filter form only opens a page of them.
      "Use this first for questions that find, list or show things (what's on, events, products, places), " +
      "rather than a page's search or filter form. For a time (\"this weekend\", \"tonight\", \"in July\"), " +
      'search the Event type and set when.',
    inputSchema: {
      type: 'object',
      properties: {
        schema_type: {
          type: 'string',
          description: "schema.org type to search, e.g. 'Electrician', 'LocalBusiness', 'Product'.",
        },
        text: {
          type: 'string',
          // Deliberately generic: this text reaches the model on every site
          // that installs the package, so a concrete example from one
          // deployment would bias the rest.
          description: 'Optional natural-language query — keywords and/or a location.',
        },
        filters: {
          type: 'object',
          // The server takes an array of {path, operator, value} objects,
          // three nested decisions per constraint. A flat object with the
          // comparison written into the value is a shape a small model can
          // reliably produce; it is expanded before the call.
          description:
            'Optional exact or numeric filters, as {field path: value}. ' +
            'Prefix a number with >=, >, <= or < to compare, e.g. ' +
            '{"aggregateRating.ratingValue": ">=4.5"}. A plain value matches exactly, ' +
            'and a list matches any of its entries.',
        },
        sort: {
          type: 'string',
          description:
            'Optional field path to sort by. Prefix with "-" for highest first, e.g. ' +
            '"-aggregateRating.ratingValue".',
        },
        when: {
          type: 'string',
          description:
            'Optional time, for dated records such as events: today, tonight, tomorrow, this weekend, next weekend, ' +
            'this week, next week, this month, next month, or a month such as July. Matches records on in that time.',
        },
        from: { type: 'string', format: 'date', description: 'Optional first day, YYYY-MM-DD, when when is not enough.' },
        to: { type: 'string', format: 'date', description: 'Optional last day, YYYY-MM-DD.' },
        limit: { type: 'integer', description: 'Maximum results to return (1-100).', default: 10 },
      },
      required: ['schema_type'],
    },
    mapArgs: (i) => mapQueryArgs(i),
    readOnly: true,
    // A time asked for loads what reads it: most searches name none.
    run: (i, call) =>
      isSet(i.when) || isSet(i.from) || isSet(i.to)
        ? import('../when.js').then((m) => m.datedQuery(i, call, mapQueryArgs))
        : call(mapQueryArgs(i)),
  },
};

/** Today as the model is told it, on the visitor's clock: `Monday, 2026-11-16`. */
export function todayLine(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.toLocaleDateString('en-US', { weekday: 'long' })}, ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A call the server refused, as a result the model can read: the server's message, and for a record that isn't
 * there, how to find the right one. Not retried: a tool that failed may already have done something.
 */
export function failed(name: string, err: unknown): { content: ModelContextContent[]; isError: true } {
  const message = String((err as Error)?.message ?? err).replace(/^MCP error -?\d+:\s*/, '');
  const hint =
    name === 'nxis_get' && /not.?found/i.test(message)
      ? ' No record has that @id. Find it with nxis_query first and pass the @id from its results.'
      : '';
  return { content: [{ type: 'text', text: `${message}${hint}` }], isError: true };
}

/** Comparison prefixes the model may write into a filter value. */
const COMPARISONS: [string, string][] = [
  ['>=', 'GREATER_THAN_OR_EQUAL'],
  ['<=', 'LESS_THAN_OR_EQUAL'],
  ['>', 'GREATER_THAN'],
  ['<', 'LESS_THAN'],
];

/**
 * Convert one `{path: value}` entry into the server's filter object.
 *
 * Numeric values are coerced, since the comparison operators are numeric on the
 * server while a model writes them inside a string.
 */
export function toFieldFilter(path: string, value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { path, operator: 'IN', value };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    for (const [prefix, operator] of COMPARISONS) {
      if (trimmed.startsWith(prefix)) {
        const rest = trimmed.slice(prefix.length).trim();
        const num = Number(rest);
        return { path, operator, value: Number.isFinite(num) ? num : rest };
      }
    }
    const num = Number(trimmed);
    // An equality written as "4.5" means the number: a string would not match
    // a numeric field.
    return { path, operator: 'EQUALS', value: trimmed !== '' && Number.isFinite(num) ? num : trimmed };
  }
  return { path, operator: 'EQUALS', value };
}

/**
 * Parse a filter object however the model expressed it.
 *
 * Asked for `{"path": "value"}`, models produce a real object, a JSON string,
 * or a JavaScript-like string with unquoted keys. All three mean the same
 * thing, and rejecting any of them would silently drop the constraint and
 * return unfiltered results.
 *
 * @param raw - The value the model supplied.
 * @returns The parsed object, or null when there is nothing to read.
 */
export function parseLooseObject(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  // `path >= value`, written with no braces at all.
  const bare = text.match(/^([\w.\-]+)\s*(>=|<=|>|<|=)\s*(.+)$/);
  if (bare && !text.startsWith('{')) {
    const [, path, op, value] = bare;
    return { [path]: op === '=' ? value.trim() : `${op}${value.trim()}` };
  }
  if (!text.startsWith('{')) return null;

  const attempts = [
    text,
    // Quote bare keys, and normalise single quotes to double.
    text.replace(/([{,]\s*)([A-Za-z_][\w.\-]*)\s*:/g, '$1"$2":').replace(/'/g, '"'),
  ];
  // Last resort: quote bare word values too, as in `{brand: Rheem}`.
  attempts.push(attempts[1].replace(/:\s*([A-Za-z_][\w .\-]*?)\s*([,}])/g, ': "$1"$2'));

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/**
 * Flatten a nested filter object into the dot-paths the schema asks for.
 *
 * Models mirror the shape of the data they saw in the last response, which is
 * nested, so `{aggregateRating: {ratingValue: ">=4.5"}}` becomes
 * `{"aggregateRating.ratingValue": ">=4.5"}`.
 */
export function flattenPaths(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenPaths(value as Record<string, unknown>, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

/** The model's flat arguments, as the server's nested query. */
export function mapQueryArgs(i: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = { schema_type: i.schema_type };

  const filters = parseLooseObject(i.filters);
  if (filters) {
    const fieldFilters = Object.entries(flattenPaths(filters))
      .filter(([path, value]) => path && value !== undefined && value !== null && value !== '')
      .map(([path, value]) => toFieldFilter(path, value));
    if (fieldFilters.length) filter.field_filters = fieldFilters;
  }

  if (isSet(i.sort)) {
    const raw = String(i.sort).trim();
    const descending = raw.startsWith('-');
    filter.sort_option = {
      property: descending ? raw.slice(1) : raw,
      order: descending ? 'DESCENDING' : 'ASCENDING',
    };
  }

  const args: Record<string, unknown> = { filter };
  if (isSet(i.text)) args.text = i.text;
  if (i.limit != null) args.limit = i.limit;
  return args;
}

/**
 * Whether a tool may run without a confirmation step.
 *
 * Fails closed: a tool whose server declares no `readOnlyHint` is treated as a
 * write. The harness runs reads as soon as their arguments are satisfied, so
 * defaulting an unannotated tool to read-only would fire it unattended. Being
 * wrong this way costs one extra confirmation; being wrong the other way sends
 * data on the user's behalf.
 */
function isReadOnly(tool: RemoteTool, override?: ToolOverride): boolean {
  if (override) return override.readOnly;
  const declared = (tool.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint;
  return declared === true;
}

/**
 * List the server's tools, falling back to the tools its card advertises when
 * `tools/list` is unavailable.
 */
async function listRemoteTools(client: Client, info: McpServerInfo): Promise<RemoteTool[]> {
  try {
    const res = await client.listTools();
    return res.tools as unknown as RemoteTool[];
  } catch (err) {
    console.warn('[nxis] tools/list failed; falling back to card publicTools', err);
    return info.publicTools.map((name) => ({ name }));
  }
}

/** The names a registry already holds, or none when it cannot say. */
async function registeredNames(mc: ModelContext): Promise<Set<string>> {
  try {
    return new Set((await mc.getTools()).map((t) => t.name));
  } catch {
    return new Set();
  }
}

/**
 * Tools excluded from the browser agent's toolset by default.
 *
 * `nxis_action` performs a site's write actions server-side, addressed by
 * JSON-LD `@id` and authenticated with an API key. That suits an external MCP
 * client, which has a key and no page, but duplicates the page's own action
 * tools, which are generated from the same Schema.org actions and can show the
 * user what is about to be submitted. Bridging both would offer two routes to
 * the same outcome, and add the excluded tool's schema to every prompt.
 *
 * Override with {@link BridgeOptions.accept}.
 */
const SERVER_ONLY_TOOLS = new Set(['nxis_action', TRACK_TOOL]);

/** Options for {@link registerRemoteTools}. */
export interface BridgeOptions {
  /**
   * Choose which of the server's tools reach the page.
   *
   * Rarely needed: the default excludes only {@link SERVER_ONLY_TOOLS}.
   *
   * @param name - The remote tool's name.
   * @returns True to register it.
   */
  accept?(name: string): boolean;
}

/**
 * Register every accepted remote tool into a model context.
 *
 * Each registered tool proxies execution to `client`, translating arguments
 * from the flattened schema and the result back into a WebMCP response.
 *
 * @param client - The connected MCP client.
 * @param mc - The registry to register into.
 * @param info - The server's connection details.
 * @param options - A tool filter.
 * @returns The names of the tools registered.
 */
export async function registerRemoteTools(
  client: Client,
  mc: ModelContext,
  info: McpServerInfo,
  opts: BridgeOptions = {},
): Promise<string[]> {
  const accept = opts.accept ?? ((name: string) => !SERVER_ONLY_TOOLS.has(name));
  const tools = (await listRemoteTools(client, info)).filter((t) => accept(t.name));
  // A registry rejects a name it already holds (WebMCP: InvalidStateError), and older polyfills
  // replaced it. Skipping names already present behaves the same on every one.
  const present = await registeredNames(mc);
  const registered: string[] = [];

  for (const tool of tools) {
    if (present.has(tool.name)) {
      console.warn(`[nxis] a tool named ${tool.name} is already registered; keeping it`);
      continue;
    }
    const override = TOOL_OVERRIDES[tool.name];

    const registration = {
      name: tool.name,
      // A registry refuses an empty description (WebMCP: InvalidStateError), and one tool the
      // server left undescribed should still be callable.
      // A tool that reads dates is told today's, on the visitor's clock.
      description:
        (override?.description || tool.description || tool.title || tool.name) +
        (override?.run ? ` Today is ${todayLine()}.` : ''),
      // Prefer the simplified schema; otherwise pass the native one through.
      inputSchema: override?.inputSchema ?? tool.inputSchema ?? { type: 'object' },
      // The harness reads this to decide whether to run the tool outright, so
      // it must not be optimistic. See isReadOnly.
      annotations: { ...(tool.annotations ?? {}), readOnlyHint: isReadOnly(tool, override) },
      execute: async (input: Record<string, unknown>) => {
        const args = override ? override.mapArgs(input ?? {}) : (input ?? {});
        const call = (a: Record<string, unknown>) =>
          withRetry(() => client.callTool({ name: tool.name, arguments: a })) as Promise<CallResult>;
        // A read over the site's rate limit is the server asking us to wait, not a failure to
        // report: answering "the site has no data" would be false, and retrying at once makes it
        // worse. Waited out once or twice, then said plainly.
        try {
          const result = override?.run ? await override.run(input ?? {}, call) : await call(args);
          return {
            content: (result.content as ModelContextContent[] | undefined) ?? [],
            isError: result.isError as boolean | undefined,
            structuredContent: result.structuredContent as Record<string, unknown> | undefined,
          };
        } catch (err) {
          // Thrown, the server's own words are lost: a WebMCP registry reports any tool that threw as "the
          // invocation failed", so the model can neither tell the visitor why nor try the right call instead.
          if (!isRateLimited(err)) return failed(tool.name, err);
          const seconds = Math.ceil((retryAfterMs(err) ?? 60_000) / 1000);
          return {
            content: [
              {
                type: 'text',
                text: `This site's records are rate limited right now. They should answer again in about ${seconds} seconds.`,
              },
            ],
            isError: true,
          };
        }
      },
    };
    // A registry rejects (the spec), throws or returns nothing (older ones). Awaiting covers all
    // three, and one tool the registry refuses should not cost the rest.
    try {
      await mc.registerTool(registration);
    } catch (err) {
      console.warn(`[nxis] could not register ${tool.name}:`, err);
      continue;
    }
    toolOrigins.set(tool.name, 'mcp');
    registered.push(tool.name);
  }

  return registered;
}
