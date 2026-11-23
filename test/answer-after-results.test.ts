/**
 * A read is a step, not the end of a turn. Once its results are drawn the model is asked again: to call the next
 * read it needs (a type listing, then a search) or to answer in words from what came back. A turn never ends on
 * result cards alone, and a reply with nothing in it is asked for once more, then stood in for.
 *
 * The conversation below is the one a hosted assistant had for "What are your hours?": it listed the site's
 * types, drew them as twelve cards, and stopped there, with no search and no sentence.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentHarness, ANSWER_FALLBACK, ANSWER_NOW } from '../src/harness/harness';
import { MAX_STEPS } from '../src/engine';

type Reply = { text: string; call?: { name: string; args: Record<string, unknown> } };
type Seen = { messages: { role: string; content: string }[]; tools: { name: string }[] };

const read = (name: string, properties: Record<string, unknown> = {}) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties },
  annotations: { readOnlyHint: true },
});

const TOOLS = [
  read('nxis_list_types'),
  read('nxis_query', { schema_type: { type: 'string' }, text: { type: 'string' } }),
  { name: 'quote_form', description: 'Ask for a quote.', inputSchema: { type: 'object', properties: { email: { type: 'string' } } }, annotations: { readOnlyHint: false } },
];

/** What the site's server returned, cut down from the production run. */
const TYPES = {
  types: [
    { type: 'BreadcrumbList', count: 16 },
    { type: 'Plumber', count: 16 },
    { type: 'EmergencyService', count: 15 },
    { type: 'WebPage', count: 12 },
  ],
};
const LOCATIONS = {
  results: [
    {
      '@type': 'Plumber',
      '@id': 'https://riverside.example/locations/north',
      name: 'Riverside North',
      openingHoursSpecification: [
        { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], opens: '07:00', closes: '19:00' },
      ],
    },
    {
      '@type': 'EmergencyService',
      '@id': 'https://riverside.example/emergency',
      name: 'Riverside Emergency Line',
      openingHours: 'Mo-Su 00:00-23:59',
    },
  ],
};

const HOURS = "We're open Monday to Saturday, 7am to 7pm, and the emergency line answers 24/7.";

function setup(replies: Reply[] | ((n: number, req: Seen) => Reply), opts: Record<string, unknown> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const said: string[] = [];
  const drawn: string[] = [];
  const confirms: { onSubmit: (v: Record<string, unknown>) => void; values: Record<string, unknown> }[] = [];
  const seen: Seen[] = [];
  const bubble = { thinking() {}, update() {}, finalize: (t: string) => void (t && said.push(t)) };
  const renderer = {
    streaming: () => bubble,
    message: (_r: string, t: string) => void said.push(t),
    status() {},
    results: (tool: { name: string }) => void drawn.push(tool.name),
    toolError() {},
    detail() {},
    ask() {},
    confirm: (req: (typeof confirms)[number]) => void confirms.push(req),
  };
  let n = 0;
  const provider = {
    ready: true,
    load: async () => {},
    complete: async (req: Seen) => {
      // What reached the model: the guardrails' rendering, data blocks drawn in.
      seen.push({ messages: req.messages.map((m) => ({ role: m.role, content: m.content })), tools: req.tools.map((t) => ({ name: t.name })) });
      const i = n++;
      return typeof replies === 'function' ? replies(i, seen[i]) : replies[Math.min(i, replies.length - 1)];
    },
  };
  const toolSource = {
    discoverTools: async () => TOOLS,
    execTool: async (_t: unknown, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const body = name === 'nxis_list_types' ? TYPES : name === 'nxis_query' ? LOCATIONS : { ok: true };
      return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
    },
  };
  const messages: { role: string; content: string; data?: string }[] = [];
  const harness = new AgentHarness({ provider, toolSource, renderer, recommend: false, ...opts } as never);
  return { harness, messages, calls, said, drawn, seen, confirms, completions: () => n };
}

const listTypes: Reply = { text: '', call: { name: 'nxis_list_types', args: {} } };
const query = (text = 'hours'): Reply => ({ text: '', call: { name: 'nxis_query', args: { schema_type: 'Plumber', text } } });

describe('"What are your hours?"', () => {
  it('lists the types, searches, then answers in words from the results', async () => {
    const s = setup([listTypes, query(), { text: HOURS }]);
    const result = await s.harness.turn('What are your hours?', s.messages as never);

    expect(s.calls.map((c) => c.name)).toEqual(['nxis_list_types', 'nxis_query']);
    expect(s.drawn).toEqual(['nxis_list_types', 'nxis_query']);
    expect(s.completions()).toBe(3);
    // The turn ends on a sentence, not on cards.
    const last = s.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.content).toBe(HOURS);
    expect(s.said.at(-1)).toBe(HOURS);
    expect(result).toMatchObject({ decision: 'execute', tool: { name: 'nxis_query' } });
  });

  it('gives the model the hours it answers from, not 400 characters of them', async () => {
    const s = setup([query(), { text: HOURS }]);
    await s.harness.turn('What are your hours?', s.messages as never);
    const answering = s.seen[1].messages.at(-1)!.content;
    expect(answering).toContain('"opens":"07:00"');
    expect(answering).toContain('Riverside Emergency Line');
  });
});

describe('a type listing', () => {
  it('never ends the turn: the model is asked again, with the tools, and told to search next', async () => {
    const s = setup([listTypes, query(), { text: HOURS }]);
    await s.harness.turn('What are your hours?', s.messages as never);
    const after = s.seen[1];
    expect(after.tools.map((t) => t.name)).toContain('nxis_query');
    expect(after.messages.at(-1)!.content).toMatch(/^\[nxis_list_types returned the kinds of records this site has\. To answer, search them with nxis_query next/);
  });

  it('may itself be the answer, in words, when the visitor asked what there is', async () => {
    const s = setup([listTypes, { text: 'I can tell you about our plumbers and the emergency line.' }]);
    await s.harness.turn('What information is available here?', s.messages as never);
    expect(s.calls.map((c) => c.name)).toEqual(['nxis_list_types']);
    expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: 'I can tell you about our plumbers and the emergency line.' });
  });

  it('with nothing said after it, is not stood in for as "what I found"', async () => {
    const s = setup([listTypes, { text: '' }, { text: '' }]);
    await s.harness.turn('What are your hours?', s.messages as never);
    expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: ANSWER_FALLBACK.none });
  });
});

describe('a reply with nothing in it after a read', () => {
  it('is asked for once more, with no tools, still as a step of the turn, and the nudge is not kept', async () => {
    const s = setup([query(), { text: '' }, { text: HOURS }]);
    await s.harness.turn('What are your hours?', s.messages as never);

    expect(s.completions()).toBe(3);
    const nudged = s.seen[2];
    expect(nudged.tools).toEqual([]);
    const last = nudged.messages.at(-1)!;
    // Still the tool result, with its data block, so a model proxy reads it as a step and not a new visitor turn.
    expect(last.role).toBe('user');
    expect(last.content).toMatch(/^\[nxis_query returned\] Now answer the visitor/);
    expect(last.content).toMatch(/<data-[a-z0-9]+/);
    expect(s.messages.some((m) => m.content.includes(ANSWER_NOW))).toBe(false);
    expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: HOURS });
  });

  it('is asked for only once, then the cards stand with a plain line', async () => {
    const s = setup([query(), { text: '' }]);
    await s.harness.turn('What are your hours?', s.messages as never);
    expect(s.completions()).toBe(3);
    expect(s.said.at(-1)).toBe(ANSWER_FALLBACK.found);
    expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: ANSWER_FALLBACK.found });
  });

  it('counts the same read asked for again as nothing said, and does not run it twice', async () => {
    const s = setup([query(), query(), { text: HOURS }]);
    await s.harness.turn('What are your hours?', s.messages as never);
    expect(s.calls).toHaveLength(1);
    expect(s.drawn).toEqual(['nxis_query']);
    expect(s.messages.at(-1)!.content).toBe(HOURS);
  });
});

describe('the reads in one turn', () => {
  it(`stop at ${MAX_STEPS}: after the last, the model is offered nothing to call and answers`, async () => {
    const s = setup((n) => (n < 10 ? query(`try ${n}`) : { text: '' }));
    await s.harness.turn('What are your hours?', s.messages as never);
    expect(s.calls).toHaveLength(MAX_STEPS);
    // The read after the last one allowed: no tools, then the one nudge, then the plain line.
    expect(s.seen.at(-2)!.tools).toEqual([]);
    expect(s.seen.at(-1)!.tools).toEqual([]);
    expect(s.completions()).toBe(MAX_STEPS + 2);
    expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: ANSWER_FALLBACK.found });
  });

  it('a write after a read is confirmed, and the turn waits for the visitor there', async () => {
    const s = setup([query(), { text: 'I can send a quote request.', call: { name: 'quote_form', args: { email: 'a@b.example' } } }]);
    await s.harness.turn('Can I get a quote?', s.messages as never);
    expect(s.calls.map((c) => c.name)).toEqual(['nxis_query']);
    expect(s.confirms).toHaveLength(1);
    expect(s.completions()).toBe(2);
  });

  it('a read confirmed by the visitor is answered after it runs', async () => {
    const s = setup([query(), { text: HOURS }], { guardrails: { tools: { tier: { nxis_query: 'high' } } } });
    await s.harness.turn('What are your hours?', s.messages as never);
    expect(s.confirms).toHaveLength(1);
    s.confirms[0].onSubmit(s.confirms[0].values);
    await vi.waitFor(() => expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: HOURS }));
    expect(s.calls.map((c) => c.name)).toEqual(['nxis_query']);
  });

  it('an answer still coming when the visitor sends again is dropped, and the new turn goes on', async () => {
    let next: Promise<unknown> | undefined;
    const s = setup(
      (n) => {
        if (n === 0) return query();
        // The answer to the confirmed read, overtaken by a new message.
        if (n === 1) {
          next = s.harness.turn('And on Sunday?', s.messages as never);
          return { text: 'A stale answer.' };
        }
        return { text: 'Only the emergency line is open on Sunday.' };
      },
      { guardrails: { tools: { tier: { nxis_query: 'high' } } } },
    );
    await s.harness.turn('What are your hours?', s.messages as never);
    s.confirms[0].onSubmit(s.confirms[0].values);
    await vi.waitFor(() => expect(next).toBeDefined());
    await next;
    expect(s.messages.map((m) => m.content)).not.toContain('A stale answer.');
    expect(s.said).not.toContain('A stale answer.');
    expect(s.messages.at(-1)).toEqual({ role: 'assistant', content: 'Only the emergency line is open on Sunday.' });
  });

  it('a stop while the model answers keeps the cards and drops the unfinished answer', async () => {
    let harness!: AgentHarness;
    const s = setup((n) => {
      if (n === 0) return query();
      harness.stop();
      return { text: 'We are open' };
    });
    harness = s.harness;
    const result = await s.harness.turn('What are your hours?', s.messages as never);
    expect(result.decision).toBe('stopped');
    expect(s.drawn).toEqual(['nxis_query']);
    expect(s.messages.at(-1)!.content).toBe('[nxis_query returned]');
    expect(s.said).not.toContain('We are open');
  });
});
