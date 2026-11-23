/**
 * The guardrails' public shapes: the stages a turn passes through, what a check can decide, and what a host
 * configures. Types only, so the page-load graph can name them without loading the module.
 *
 * @module
 */

/** Where in a turn a check runs. */
export type GuardrailStage = 'input' | 'context' | 'model' | 'tool' | 'output' | 'handoff';

/** How careful to be with a tool. Assigned by code, never by the model; it says how careful, it grants nothing. */
export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

/** What a check decided, short of letting it through. */
export type GuardrailAction = 'flag' | 'block' | 'confirm' | 'rewrite';

/** How much a decision matters. */
export type GuardrailSeverity = 'info' | 'warning' | 'critical';

/**
 * One decision, as `onDecision` and the `nxis-guardrail` DOM event report it.
 *
 * Never carries what the visitor wrote, what a tool returned, or a tool's arguments: only which rule decided what,
 * where.
 */
export interface GuardrailDecision {
  /** The stage that decided. */
  stage: GuardrailStage;
  /** The rule, as `<stage>/<name>` for built-in rules, or a custom rule's own `id`. */
  rule: string;
  /** What it decided. */
  action: GuardrailAction;
  /** How much it matters. */
  severity: GuardrailSeverity;
  /** The tool concerned, by name, when there is one. */
  tool?: string;
  /** That tool's risk tier, when one was assigned. */
  tier?: RiskTier;
}

/** How many decisions of each kind one conversation has had. */
export type GuardrailCounts = Record<GuardrailAction, number>;

/** The tool stage's configuration. */
export interface ToolGuardrails {
  /**
   * An allowlist of tool names; `*` matches anything. When set, a tool not on it is refused and never offered to
   * the model. `deny` wins over it.
   */
  allow?: string[];
  /** Tool names never offered or run; `*` matches anything. Wins over `allow`. */
  deny?: string[];
  /**
   * The host's own risk tier for a tool, by name (`*` matches anything). Wins over what the tool declares, since
   * the host knows what it does, with one floor: a tool code tiers `critical` (destructive, consequential, a payment
   * or an account change) is never taken below `high`, so it is always confirmed. A handoff is always `critical`.
   */
  tier?: Record<string, RiskTier>;
  /** Tool calls per turn. Defaults to 3 (`MAX_STEPS`). */
  maxPerTurn?: number;
  /** Tool calls per conversation per minute. Defaults to 30. */
  perMinute?: number;
  /** How long one call may run, in ms, before the turn stops waiting for it. Defaults to 20 000. */
  timeoutMs?: number;
}

/** The input stage's configuration. */
export interface InputGuardrails {
  /** The longest message a visitor may send, in characters. Defaults to 4000. */
  maxLength?: number;
  /** Sends per conversation per minute, to the model or a remote agent. Defaults to 10. */
  sendsPerMinute?: number;
}

/** The output stage's configuration. */
export interface OutputGuardrails {
  /** The longest reply shown, in characters; longer ones are cut. Defaults to 8000. */
  maxLength?: number;
  /** Extra patterns: a match in a reply is replaced with `[redacted]`. */
  redact?: RegExp[];
  /**
   * Origins the agent may open without asking, headless. The element reads its `link-origins` attribute. The
   * page's own origin is always allowed.
   */
  linkOrigins?: string[];
  /**
   * When set, only these of the other origins (from `link-origins` and `linkOrigins`) open without asking; the page's
   * own origin always does. A remote policy's `output.linkOrigins` sets it, so a policy can narrow the list but never
   * add to it.
   */
  onlyOrigins?: string[];
}

/** The handoff stage's configuration. */
export interface HandoffGuardrails {
  /** Withhold secret-looking text in the model's `reason` and `summary` before they leave the page. Defaults to true. */
  screenSummary?: boolean;
}

/** What a rule or the classifier decides. Rules can only tighten: `allow` lets the built-in decision stand. */
export interface Verdict {
  action: 'allow' | 'flag' | 'confirm' | 'block';
  /** Why, for the host's own logs. Not put in the event. */
  reason?: string;
}

/** What a rule is given. */
export interface RuleContext {
  stage: GuardrailRuleStage;
  /** The text at hand: the visitor's message, a reply, untrusted data, or a handoff's reason and summary. Empty for a tool call. */
  text: string;
  /** The tool, for the tool and handoff stages. */
  tool?: string;
  /** The tool's arguments, for the tool and handoff stages. */
  args?: Record<string, unknown>;
  /** The tool's risk tier. */
  tier?: RiskTier;
}

/** The stages a host's rule can run at. */
export type GuardrailRuleStage = 'input' | 'context' | 'tool' | 'output' | 'handoff';

/** A host's rule: run in order, after the built-in rules of its stage. */
export interface GuardrailRule {
  /** Its name in events: `acme/no-competitor-links`. */
  id: string;
  stage: GuardrailRuleStage;
  /** Synchronous or async. Throwing, or taking over 5 s, fails closed for `tool` and `handoff`, open for the rest. */
  check(ctx: RuleContext): Verdict | Promise<Verdict>;
}

/** What a host configures. Every field is optional: with none set, the standard defaults apply. */
export interface GuardrailsConfig {
  /** `'standard'` (the default) or `'strict'`, for regulated sites. */
  preset?: 'standard' | 'strict';
  /** Visitor messages: a length cap and a send rate. */
  input?: InputGuardrails;
  /** Tools: an allow and deny list, the host's tiers, and the limits. */
  tools?: ToolGuardrails;
  /** Replies and navigation: a length cap, extra patterns to redact, and where links may go. */
  output?: OutputGuardrails;
  /** What leaves the page in a handoff. */
  handoff?: HandoffGuardrails;
  /** The host's own rules, after the built-in ones. They can only tighten. */
  rules?: GuardrailRule[];
  /**
   * A model-based guard (a host's Prompt Guard endpoint, say), asked at the input and output stages. None ships.
   * Throwing or taking over 5 s fails open, with an event.
   */
  classifier?(ctx: RuleContext): Verdict | Promise<Verdict>;
  /**
   * Built-in rules turned off, by name: `{ 'input/injection-phrases': 'off' }`. Each is logged once per page with
   * `console.warn`. `tool/tier`, `tool/approval`, `tool/policy`, `tool/lockdown`, `input/lockdown` and
   * `tool/not-listed` can't be: an override of one is ignored, and logged once as ignored. Only `'off'` turns a rule
   * off; any other value is ignored.
   */
  overrides?: Record<string, 'off'>;
  /** Called with every decision except allow. */
  onDecision?(decision: GuardrailDecision): void;
  /**
   * The kill switch, set by {@link GuardrailsConfig.lockdown}, or directly by a host's remote config: `'tools'`
   * turns tools off, `'agent'` the whole agent. `null` lifts it.
   */
  locked?: { reason: string; scope: 'tools' | 'agent' } | null;
  /** Turn off tools (the default) or the whole agent, at once. The element's `guardrails` always has it. */
  lockdown?(reason: string, scope?: 'tools' | 'agent'): void;
}
