/**
 * Routes each turn to one of several {@link AgentHarness} instances.
 *
 * The coordinator holds no tools and produces no answers of its own. Its only
 * job is choosing which agent handles a turn, so that agent sends the model its
 * own few tool definitions rather than every tool on the page.
 *
 * It decides in four stages, cheapest first:
 *
 * | Stage | Cost | When it applies |
 * |---|---|---|
 * | `rules` | microseconds | A rule table matches the goal unambiguously. |
 * | `sticky` | none | The rules abstained, and this conversation is already with an agent. |
 * | `model` | one generation | The rules abstained and there is no history. Requires `provider`. |
 * | `fallback` | none | Nothing else decided. |
 *
 * After the fact it applies one correction: if the chosen agent reports that
 * the model asked for a tool it does not hold, the turn moves once to the agent
 * that does.
 *
 * @module
 */
import type { ChatMessage } from '../../types.js';
import type { ModelProvider } from '../../providers/types.js';
import type { AgentHarness, TurnResult } from '../harness.js';
import type { HandoffController } from '../../handoff/controller.js';
import { matchRoute, type RouteDecision, type RouteRule } from './rules.js';

/** How a turn's agent was chosen. */
/** Which stage of {@link AgentCoordinator} chose the agent for a turn. */
export type RouteSource = 'rules' | 'sticky' | 'model' | 'fallback' | 'handback';

/** Configuration for an {@link AgentCoordinator}. */
export interface CoordinatorOptions {
  /** The agents to route between, keyed by the name the rules refer to. */
  agents: Record<string, AgentHarness>;
  /** The rule table scored against each goal. May be empty. */
  rules: RouteRule[];
  /**
   * The agent an otherwise unroutable turn goes to.
   *
   * Must name a key of {@link CoordinatorOptions.agents}; the constructor
   * throws if it does not.
   */
  fallback: string;
  /**
   * Enables the model classification stage, which is otherwise skipped.
   *
   * This is the only part of routing that costs a generation, so it runs only
   * when the rules abstain and no stickiness applies.
   */
  provider?: ModelProvider;
  /** One line per agent describing what it handles, shown to the classifier. */
  descriptions?: Record<string, string>;
  /** Called with every routing decision, including corrections. */
  onRoute?(decision: RoutedTurn): void;
  /**
   * Handoffs to remote agents and people.
   *
   * While a conversation is handed off, its turns go to the target rather than
   * to any agent here, and resolve with `decision: 'handoff'`. Routing returns
   * to the agents when the target finishes or the visitor ends the handoff.
   */
  handoff?: {
    controller: HandoffController;
    /** The id the controller knows this conversation by. */
    conversationId(messages: ChatMessage[]): string | undefined;
  };
}

/** A routing decision, reported through {@link CoordinatorOptions.onRoute}. */
export interface RoutedTurn extends RouteDecision {
  /** The agent that ran, which may differ from {@link RouteDecision.route}. */
  agent: string;
  /** Which stage chose the agent. */
  via: RouteSource;
  /** True when no stage decided and the fallback was used. */
  fellBack: boolean;
  /** The user message that was routed. */
  goal: string;
}

/** Token ceiling for the classification pass, whose answer is one agent name. */
const CLASSIFY_MAX_TOKENS = 12;

/**
 * Routes turns between several agents. See the module description for the
 * stages it decides in.
 */
export class AgentCoordinator {
  /**
   * The agent each conversation is currently with.
   *
   * Keyed by the transcript array itself, so several conversations can be open
   * at once and a discarded one takes its routing state with it.
   */
  private readonly sticky = new WeakMap<ChatMessage[], string>();
  /** The classification pass in flight, if any. */
  private classifying: AbortController | null = null;
  /** The agent handling the current turn, so {@link stop} can reach it. */
  private working: AgentHarness | null = null;

  constructor(private readonly opts: CoordinatorOptions) {
    if (!opts.agents[opts.fallback]) {
      throw new Error(`Coordinator fallback "${opts.fallback}" is not one of its agents.`);
    }
  }

  /**
   * Abandon the turn in flight, whichever stage it has reached.
   *
   * Aborts the classification pass and delegates to the agent handling the
   * turn, which resolves as `'stopped'`. Safe to call when nothing is running.
   */
  stop(): void {
    this.classifying?.abort();
    this.classifying = null;
    this.working?.stop();
  }

  /**
   * Decide which agent should take a turn, without running it.
   *
   * Covers the rules, sticky and fallback stages. The model stage is skipped,
   * since it is asynchronous and costs a generation.
   *
   * @param goal - The user's message.
   * @param messages - The conversation, consulted for stickiness. Optional.
   * @returns The chosen agent and the stage that chose it.
   */
  route(goal: string, messages?: ChatMessage[]): RoutedTurn {
    const decision = matchRoute(goal, this.opts.rules);
    const named = decision.route && this.opts.agents[decision.route] ? decision.route : null;
    if (named) return { ...decision, agent: named, via: 'rules', fellBack: false, goal };

    const held = messages && this.sticky.get(messages);
    if (held && this.opts.agents[held]) {
      return { ...decision, agent: held, via: 'sticky', fellBack: false, goal };
    }
    return { ...decision, agent: this.opts.fallback, via: 'fallback', fellBack: true, goal };
  }

  /**
   * Route a turn, run it, and re-route it once if it reached the wrong agent.
   *
   * @param goal - The user's message.
   * @param messages - The live conversation, appended to in place.
   * @returns The chosen agent's {@link TurnResult}.
   */
  async turn(goal: string, messages: ChatMessage[]): Promise<TurnResult> {
    // A handed-off conversation belongs to its target until it hands back.
    const handoff = this.opts.handoff;
    const conversationId = handoff?.conversationId(messages);
    if (handoff && handoff.controller.active(conversationId)) {
      await handoff.controller.send(conversationId!, goal);
      return { decision: 'handoff' };
    }

    let routed = this.route(goal, messages);

    // The model is only asked when nothing cheaper had an opinion.
    if (routed.via === 'fallback' && this.opts.provider) {
      const guessed = await this.classify(goal);
      if (guessed) routed = { ...routed, agent: guessed, via: 'model', fellBack: false };
    }

    this.opts.onRoute?.(routed);
    this.sticky.set(messages, routed.agent);

    this.working = this.opts.agents[routed.agent];
    const result = await this.working.turn(goal, messages);

    // Release stickiness after a refusal, so the next unclear follow-up is not
    // routed back to the one agent known to lack the tools for it.
    if (result.decision === 'unavailable') this.sticky.delete(messages);

    if (result.decision !== 'handback' || !result.wanted) return result;

    // Exactly one correction: the owner's answer stands whatever it is. Without
    // the cap, two agents that disagree could pass a turn back and forth.
    const owner = this.ownerOf(result.wanted, routed.agent);
    if (!owner) return result;

    const moved: RoutedTurn = { ...routed, agent: owner, via: 'handback', fellBack: false };
    this.opts.onRoute?.(moved);
    this.sticky.set(messages, owner);
    this.working = this.opts.agents[owner];
    // The same send: the guardrails screened and counted it on the first agent.
    return this.working.turn(goal, messages, true);
  }

  /**
   * Run a turn whose tool call is already decided, on the agent that holds the tool.
   *
   * @see AgentHarness.begin
   */
  async begin(goal: string, name: string, args: Record<string, unknown>, messages: ChatMessage[]): Promise<TurnResult> {
    const owner = this.ownerOf(name, '');
    if (!owner) return { decision: 'unavailable' };
    this.opts.onRoute?.({ ...this.route(goal, messages), agent: owner, via: 'handback', fellBack: false });
    this.sticky.set(messages, owner);
    this.working = this.opts.agents[owner];
    return this.working.begin(goal, name, args, messages);
  }

  /** The agent holding a tool, ignoring the one that handed the turn back. */
  private ownerOf(tool: string, except: string): string | null {
    for (const [name, agent] of Object.entries(this.opts.agents)) {
      if (name !== except && agent.owns(tool)) return name;
    }
    return null;
  }

  /**
   * Ask the model which agent should take the turn.
   *
   * One short generation with no tools. Any reply that does not name a known
   * agent returns null, leaving the fallback in place.
   */
  private async classify(goal: string): Promise<string | null> {
    const provider = this.opts.provider;
    if (!provider) return null;
    const names = Object.keys(this.opts.agents);
    const menu = names
      .map((n) => `- ${n}: ${this.opts.descriptions?.[n] ?? 'handles ' + n + ' requests'}`)
      .join('\n');

    this.classifying = new AbortController();
    try {
      const reply = await provider.complete({
        messages: [
          {
            role: 'system',
            content:
              'Choose which assistant should handle the message. ' +
              `Answer with exactly one of these names and nothing else:\n${menu}`,
          },
          { role: 'user', content: goal },
        ],
        tools: [],
        maxTokens: CLASSIFY_MAX_TOKENS,
        signal: this.classifying.signal,
      });
      const said = reply.text.toLowerCase();
      // Longest name first, so a shorter name that is a substring of another
      // does not match in its place.
      const found = [...names]
        .sort((a, b) => b.length - a.length)
        .find((n) => said.includes(n.toLowerCase()));
      return found ?? null;
    } catch {
      // Routing must not fail a turn: the fallback covers a failed pass.
      return null;
    }
  }
}
