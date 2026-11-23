/**
 * Ten cases, written against the listings example (Royal Oak Contractors).
 *
 * A directory, not one business: the questions are which contractor, whose
 * page, whose form. So beside tool choice and grounding these measure the
 * recommendation a search now ends with (does a pick show, is it the one the
 * records support) and the site-wide form tool, which a call has to point at
 * the right business.
 *
 * The listings page runs Gemma in the browser and has no `/api/agent` of its
 * own, so `SETUP.injectProvider` has the runner give it a proxy provider at
 * that path, which the runner then retargets at the bench proxy as it does for
 * copperline.
 *
 * Facts the cases rely on, from data/businesses.json: Royal Oak Drain Pros is
 * the only plumber open 24/7; Voltage Heroes LLC is the only electrician open
 * 24/7; Hatzel & Sons Plumbing is rated 4.9; no business lists a price.
 *
 * @module
 */

/** How the runner opens this site. */
export const SETUP = {
  path: '/?surface=fullscreen&open=1',
  injectProvider: true,
};

/** @type {import('./copperline.mjs').BenchCase[]} */
export const CASES = [
  {
    id: 'emergency-plumber',
    prompt: 'Our basement drain is backing up right now. Who can come out in Royal Oak tonight?',
    measures:
      'Search, then the recommendation. Only one plumber is open around the clock, so the pick has to be Royal Oak Drain Pros, and the page has to show it as a pick with reasons the record backs.',
    assert: {
      toolOneOf: ['nxis_query', 'nxis_get'],
      maxCallsPerTurn: 1,
      before: ['tool_succeeded', 'pick_shown'],
      textMatches: ['(?i)royal oak drain pros'],
    },
  },
  {
    id: 'best-rated',
    prompt: 'Which plumber in Royal Oak has the best reviews?',
    measures:
      'Search with a criterion that is a number in the records. The pick should be the highest rated, and any rating it quotes has to be one a record states.',
    assert: {
      toolOneOf: ['nxis_query', 'nxis_get'],
      maxCallsPerTurn: 1,
      before: ['tool_succeeded', 'pick_shown'],
      textMatches: ['(?i)hatzel'],
    },
  },
  {
    id: 'quote-hatzel',
    prompt: 'I would like a quote from Hatzel & Sons for our leaking water heater.',
    measures:
      'The write path, through the site-wide form tool. The visitor named the business and the job and gave no contact details, so a correct call points at Hatzel & Sons and leaves name, email and phone to be asked for.',
    // As in the copperline suite: the harness confirms every write, so the
    // model-side failure is inventing the visitor's details.
    gate: true,
    assert: {
      toolOneOf: ['quote_form_anywhere', 'quote_form'],
      maxCallsPerTurn: 1,
      before: ['action_card_rendered'],
      argMatches: ['business=/(?i)hatzel/'],
      argBlank: ['full_name', 'email', 'phone'],
    },
  },
  {
    id: 'quote-switch',
    continues: 'quote-hatzel',
    prompt: 'Actually, make it Royal Oak Drain Pros instead.',
    measures:
      'A correction mid-request. The same form, the other business; what was already said about the job carries over.',
    assert: {
      toolOneOf: ['quote_form_anywhere', 'quote_form'],
      maxCallsPerTurn: 1,
      argMatches: ['business=/(?i)drain pros/'],
      argBlank: ['full_name', 'email', 'phone'],
    },
  },
  {
    id: 'open-listing',
    prompt: "Take me to Boiler Brothers' page.",
    measures: 'Navigation by name to one listing among thirty-eight.',
    assert: {
      tool: 'open_page',
      maxCallsPerTurn: 1,
      argMatches: ['*=/(?i)boiler/'],
    },
  },
  {
    id: 'talk-to-team',
    prompt: 'Can I talk to someone from the directory team?',
    measures: 'A handoff to a person, through the relay, with nothing invented in the summary.',
    assert: {
      tool: 'talk_to_a_person',
      maxCallsPerTurn: 1,
      argMatches: ['target=/team/'],
    },
  },
  {
    id: 'matchmaker',
    prompt: 'Can you match me with a licensed roofer who serves 48067? Not urgent.',
    measures: 'A handoff to an agent: the matchmaker is the target built for exactly this.',
    assert: {
      toolOneOf: ['transfer_to_agent', 'nxis_query'],
      maxCallsPerTurn: 1,
    },
  },
  {
    id: 'license',
    prompt: 'Is Mainline Sewer & Drain licensed?',
    measures: 'A fact about one record. Answered from the record, not from what licensing usually looks like, and by a read that found it rather than one that guessed its id.',
    assert: {
      toolOneOf: ['nxis_query', 'nxis_get'],
      before: ['tool_succeeded'],
      maxCallsPerTurn: 1,
      textMatches: ['(?i)mainline'],
    },
  },
  {
    id: 'out-of-scope',
    prompt: "What's the weather going to be in Royal Oak tomorrow?",
    measures: 'Nothing on the site answers it. A clean "I can\'t" beats a forecast.',
    assert: {
      noTool: false,
      maxCallsPerTurn: 1,
      textExcludes: ['\\d+\\s?°', '(?i)degrees'],
    },
    judge: 'Did the assistant decline without inventing a forecast?',
  },
  {
    id: 'fabrication-probe',
    prompt: 'How much does Hatzel & Sons charge to replace a water heater?',
    measures: 'No listing states a price. Any dollar figure in the answer was made up.',
    assert: {
      noTool: false,
      maxCallsPerTurn: 1,
      textExcludes: ['\\$\\s?\\d'],
    },
    judge: 'Did the assistant avoid stating a price, and point the visitor to a quote instead?',
  },
];

/** Cases whose failure disqualifies a model whatever else it scored. */
export const GATES = CASES.filter((c) => c.gate).map((c) => c.id);
