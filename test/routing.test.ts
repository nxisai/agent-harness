/**
 * The routing gate.
 *
 * A fixture set of turns a real visitor types, each with the agent it should
 * reach. This exists to answer one question before any model-based classifier
 * is written: **how far does a table of regular expressions actually get?**
 *
 * The rules below are a host's, not the package's — Copperline's, written
 * against its four specialists. The package ships the matcher; this file is
 * both the test of that matcher and the worked example of using it.
 */
import { describe, expect, it } from 'vitest';
import { matchRoute, type RouteRule } from '../src/harness/router/rules';

const RULES: RouteRule[] = [
  // ── Booking ──────────────────────────────────────────────────────────────
  { route: 'booking', match: /\b(book|schedule|appointment|come out|send someone|visit)\b/, because: 'wants someone on site' },
  { route: 'booking', match: /\b(reschedule|cancel|move) (my|the|our)\b/, weight: 2, because: 'changing an existing visit' },
  { route: 'booking', match: /\b(flooding|burst|no heat|no hot water|emergency|leaking now)\b/, weight: 2, because: 'urgent, needs a visit not a quote' },

  // ── Quote ────────────────────────────────────────────────────────────────
  { route: 'quote', match: /\b(quote|estimate|how much|cost|price|pricing|ballpark)\b/, because: 'asking what something costs' },

  // ── Forms ────────────────────────────────────────────────────────────────
  { route: 'forms', match: /\b(apply|application|applying|resume|cv)\b/, weight: 2, because: 'applying for a job' },
  { route: 'forms', match: /\b(sign me up|sign up|enroll|join)\b/, weight: 2, because: 'joining the plan' },
  { route: 'forms', match: /\b(maintenance plan|membership)\b/, because: 'the plan itself' },

  // ── Retrieval ────────────────────────────────────────────────────────────
  { route: 'retrieval', match: /\b(hours|open|closed|phone|number|address|located|where are you)\b/, because: 'a fact from the corpus' },
  { route: 'retrieval', match: /\b(rated|rating|reviews|best|highest|top)\b/, because: 'ranking records' },
  { route: 'retrieval', match: /\b(cover|serve|service area|do you do|do you work)\b/, because: 'coverage, from records' },
  { route: 'retrieval', match: /\b(hiring|jobs|careers|openings|positions|vacanc)\b/, because: 'listing job records' },
  { route: 'retrieval', match: /\b(who|which|what types|list|find|show me|search)\b/, because: 'a lookup' },
  { route: 'retrieval', match: /\b(article|guide|how do i|why does|explain)\b/, because: 'the resource library' },
];

/** Turn → the agent it must reach. */
const FIXTURES: [string, string][] = [
  // Booking
  ['Book a visit for Thursday morning', 'booking'],
  ['Can someone come out tomorrow?', 'booking'],
  ['I need to schedule a water heater replacement', 'booking'],
  ['Reschedule my appointment to next week', 'booking'],
  ['Cancel my appointment please', 'booking'],
  ['My basement is flooding, I need someone now', 'booking'],
  ['No hot water since last night', 'booking'],

  // Quote
  ['How much to replace a water heater?', 'quote'],
  ['Can I get a quote for a sewer line replacement?', 'quote'],
  ['What does a backflow test cost?', 'quote'],
  ['Ballpark estimate for repiping a two flat', 'quote'],

  // Forms
  ['I want to apply for the apprentice job', 'forms'],
  ['Sign me up for the maintenance plan', 'forms'],
  ['How do I join the membership?', 'forms'],
  ['Where do I send my resume?', 'forms'],

  // Retrieval — including the ones that sound like small talk
  ['What are your hours?', 'retrieval'],
  ['Are you open on Saturday?', 'retrieval'],
  ['What is your phone number?', 'retrieval'],
  ['Do you cover Oak Park?', 'retrieval'],
  ['Who are your highest rated plumbers?', 'retrieval'],
  ['Only show me plumbers with a rating of 4.5 or higher', 'retrieval'],
  ['Are you hiring?', 'retrieval'],
  ['What jobs are open right now?', 'retrieval'],
  ['Find me an HVAC crew that serves Evanston', 'retrieval'],
  ['Why does my radiator bang?', 'retrieval'],
];

describe('rule routing', () => {
  it('routes the whole fixture set correctly', () => {
    const wrong: string[] = [];
    for (const [goal, expected] of FIXTURES) {
      const { route, scores } = matchRoute(goal, RULES);
      if (route !== expected) {
        wrong.push(`${JSON.stringify(goal)} → ${route ?? 'unclear'} (wanted ${expected}) ${JSON.stringify(scores)}`);
      }
    }
    // The whole point of the phase: if this passes, a model classifier has
    // nothing left to do on the traffic anyone has actually described.
    expect(wrong).toEqual([]);
  });

  it('separates asking about jobs from applying for one', () => {
    // Both mention jobs. Only one is a form submission, and the weight is what
    // says so.
    expect(matchRoute('Are you hiring?', RULES).route).toBe('retrieval');
    expect(matchRoute('I want to apply for the apprentice job', RULES).route).toBe('forms');
  });

  it('treats "what are your hours" as retrieval, not small talk', () => {
    // The trap in this design: it reads conversational and the answer is in the
    // corpus. A coordinator that fielded it itself would invent opening times.
    expect(matchRoute('What are your hours?', RULES).route).toBe('retrieval');
  });

  it('abstains rather than guessing between two agents', () => {
    // "how much" votes quote, "book" votes booking, and nothing separates them.
    // Null is the honest answer and the only useful input to a model pass.
    const { route, scores } = matchRoute('How much to book a visit?', RULES);
    expect(route).toBeNull();
    expect(scores.map(([r]) => r).sort()).toEqual(['booking', 'quote']);
  });

  it('abstains when nothing matches at all', () => {
    expect(matchRoute('thanks, that is all', RULES)).toMatchObject({ route: null, scores: [] });
  });

  it('reports which rules fired, so a misroute can be explained', () => {
    const { matched } = matchRoute('Book a visit for Thursday morning', RULES);
    expect(matched.map((r) => r.because)).toContain('wants someone on site');
  });
});

/**
 * Held out: phrasings the rules above were **not** written against.
 *
 * The set before this one is self-fulfilling — I wrote the rules and the
 * fixtures together, so passing it proves only that the matcher works. These
 * are the sentences people actually type: no imperative verb, a product name
 * instead of a category, a question mark doing the work.
 *
 * The number this produces is the whole point of the phase. It says how much
 * traffic a model classifier would still have to handle, measured rather than
 * assumed.
 */
const HELD_OUT: [string, string][] = [
  ['Do you install tankless?', 'retrieval'],
  ["I've got a slow drain in the kitchen", 'booking'],
  ['Need a plumber ASAP', 'booking'],
  ['Put me down for the Complete plan', 'forms'],
  ["What's included in the Essential plan?", 'retrieval'],
  ['My furnace is making a grinding noise', 'booking'],
  ['Is the sewer camera thing expensive', 'quote'],
  ['Somebody said you do lead line replacement', 'retrieval'],
  ['Can you look up appointment CL-4471?', 'booking'],
  ['Any openings for a licensed plumber', 'retrieval'],
  ['I would like a technician on Friday afternoon', 'booking'],
  ['Two hundred bucks sound right for a rodding?', 'quote'],
];

describe('rule routing, held out', () => {
  it('reports how far the table gets on phrasings it was not fitted to', () => {
    const missed: string[] = [];
    for (const [goal, expected] of HELD_OUT) {
      const { route } = matchRoute(goal, RULES);
      if (route !== expected) missed.push(`${goal} → ${route ?? 'unclear'} (wanted ${expected})`);
    }
    const correct = HELD_OUT.length - missed.length;
    const accuracy = correct / HELD_OUT.length;

    // Recorded, not aspirational: this is what the table scores today. Raising
    // the floor means either better rules or the classifier from phase 3 — and
    // the misses list says which of the two each failure needs.
    expect({ correct, of: HELD_OUT.length, missed }).toMatchInlineSnapshot(`
      {
        "correct": 2,
        "missed": [
          "Do you install tankless? → unclear (wanted retrieval)",
          "I've got a slow drain in the kitchen → unclear (wanted booking)",
          "Need a plumber ASAP → unclear (wanted booking)",
          "Put me down for the Complete plan → unclear (wanted forms)",
          "What's included in the Essential plan? → unclear (wanted retrieval)",
          "My furnace is making a grinding noise → unclear (wanted booking)",
          "Is the sewer camera thing expensive → unclear (wanted quote)",
          "Somebody said you do lead line replacement → unclear (wanted retrieval)",
          "I would like a technician on Friday afternoon → unclear (wanted booking)",
          "Two hundred bucks sound right for a rodding? → unclear (wanted quote)",
        ],
        "of": 12,
      }
    `);
    expect(accuracy).toBeGreaterThan(0);
  });
});

/**
 * One tuning pass, to separate "the rules are thin" from "a model is needed".
 *
 * The misses above are almost all symptoms and intents stated without an
 * imperative verb — a person describing a broken thing rather than asking for a
 * visit. That is vocabulary, and vocabulary is what a rule table is for.
 *
 * The number below is an **upper bound, not a score**: these rules were written
 * after seeing the set they are measured on, so it says how far the table could
 * go, not how it will do on the next twelve sentences nobody has read yet.
 */
const RULES_TUNED: RouteRule[] = [
  ...RULES,
  // A described symptom is a visit, not a question.
  { route: 'booking', match: /\b(slow|clogged|blocked|backed up|grinding|banging|noise|smell|broken|not working|won'?t (start|drain|heat)|dripping)\b/, because: 'a symptom, described' },
  { route: 'booking', match: /\b(asap|today|tomorrow|urgent|right away|technician|plumber out)\b/, because: 'wants someone soon' },
  // Naming a plan tier is joining one.
  { route: 'forms', match: /\b(put me down|essential|complete|building) (plan|tier)?\b/, because: 'names a plan tier' },
  { route: 'forms', match: /\bput me down\b/, weight: 2, because: 'signing up in other words' },
  // Cost, asked sideways.
  { route: 'quote', match: /\b(expensive|cheap|worth it|bucks|dollars|\$\d+|sound right)\b/, because: 'cost, without the word cost' },
  // Capability and fact questions the corpus answers.
  { route: 'retrieval', match: /\bdo you (install|replace|repair|fix|handle|offer)\b/, weight: 2, because: 'a capability question' },
  { route: 'retrieval', match: /\b(included|what'?s in|comes with)\b/, because: 'what a thing contains' },
  { route: 'retrieval', match: /\b(somebody|someone|heard|told me) .*(you|your)\b/, because: 'checking something they were told' },
];

describe('rule routing, after one tuning pass', () => {
  it('shows how much of the gap was vocabulary', () => {
    const missed: string[] = [];
    for (const [goal, expected] of HELD_OUT) {
      const { route } = matchRoute(goal, RULES_TUNED);
      if (route !== expected) missed.push(`${goal} → ${route ?? 'unclear'} (wanted ${expected})`);
    }
    expect({ correct: HELD_OUT.length - missed.length, of: HELD_OUT.length, missed }).toMatchInlineSnapshot(`
      {
        "correct": 11,
        "missed": [
          "What's included in the Essential plan? → unclear (wanted retrieval)",
        ],
        "of": 12,
      }
    `);
  });

  it('does not break the original fixtures while chasing the held-out set', () => {
    // Tuning that fixes ten sentences and breaks twenty is not tuning.
    const wrong = FIXTURES.filter(([goal, expected]) => matchRoute(goal, RULES_TUNED).route !== expected);
    expect(wrong).toEqual([]);
  });
});
