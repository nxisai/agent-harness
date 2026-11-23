/**
 * Shared types: the WebMCP surface (`document.modelContext`), MCP discovery
 * (catalogs and server cards), and the model and tool-call shapes.
 *
 * @module
 */

// ── WebMCP (W3C draft ModelContext API) ──────────────────────────────────────

/** A JSON Schema fragment, as carried by a tool's input schema. */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  format?: string;
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}

/** Behavioural hints a tool declares about itself. */
export interface ModelContextToolAnnotations {
  /** True when calling the tool has no side effects. Drives {@link policyFor}. */
  readOnlyHint?: boolean;
  [key: string]: unknown;
}

/** One block of a tool response. */
export interface ModelContextContent {
  /** The block's kind, commonly `'text'`. */
  type: string;
  /** The block's text, when it has one. */
  text?: string;
  [key: string]: unknown;
}

/** What a tool returns. */
export interface ModelContextToolResponse {
  /** The response blocks, in order. */
  content: ModelContextContent[];
  /** True when the tool reports a failure. */
  isError?: boolean;
  /** A parsed form of the response, preferred over the text when present. */
  structuredContent?: Record<string, unknown>;
}

/**
 * A tool as reported by `getTools()`.
 *
 * Implementations differ over where the schema lives and whether it arrives
 * parsed or as a JSON string, so several keys are accepted. Use
 * {@link toolSchema} to read it rather than these fields directly.
 */
export interface ModelContextToolInfo {
  /** The tool's unique name, as used to call it. */
  name: string;
  /** What the tool does, shown to the model. */
  description?: string;
  /** The input schema. See also the aliases below. */
  inputSchema?: JsonSchema | string;
  /** Alias for {@link ModelContextToolInfo.inputSchema}. */
  input_schema?: JsonSchema | string;
  /** Alias for {@link ModelContextToolInfo.inputSchema}. */
  parameters?: JsonSchema | string;
  /** Alias for {@link ModelContextToolInfo.inputSchema}. */
  schema?: JsonSchema | string;
  /** Behavioural hints, notably `readOnlyHint`. */
  annotations?: ModelContextToolAnnotations;
  /** Where the tool came from, when the registry records it. */
  origin?: string;
}

/** A tool as passed to `registerTool()`. */
export interface ModelContextTool {
  /** The tool's unique name. */
  name: string;
  /** A human-readable name. `getTools` reports `""` when absent. */
  title?: string;
  /** What the tool does, shown to the model. */
  description?: string;
  /** The parsed input schema. */
  inputSchema?: JsonSchema;
  /** Behavioural hints, notably `readOnlyHint`. */
  annotations?: ModelContextToolAnnotations;
  /** Called to run the tool. */
  execute(
    input: Record<string, unknown>,
    context?: unknown,
  ): ModelContextToolResponse | Promise<ModelContextToolResponse>;
}

/**
 * The page's model context, per the W3C draft ModelContext API.
 *
 * Emits `toolchange` when the set of registered tools changes.
 */
export interface ModelContext extends EventTarget {
  /**
   * Add a tool to the page's registry.
   *
   * Native implementations may return a promise, which rejects on a duplicate
   * name; the polyfill returns nothing and replaces the existing tool.
   */
  registerTool(tool: ModelContextTool, options?: unknown): void | Promise<void>;
  /** Supply page context to the registry, where the implementation supports it. */
  provideContext?(context?: unknown): void;
  /** Call a tool, by registered object or by name. */
  executeTool(
    nameOrTool: string | object,
    input?: string | Record<string, unknown> | null,
    options?: unknown,
  ): Promise<ModelContextToolResponse>;
  /** Every tool currently registered on the page. */
  getTools(options?: unknown): Promise<ModelContextToolInfo[]>;
}

// ── MCP discovery (.well-known catalogs, then a server card) ─────────────────

/** One entry in a discovery catalog. */
export interface CatalogEntry {
  identifier?: string;
  displayName?: string;
  mediaType?: string;
  type?: string;
  url?: string;
}

/** A `.well-known` discovery catalog. */
export interface CatalogFile {
  /** The catalog spec version the file claims. */
  specVersion?: string;
  /** The catalog's entries. */
  entries?: CatalogEntry[];
}

/** A header a remote expects on each request, such as an API key. */
export interface ServerCardRemoteHeader {
  name: string;
  description?: string;
  isSecret?: boolean;
  isRequired?: boolean;
  format?: string;
}

/** One way of reaching an MCP server. */
export interface ServerCardRemote {
  type?: string;
  url?: string;
  headers?: ServerCardRemoteHeader[];
  supportedProtocolVersions?: string[];
}

/** An MCP server's published description. */
export interface ServerCard {
  name?: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
  remotes?: ServerCardRemote[];
  _meta?: Record<string, unknown>;
}

/** The connection details an MCP client needs, distilled from a server card. */
export interface McpServerInfo {
  /** The server's Streamable HTTP endpoint. */
  endpoint: string;
  /** Header carrying the API key, when one is required. */
  authHeaderName?: string;
  /** Whether calls need an API key. */
  authRequired: boolean;
  /** Tools callable without authentication. */
  publicTools: string[];
  /** Protocol versions the server accepts. */
  protocolVersions: string[];
  /** Where the card was fetched from. */
  cardUrl: string;
  /** The server's display title. */
  title?: string;
}

// ── Page config ──────────────────────────────────────────────────────────────

/** The `window.__NXIS_CONFIG__` global, when the host page defines one. */
export interface NxisConfig {
  /** Organisation identifier. */
  org_id?: string;
  /** Site identifier. */
  site_id?: string;
  /** Subscription identifier. */
  sub_id?: string;
  /** WebMCP settings for the page. */
  webmcp?: { mode?: string };
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
  interface Window {
    __NXIS_CONFIG__?: NxisConfig;
  }
}

// ── Model and tool-call shapes ───────────────────────────────────────────────


/** One message in a conversation. */
export interface ChatMessage {
  /** Who produced the message. */
  role: 'system' | 'user' | 'assistant';
  /** The message text. */
  content: string;
  /**
   * Untrusted text this message carries: a tool's result, a remote agent's note, a session error, or (on the system
   * message) the visitor's saved profile. The model reads it only inside a delimited data block after `content`,
   * drawn by the guardrails on the copy they send; the transcript keeps it apart, as it came.
   */
  data?: string;
}

/** A tool definition in the form a chat template expects. */
export interface ToolDef {
  /** Always `'function'`. */
  type: 'function';
  /** The callable's name, description and parameter schema. */
  function: { name: string; description?: string; parameters: JsonSchema };
}

/** A tool call the model asked for. */
export interface ParsedToolCall {
  /** The tool's name. */
  name: string;
  /** The arguments, as supplied by the model. */
  args: Record<string, unknown>;
}

/** Token counts for one generation. */
export interface GenerationUsage {
  /** Tokens in the prompt, including tools and history. */
  promptTokens: number;
  /** Tokens generated. */
  outputTokens: number;
}

/**
 * Byte counts behind a load percentage.
 *
 * `total` covers only the files announced so far and grows as further shards
 * register, which is why progress is reported per stage and left unclamped.
 */
export interface ProgressDetail {
  /** Bytes received so far in this stage. */
  loaded: number;
  /** Bytes expected, across the files announced so far. */
  total: number;
}

/** How eagerly to fetch model weights. */
export type PreloadMode = 'eager' | 'idle' | 'none';
