/**
 * Tool policy: whether a resolved tool call runs immediately or waits for a
 * human confirmation.
 *
 * The decision comes from the tool's own `readOnlyHint` annotation, so a tool
 * source that annotates its tools correctly gets the right behaviour with no
 * further configuration.
 *
 * @module
 */

import type { ModelContextToolInfo } from '../types.js';

/**
 * Where the tools the harness registered came from, by name: a remote MCP server (`mcp`) or the site's own data
 * (`site`, the actions on its other pages). Anything not here was registered by the page itself. The guardrails read it
 * for a tool's risk tier and its data blocks: a registry may drop annotations it doesn't know, so it's kept apart.
 */
export const toolOrigins = new Map<string, 'mcp' | 'site'>();

/** What the harness should do once arguments are resolved. */
export type Decision =
  /** Run it now, with no interstitial UI. */
  | 'execute'
  /** Ask for the missing values, then run without a further confirmation. */
  | 'ask'
  /** Nothing is missing, but a human still presses Submit. */
  | 'confirm';

/** How a single tool should be treated once its arguments are known. */
export interface ToolPolicy {
  /** Taken from `annotations.readOnlyHint`. Read-only tools never write. */
  readOnly: boolean;
  /**
   * Whether a call with no missing values still needs a human press.
   *
   * True for writes, whose effects reach a real system and cannot be undone by
   * the harness. The confirmation displays the values read-only: nothing is
   * missing, so there is nothing to edit.
   */
  confirmWhenSatisfied: boolean;
}

/**
 * Derive a tool's policy from its annotations.
 *
 * @param tool - The tool as reported by the tool source.
 * @returns The policy the harness applies to calls of this tool.
 */
export function policyFor(tool: ModelContextToolInfo): ToolPolicy {
  const readOnly = !!tool.annotations?.readOnlyHint;
  return { readOnly, confirmWhenSatisfied: !readOnly };
}

/**
 * Resolve the decision from a tool's policy and what is still unknown.
 *
 * @param policy - The policy for the tool being called.
 * @param gapCount - How many required values are still missing.
 * @returns `'ask'` when anything is missing, otherwise `'confirm'` for writes
 * and `'execute'` for reads.
 */
export function decide(policy: ToolPolicy, gapCount: number): Decision {
  if (gapCount > 0) return 'ask';
  return policy.confirmWhenSatisfied ? 'confirm' : 'execute';
}
