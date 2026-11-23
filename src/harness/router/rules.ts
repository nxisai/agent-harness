/**
 * Pattern-based routing, used before falling back to a model classification.
 *
 * Matching a table of regular expressions costs microseconds, where a
 * classification pass costs a generation. Rules run first and may abstain by
 * returning a null route, which is what tells {@link AgentCoordinator} that a
 * model pass is worth its cost.
 *
 * @module
 */

/** One pattern, and the agent it votes for. */
export interface RouteRule {
  /** The agent this rule votes for. */
  route: string;
  /** Tested against the goal, lower-cased. */
  match: RegExp;
/**
   * How much this rule's vote counts. Defaults to 1.
   *
   * Raise it so a specific phrase outscores a general one when both match.
   */
  weight?: number;
  /** A note on the rule's purpose, carried through to {@link RouteDecision}. */
  because?: string;
}

/** The result of scoring a goal against a rule table. */
export interface RouteDecision {
  /** The winning agent, or null when no rule matched or two rules tied. */
  route: string | null;
  /** Total score per route, highest first. Empty when nothing matched. */
  scores: [string, number][];
  /** Every rule that matched, in table order. */
  matched: RouteRule[];
}

/**
 * Score a goal against a rule table and return the highest-scoring agent.
 *
 * Ties abstain rather than picking arbitrarily, since routing to an agent that
 * lacks the required tool is more costly than the model pass that resolves the
 * ambiguity.
 *
 * @param goal - The user's message. Matched lower-cased.
 * @param rules - The table to score against.
 * @returns The winning route, or a null route when nothing matched or the top
 * two scores are equal.
 */
export function matchRoute(goal: string, rules: RouteRule[]): RouteDecision {
  const text = goal.toLowerCase();
  const matched = rules.filter((r) => r.match.test(text));

  const totals = new Map<string, number>();
  for (const rule of matched) {
    totals.set(rule.route, (totals.get(rule.route) ?? 0) + (rule.weight ?? 1));
  }

  const scores = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  if (!scores.length) return { route: null, scores, matched };
  if (scores.length > 1 && scores[0][1] === scores[1][1]) {
    return { route: null, scores, matched };
  }
  return { route: scores[0][0], scores, matched };
}
