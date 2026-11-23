/**
 * Shapes shared by the server and its adapters.
 *
 * Types only — this module exists so the JSDoc in the adapters can reference
 * one definition instead of restating the contract four times.
 *
 * @module
 */

/**
 * A turn as `createProxyProvider` sends it.
 *
 * @typedef {object} WireMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * A tool as the harness sends it: already normalised to `inputSchema`, whatever
 * key WebMCP used on the page.
 *
 * @typedef {object} WireTool
 * @property {string} name
 * @property {string} [description]
 * @property {Record<string, unknown>} [inputSchema]
 */

/**
 * What an adapter returns. The first four fields are the contract; `meta` is
 * for the transcript and never reaches the page.
 *
 * @typedef {object} Completion
 * @property {string} text
 * @property {{ name: string, args: Record<string, unknown> }} [call]
 * @property {{ promptTokens: number, outputTokens: number }} [usage]
 * @property {string} [model]
 * @property {Record<string, unknown>} [meta]
 */

export {};
