/**
 * The coordinator: choosing an agent, and nothing else.
 *
 * No engine and no model here — the point of a rule-first router is that this
 * layer is pure, so it can be tested exhaustively and cheaply.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentCoordinator } from '../src/harness/router/coordinator';
import type { RouteRule } from '../src/harness/router/rules';

const RULES: RouteRule[] = [
  { route: 'booking', match: /\bbook\b/ },
  { route: 'quote', match: /\bquote\b/ },
  { route: 'retrieval', match: /\bwho\b/ },
];

const agent = (name: string) => ({
  name,
  turn: vi.fn(async () => ({ decision: 'none' as const })),
});

const build = (extra: Record<string, unknown> = {}) => {
  const agents = {
    retrieval: agent('retrieval'),
    booking: agent('booking'),
    quote: agent('quote'),
  };
  const coordinator = new AgentCoordinator({
    agents: agents as never,
    rules: RULES,
    fallback: 'retrieval',
    ...extra,
  });
  return { coordinator, agents };
};

describe('coordinator', () => {
  it('sends a turn to the agent the rules chose', async () => {
    const { coordinator, agents } = build();
    await coordinator.turn('book a visit', []);
    expect(agents.booking.turn).toHaveBeenCalledWith('book a visit', []);
    expect(agents.retrieval.turn).not.toHaveBeenCalled();
  });

  it('falls back when the rules abstain, and says that it did', async () => {
    const { coordinator, agents } = build();
    const routed = coordinator.route('book a quote');   // one vote each — a tie
    expect(routed).toMatchObject({ route: null, agent: 'retrieval', fellBack: true });

    await coordinator.turn('book a quote', []);
    expect(agents.retrieval.turn).toHaveBeenCalled();
  });

  it('falls back rather than routing to an agent that does not exist', () => {
    // A rule can name a route the host forgot to register. Landing somewhere
    // beats throwing at the person mid-conversation.
    const { coordinator } = build({ rules: [{ route: 'ghost', match: /\banything\b/ }] });
    expect(coordinator.route('anything')).toMatchObject({ agent: 'retrieval', fellBack: true });
  });

  it('reports every decision, for the debug label and for measuring', async () => {
    const onRoute = vi.fn();
    const { coordinator } = build({ onRoute });
    await coordinator.turn('who fixes water heaters', []);

    expect(onRoute).toHaveBeenCalledTimes(1);
    expect(onRoute.mock.calls[0][0]).toMatchObject({
      goal: 'who fixes water heaters',
      agent: 'retrieval',
      route: 'retrieval',
      fellBack: false,
    });
  });

  it('refuses a fallback that is not one of its agents', () => {
    // Caught at construction, where it is a typo, rather than at the first
    // unroutable turn, where it is an outage.
    expect(() => build({ fallback: 'nobody' })).toThrow(/fallback "nobody"/);
  });

  it('routes without running anything, so a host can preview a decision', () => {
    const { coordinator, agents } = build();
    expect(coordinator.route('book a visit').agent).toBe('booking');
    expect(agents.booking.turn).not.toHaveBeenCalled();
  });
});

describe('coordinator, phase 3', () => {
  const stickyBuild = (extra: Record<string, unknown> = {}) => {
    const agents = {
      retrieval: agent('retrieval'),
      booking: agent('booking'),
      quote: agent('quote'),
    };
    // Name-based ownership, as a host would write it.
    const owns: Record<string, RegExp> = {
      retrieval: /^nxis_/,
      booking: /^booking-/,
      quote: /^quote-/,
    };
    for (const [name, re] of Object.entries(owns)) {
      (agents as Record<string, ReturnType<typeof agent>>)[name].owns = (t: string) => re.test(t);
    }
    const coordinator = new AgentCoordinator({
      agents: agents as never,
      rules: RULES,
      fallback: 'retrieval',
      ...extra,
    });
    return { coordinator, agents };
  };

  it('keeps a conversation with the agent it is already with', async () => {
    const { coordinator, agents } = stickyBuild();
    const messages: never[] = [];

    await coordinator.turn('book a visit', messages);        // rules → booking
    await coordinator.turn('Thursday instead?', messages);   // rules say nothing

    // The follow-up is not a new topic, and re-routing it would send a booking
    // detail to whoever the fallback happens to be.
    expect(agents.booking.turn).toHaveBeenCalledTimes(2);
    expect(agents.retrieval.turn).not.toHaveBeenCalled();
  });

  it('lets a clear rule pull a conversation to another agent', async () => {
    const { coordinator, agents } = stickyBuild();
    const messages: never[] = [];
    await coordinator.turn('book a visit', messages);
    await coordinator.turn('actually, who is highest rated?', messages);

    // Stickiness is for silence, not for overriding an explicit signal.
    expect(agents.retrieval.turn).toHaveBeenCalledTimes(1);
  });

  it('does not stick across separate conversations', async () => {
    const { coordinator, agents } = stickyBuild();
    await coordinator.turn('book a visit', []);
    await coordinator.turn('hello there', []);   // a different transcript
    expect(agents.retrieval.turn).toHaveBeenCalledTimes(1);
  });

  it('moves a turn once when the model asks for a tool the agent lacks', async () => {
    const { coordinator, agents } = stickyBuild();
    agents.retrieval.turn = vi.fn(async () => ({ decision: 'handback' as const, wanted: 'booking-form' }));

    await coordinator.turn('something unroutable', []);

    // The model named the tool it wanted; that is a better signal than any rule.
    expect(agents.retrieval.turn).toHaveBeenCalledTimes(1);
    expect(agents.booking.turn).toHaveBeenCalledTimes(1);
  });

  it('accepts the second answer even when that agent hands back too', async () => {
    const { coordinator, agents } = stickyBuild();
    agents.retrieval.turn = vi.fn(async () => ({ decision: 'handback' as const, wanted: 'booking-form' }));
    agents.booking.turn = vi.fn(async () => ({ decision: 'handback' as const, wanted: 'quote-form' }));

    const result = await coordinator.turn('something unroutable', []);

    // One hop, then stop: two agents that disagree would otherwise pass a turn
    // back and forth while the person waits.
    expect(agents.quote.turn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ decision: 'handback' });
  });

  it('keeps the hand-back when nobody else owns the tool', async () => {
    const { coordinator, agents } = stickyBuild();
    agents.retrieval.turn = vi.fn(async () => ({ decision: 'handback' as const, wanted: 'mystery-tool' }));
    const result = await coordinator.turn('something', []);
    expect(result).toMatchObject({ decision: 'handback', wanted: 'mystery-tool' });
  });

  it('asks the model only when the rules abstain and nothing is sticky', async () => {
    const complete = vi.fn(async () => ({ text: 'booking' }));
    const { coordinator, agents } = stickyBuild({ provider: { complete } as never });

    await coordinator.turn('book a visit', []);   // rules decide, no model call
    expect(complete).not.toHaveBeenCalled();

    await coordinator.turn('my kitchen sink is acting up', []);   // nothing matches
    expect(complete).toHaveBeenCalledTimes(1);
    expect(agents.booking.turn).toHaveBeenCalled();
  });

  it('caps the classification generation, because it is one word', async () => {
    const complete = vi.fn(async () => ({ text: 'quote' }));
    const { coordinator } = stickyBuild({ provider: { complete } as never });
    await coordinator.turn('unroutable phrasing', []);

    const [req] = complete.mock.calls[0] as [{ messages: unknown[]; tools: unknown[]; maxTokens: number }];
    expect(req.tools).toEqual([]);                // a router needs no tools
    expect(req.maxTokens).toBeLessThanOrEqual(12);
    expect(req.messages).toHaveLength(2);
  });

  it('falls back when the classifier answers with something that is not an agent', async () => {
    const complete = vi.fn(async () => ({ text: 'I think the plumbing department' }));
    const { coordinator, agents } = stickyBuild({ provider: { complete } as never });
    await coordinator.turn('unroutable phrasing', []);
    expect(agents.retrieval.turn).toHaveBeenCalled();
  });

  it('falls back when the classifier throws', async () => {
    const complete = vi.fn(async () => { throw new Error('no WebGPU'); });
    const { coordinator, agents } = stickyBuild({ provider: { complete } as never });
    await coordinator.turn('unroutable phrasing', []);
    // A router that throws is worse than one that guesses conservatively.
    expect(agents.retrieval.turn).toHaveBeenCalled();
  });

  it('reports how each turn was routed', async () => {
    const onRoute = vi.fn();
    const { coordinator } = stickyBuild({ onRoute });
    const messages: never[] = [];
    await coordinator.turn('book a visit', messages);
    await coordinator.turn('Thursday instead?', messages);

    expect(onRoute.mock.calls.map((c) => (c[0] as { via: string }).via)).toEqual(['rules', 'sticky']);
  });
});

describe('coordinator, after an agent cannot help', () => {
  it('stops sticking to an agent that reported unavailable', async () => {
    const agents = {
      retrieval: agent('retrieval'),
      booking: agent('booking'),
    };
    agents.booking.turn = vi.fn(async () => ({ decision: 'unavailable' as const }));
    const coordinator = new AgentCoordinator({
      agents: agents as never,
      rules: [{ route: 'booking', match: /\bbook\b/ }],
      fallback: 'retrieval',
    });
    const messages: never[] = [];

    await coordinator.turn('book a visit', messages);          // booking: "I cannot"
    await coordinator.turn('okay, what about tuesday?', messages);   // no rule matches

    // Without the reset this follow-up would go back to booking and hear the
    // same refusal. It goes to the fallback instead, which can at least answer.
    expect(agents.booking.turn).toHaveBeenCalledTimes(1);
    expect(agents.retrieval.turn).toHaveBeenCalledTimes(1);
  });
});
