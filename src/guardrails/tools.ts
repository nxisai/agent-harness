/**
 * The tool stage's pure parts: risk tiers, the allow and deny lists, and the key an approval is bound to.
 *
 * OWASP AI Agent Security Cheat Sheet, "Least privilege" and "Human in the loop": a tier is assigned by code from
 * what the tool is and where it came from, never by the model, and fails closed. A tool that says nothing about
 * itself is treated as a write.
 *
 * @module
 */
import type { ModelContextToolInfo } from '../types.js';
import type { ToolOrigin } from './context.js';
import type { RiskTier, ToolGuardrails } from './types.js';

/** A name pattern, `*` matching anything, as a test. */
export function glob(pattern: string): (name: string) => boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return (name) => re.test(name);
}

/** Whether a name matches any of the patterns. */
export const matches = (name: string, patterns: string[] | undefined): boolean => !!patterns?.some((p) => glob(p)(name));

/** Whether the host's lists let a tool be offered and run: deny wins, then an allowlist when there is one. */
export function listed(name: string, cfg: ToolGuardrails | undefined): boolean {
  if (matches(name, cfg?.deny)) return false;
  return !cfg?.allow || matches(name, cfg.allow);
}

/**
 * A payment or an account change, by the words in a write's name: `checkout`, `refund`, `delete_account`,
 * `update_password`. Reads are left alone (`order_status` reads an order, it doesn't place one).
 */
const MONEY_OR_ACCOUNT =
  /(?:^|[_.\-\s])(?:pay|payment|payments|checkout|purchase|buy|order|refund|charge|billing|invoice|transfer|withdraw|account|password|credentials?|delete|erase|close)(?:$|[_.\-\s])/i;

const TIERS: RiskTier[] = ['low', 'medium', 'high', 'critical'];

/**
 * A tool's risk tier, by code.
 *
 * - The host's own tier for it (`tools.tier`), when set; but never below `high` for a tool that would be
 *   `critical`, so a destructive, consequential, payment or account tool is always confirmed.
 * - `destructiveHint` or `consequentialHint`, or a write that pays or changes an account: `critical`.
 * - `readOnlyHint: true`: `low` from the page's own registry, `medium` from a remote MCP server or the site, or
 *   when it declares `untrustedContentHint`.
 * - Anything else, a write, an unannotated tool or one we know nothing about: `high`.
 *
 * @throws When the host's tier for it is not a tier: a policy that can't be resolved fails closed.
 */
export function tierOf(tool: ModelContextToolInfo, origin: ToolOrigin, cfg: ToolGuardrails | undefined): RiskTier {
  const a = tool.annotations ?? {};
  const own: RiskTier =
    a.destructiveHint === true || a.consequentialHint === true
      ? 'critical'
      : a.readOnlyHint === true
        ? origin === 'page' && a.untrustedContentHint !== true
          ? 'low'
          : 'medium'
        : MONEY_OR_ACCOUNT.test(tool.name)
          ? 'critical'
          : 'high';
  const host = Object.entries(cfg?.tier ?? {}).find(([p]) => glob(p)(tool.name));
  if (!host) return own;
  if (!TIERS.includes(host[1])) throw new Error(`"${String(host[1])}" is not a risk tier`);
  // The floor: a destructive, consequential, payment or account tool is always confirmed.
  return own === 'critical' && TIERS.indexOf(host[1]) < 2 ? 'high' : host[1];
}

/** A value with its keys sorted, strings trimmed, and empty values left out: what two equal calls share. */
function normal(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((v) => normal(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined || v === null || v === '') continue;
      out[k] = normal(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The key an approval is bound to: the tool and its normalised arguments. The conversation is the map it's kept
 * in. Kept whole rather than hashed: it never leaves memory, and an exact match can't collide.
 */
export const callKey = (name: string, values: Record<string, unknown>): string => `${name}\u0000${JSON.stringify(normal(values ?? {}))}`;
