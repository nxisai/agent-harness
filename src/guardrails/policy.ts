/**
 * The guardrails policy document: `@nxisai/agent-harness/policy`, for model proxies and custom engines. The
 * document, its reading and its tighten-only merge are in `policy-core.ts`; this adds what a proxy needs besides,
 * from the same source as the page: the presets' numbers, the list check, and what a secret looks like.
 *
 * @module
 */
import { settingsFor } from './defaults.js';
import { glob } from './tools.js';
import { tightenWith, type BrowserPolicy, type GuardrailsPolicy } from './policy-core.js';
import type { GuardrailsConfig } from './types.js';

export {
  POLICY_SCHEMA,
  PROTECTED_RULES,
  PolicyError,
  browserCopy,
  parsePolicy,
  type BrowserPolicy,
  type GuardrailsPolicy,
} from './policy-core.js';
export { STANDARD, STRICT, settingsFor, type Settings } from './defaults.js';
export { listed } from './tools.js';
export { SECRET, hasSecret } from './patterns.js';

/**
 * The page's configuration with a policy merged over it, tighten-only. The page's own object isn't changed.
 *
 * - Numbers: the lower of the page's (its preset's, when it set none) and the policy's.
 * - `preset`: strict when either says so.
 * - `tools.deny`: both lists. `tools.allow`: only what both allow.
 * - `tools.tier`: a floor, as the `policy/tier` rule; where the page's tier is higher, the page's stands.
 * - `output.linkOrigins`: narrows the origins links open in without asking (the page's own origin always may).
 * - `overrides`: the page's and the policy's, but never the `PROTECTED_RULES`.
 * - `lockdown`: the stricter of the page's lock and the policy's.
 *
 * `model`, `conversation` and `systemPrompt` are the proxy's to enforce; they don't change the page's settings.
 */
export const tighten = (page: GuardrailsConfig, policy: GuardrailsPolicy | BrowserPolicy): GuardrailsConfig =>
  tightenWith(page, policy, { settingsFor, glob });
