/**
 * The guardrails policy document: a versioned, declarative JSON copy of what a site's guardrails enforce, kept with
 * the site's own model proxy so it can change without a deploy.
 *
 * The proxy enforces it on every request. The page reads a copy (`guardrails-src` on the element) that leaves out
 * the system prompt, and merges it over its own configuration **tighten-only** with {@link tighten}: a policy can
 * lower a limit, add to the deny list, narrow the allowlist and the link origins, raise a tool's tier, switch on the
 * strict preset or the kill switch, and turn off what a host could already turn off in code. It can never raise a
 * limit above the page's, lower a tier, lift the page's own lockdown, or touch the checks that can't be turned off.
 *
 * Code rules and classifiers are not part of the document: they stay in the page, or run in the proxy.
 *
 * Pure: no DOM, no network. The element loads this in the lazy chunk that fetches the copy; `policy.ts`, exported as
 * `@nxisai/agent-harness/policy`, is what proxies and custom engines import.
 *
 * @module
 */
import type { Settings } from './defaults.js';
import type { GuardrailRule, GuardrailsConfig, RiskTier } from './types.js';

/** What the merge reads the page's numbers and matches names with: `settingsFor` and `glob`, passed in. */
export interface MergeKit {
  settingsFor(config: GuardrailsConfig): Settings;
  glob(pattern: string): (name: string) => boolean;
}

/** The document's schema. A copy with another one is refused, and the built-in defaults apply. */
export const POLICY_SCHEMA = 1;

/** The checks no policy and no override can turn off. */
export const PROTECTED_RULES = ['tool/tier', 'tool/approval', 'tool/policy', 'tool/lockdown', 'input/lockdown', 'tool/not-listed'] as const;

/** The policy document, as the proxy holds it. Every field but `schema` and `version` is optional. */
export interface GuardrailsPolicy {
  /** Always 1 for this shape. */
  schema: 1;
  /** Any string that changes when the policy does: `"2026-11-10.1"`. Sent back by the page to ask if it's current. */
  version: string;
  /** `'strict'` switches the strict preset on. `'standard'` never switches it off. */
  preset?: 'standard' | 'strict';
  /** Visitor messages. */
  input?: { maxLength?: number; sendsPerMinute?: number };
  /** Tools: lists, tiers and limits. A tool not on `allow`, or on `deny`, is refused at the proxy and in the page. */
  tools?: {
    allow?: string[];
    deny?: string[];
    /** A floor per tool (`*` matches anything): where the page's tier is lower, this one applies. */
    tier?: Record<string, RiskTier>;
    maxPerTurn?: number;
    perMinute?: number;
    timeoutMs?: number;
  };
  /** Per turn, enforced at the proxy: generations, and output tokens. */
  model?: { maxSteps?: number; maxTokens?: number };
  /** Per conversation, enforced at the proxy: generations and output tokens over the conversation's life. */
  conversation?: { maxGenerations?: number; maxOutputTokens?: number };
  /** Replies and links. `linkOrigins` narrows where links open without asking; it never adds an origin. */
  output?: { maxLength?: number; linkOrigins?: string[] };
  /** Built-in rules turned off, as a host could in code. The checks in {@link PROTECTED_RULES} are ignored. */
  overrides?: Record<string, 'off'>;
  /** The kill switch, enforced by the proxy even when the page is unreachable. `null` or absent: not locked. */
  lockdown?: { scope: 'tools' | 'agent'; reason: string } | null;
  /** A system prompt the proxy holds and uses instead of the page's. Never served to the browser. */
  systemPrompt?: string;
}

/** The copy the proxy serves to the page: the document without its system prompt, saying whether it holds one. */
export type BrowserPolicy = Omit<GuardrailsPolicy, 'systemPrompt'> & {
  /** `'proxy'` when the proxy holds the system prompt: the page then sends none. */
  prompt?: 'proxy';
};

/** A document that isn't one. Its message names the field, never its value. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

const TIERS: readonly RiskTier[] = ['low', 'medium', 'high', 'critical'];
const rank = (t: RiskTier | undefined): number => (t ? TIERS.indexOf(t) : -1);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read a policy document, or the page's copy of one.
 *
 * Fields it doesn't know are dropped, so a newer proxy's document still reads; a field it knows with the wrong
 * shape refuses the whole document, so nothing half-read applies.
 *
 * @throws {PolicyError} When it isn't a policy of {@link POLICY_SCHEMA}.
 */
export function parsePolicy(input: unknown): GuardrailsPolicy & BrowserPolicy {
  const doc = typeof input === 'string' ? safeJson(input) : input;
  if (!isObj(doc)) throw new PolicyError('a policy is a JSON object');
  if (doc.schema !== POLICY_SCHEMA) throw new PolicyError(`schema must be ${POLICY_SCHEMA}`);
  if (typeof doc.version !== 'string' || !doc.version.trim() || doc.version.length > 64) {
    throw new PolicyError('version must be a string of 1 to 64 characters');
  }
  const out: GuardrailsPolicy & BrowserPolicy = { schema: 1, version: doc.version.trim() };
  if (doc.preset !== undefined) {
    if (doc.preset !== 'standard' && doc.preset !== 'strict') throw new PolicyError('preset must be "standard" or "strict"');
    out.preset = doc.preset;
  }
  const numbers = (key: string, names: string[]): Record<string, number> | undefined => {
    const v = doc[key];
    if (v === undefined) return undefined;
    if (!isObj(v)) throw new PolicyError(`${key} must be an object`);
    const o: Record<string, number> = {};
    for (const n of names) {
      if (v[n] === undefined) continue;
      if (typeof v[n] !== 'number' || !Number.isFinite(v[n]) || (v[n] as number) <= 0) throw new PolicyError(`${key}.${n} must be a positive number`);
      o[n] = v[n] as number;
    }
    return o;
  };
  const names = (path: string, v: unknown): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > 500 || v.some((s) => typeof s !== 'string' || !s || s.length > 200)) {
      throw new PolicyError(`${path} must be a list of names`);
    }
    return v as string[];
  };
  const input_ = numbers('input', ['maxLength', 'sendsPerMinute']);
  if (input_) out.input = input_;
  const model = numbers('model', ['maxSteps', 'maxTokens']);
  if (model) out.model = model;
  const conversation = numbers('conversation', ['maxGenerations', 'maxOutputTokens']);
  if (conversation) out.conversation = conversation;
  if (doc.tools !== undefined) {
    const tools: NonNullable<GuardrailsPolicy['tools']> = numbers('tools', ['maxPerTurn', 'perMinute', 'timeoutMs']) ?? {};
    const t = doc.tools as Record<string, unknown>;
    const allow = names('tools.allow', t.allow);
    const deny = names('tools.deny', t.deny);
    if (allow) tools.allow = allow;
    if (deny) tools.deny = deny;
    if (t.tier !== undefined) {
      if (!isObj(t.tier)) throw new PolicyError('tools.tier must be an object');
      for (const tier of Object.values(t.tier)) if (!TIERS.includes(tier as RiskTier)) throw new PolicyError('tools.tier values must be risk tiers');
      tools.tier = { ...(t.tier as Record<string, RiskTier>) };
    }
    out.tools = tools;
  }
  if (doc.output !== undefined) {
    const output: NonNullable<GuardrailsPolicy['output']> = numbers('output', ['maxLength']) ?? {};
    const origins = names('output.linkOrigins', (doc.output as Record<string, unknown>).linkOrigins);
    if (origins) output.linkOrigins = origins;
    out.output = output;
  }
  if (doc.overrides !== undefined) {
    if (!isObj(doc.overrides)) throw new PolicyError('overrides must be an object');
    // Only 'off' turns a rule off; anything else is no override at all.
    out.overrides = Object.fromEntries(Object.entries(doc.overrides).filter(([, v]) => v === 'off')) as Record<string, 'off'>;
  }
  if (doc.lockdown != null) {
    const l = doc.lockdown as Record<string, unknown>;
    if (!isObj(l) || (l.scope !== 'tools' && l.scope !== 'agent')) throw new PolicyError('lockdown.scope must be "tools" or "agent"');
    out.lockdown = { scope: l.scope, reason: typeof l.reason === 'string' ? l.reason.slice(0, 200) : 'policy' };
  }
  if (doc.systemPrompt !== undefined) {
    if (typeof doc.systemPrompt !== 'string' || !doc.systemPrompt.trim()) throw new PolicyError('systemPrompt must be a non-empty string');
    out.systemPrompt = doc.systemPrompt;
  }
  if (doc.prompt === 'proxy') out.prompt = 'proxy';
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PolicyError('a policy is a JSON object');
  }
}

/** The copy the page may read: without the system prompt, saying whether the proxy holds one. */
export function browserCopy(policy: GuardrailsPolicy): BrowserPolicy {
  const { systemPrompt, ...rest } = policy;
  return systemPrompt ? { ...rest, prompt: 'proxy' } : rest;
}

/** The smaller of what is in force and what the policy asks for. */
const lower = (current: number, asked: number | undefined): number => (asked === undefined ? current : Math.min(current, asked));

/**
 * Two allowlists, as one: a name passes only when both let it. Each entry of one that the other covers is kept;
 * two patterns that only overlap (`a*` and `*b`) drop out, which is stricter, never looser.
 */
function bothAllow(page: string[] | undefined, policy: string[] | undefined, glob: MergeKit['glob']): string[] | undefined {
  if (!page) return policy && [...policy];
  if (!policy) return page;
  const out = new Set<string>();
  for (const p of page) for (const q of policy) {
    if (glob(q)(p)) out.add(p);
    else if (glob(p)(q)) out.add(q);
  }
  return [...out];
}

/** The stricter lock: `agent` over `tools` over none. The page's own lock is never lifted. */
function stricterLock(page: GuardrailsConfig['locked'], policy: GuardrailsPolicy['lockdown']): GuardrailsConfig['locked'] {
  if (!policy) return page;
  if (!page || (page.scope === 'tools' && policy.scope === 'agent')) return { ...policy };
  return page;
}

/**
 * The policy's tiers, as a rule: where the policy's tier for a tool is higher than the page's, a `high` or `critical`
 * one asks for the visitor's confirmation (and the bound approval with it), and a `medium` one is flagged, or
 * confirmed in strict. Where the page's is as high or higher, it stands. A rule can only tighten.
 */
function tierRule(tiers: Record<string, RiskTier>, strict: boolean, glob: MergeKit['glob']): GuardrailRule {
  const entries = Object.entries(tiers).map(([p, t]) => [glob(p), t] as const);
  return {
    id: 'policy/tier',
    stage: 'tool',
    check: ({ tool, tier }) => {
      const want = entries.find(([m]) => m(tool ?? ''))?.[1];
      if (rank(want) <= rank(tier)) return { action: 'allow' };
      return { action: rank(want) >= 2 || strict ? 'confirm' : 'flag' };
    },
  };
}

/**
 * {@link tighten}, given what it reads the numbers and matches names with (so the lazily loaded copy can share the
 * guardrails' own, rather than a second copy of them).
 *
 * The page's configuration with a policy merged over it, tighten-only. The page's own object isn't changed.
 *
 * - Numbers: the lower of the page's (its preset's, when it set none) and the policy's.
 * - `preset`: strict when either says so.
 * - `tools.deny`: both lists. `tools.allow`: only what both allow.
 * - `tools.tier`: a floor, as the `policy/tier` rule; where the page's tier is higher, the page's stands.
 * - `output.linkOrigins`: narrows the origins links open in without asking (the page's own origin always may).
 * - `overrides`: the page's and the policy's, but never the {@link PROTECTED_RULES}.
 * - `lockdown`: the stricter of the page's lock and the policy's.
 *
 * `model`, `conversation` and `systemPrompt` are the proxy's to enforce; they don't change the page's settings.
 */
export function tightenWith(page: GuardrailsConfig, policy: GuardrailsPolicy | BrowserPolicy, { settingsFor, glob }: MergeKit): GuardrailsConfig {
  const strict = page.preset === 'strict' || policy.preset === 'strict';
  const s = settingsFor({ ...page, preset: strict ? 'strict' : 'standard' });
  const pt = policy.tools ?? {};
  const t = page.tools ?? {};
  const out: GuardrailsConfig = {
    ...page,
    preset: strict ? 'strict' : page.preset ?? policy.preset,
    input: {
      ...page.input,
      maxLength: lower(s.input.maxLength, policy.input?.maxLength),
      sendsPerMinute: lower(s.input.sendsPerMinute, policy.input?.sendsPerMinute),
    },
    tools: {
      ...t,
      maxPerTurn: lower(s.tools.maxPerTurn, pt.maxPerTurn),
      perMinute: lower(s.tools.perMinute, pt.perMinute),
      timeoutMs: lower(s.tools.timeoutMs, pt.timeoutMs),
    },
    output: { ...page.output, maxLength: lower(s.output.maxLength, policy.output?.maxLength) },
    locked: stricterLock(page.locked, policy.lockdown),
  };
  const deny = [...(t.deny ?? []), ...(pt.deny ?? [])];
  if (deny.length) out.tools!.deny = deny;
  const allow = bothAllow(t.allow, pt.allow, glob);
  if (allow) out.tools!.allow = allow;
  const origins = policy.output?.linkOrigins;
  if (origins) {
    const had = page.output?.onlyOrigins;
    out.output!.onlyOrigins = had ? origins.filter((o) => had.includes(o)) : [...origins];
  }
  const off = Object.entries(policy.overrides ?? {}).filter(([r, v]) => v === 'off' && !(PROTECTED_RULES as readonly string[]).includes(r));
  if (off.length) out.overrides = { ...Object.fromEntries(off), ...page.overrides };
  if (pt.tier && Object.keys(pt.tier).length) out.rules = [...(page.rules ?? []), tierRule(pt.tier, strict, glob)];
  return out;
}
