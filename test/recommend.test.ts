/**
 * Recommending a result: the facts a record yields, whether it is open now,
 * and which of the model's reasons survive the check against the record.
 */
import { describe, expect, it } from 'vitest';
import { extractRecords, openStatus, recordFacts } from '../src/harness/records';
import { grounded, recommend, RECOMMEND_TOOL } from '../src/harness/recommend';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const drainPros = {
  '@type': 'Plumber',
  '@id': 'https://listings.example/listings/royal-oak-drain-pros.html#organization',
  name: 'Royal Oak Drain Pros',
  description: "Drain and sewer specialists serving Royal Oak 24 hours a day. If it's backed up, we're on the way.",
  telephone: '(248) 555-3271',
  foundingDate: '2009-01-01',
  aggregateRating: { ratingValue: 4.7, reviewCount: 412 },
  review: [{ author: { name: 'Pat M.' }, reviewBody: 'Mainline clog at 11pm on a Sunday. They had a tech here in 40 minutes.' }],
  openingHoursSpecification: [{ dayOfWeek: [...WEEKDAYS, 'Saturday', 'Sunday'], opens: '00:00', closes: '23:59' }],
  makesOffer: [{ itemOffered: { name: 'Emergency Drain Cleaning', description: '24/7 response, hydro-jetting, augering.' } }, { itemOffered: { name: 'Sewer Backup' } }],
  knowsAbout: ['24/7 emergency', 'drain & sewer', 'sump pumps'],
};

const hatzel = {
  '@type': 'Plumber',
  '@id': 'https://listings.example/listings/hatzel-and-sons-plumbing.html#organization',
  name: 'Hatzel & Sons Plumbing',
  telephone: '(248) 543-1962',
  foundingDate: '1962-01-01',
  aggregateRating: { ratingValue: 4.9, reviewCount: 287 },
  openingHoursSpecification: [
    { dayOfWeek: WEEKDAYS, opens: '07:00', closes: '17:00' },
    { dayOfWeek: ['https://schema.org/Saturday'], opens: '08:00', closes: '13:00' },
  ],
  makesOffer: [{ itemOffered: { name: 'Water Heaters' } }, { itemOffered: { name: 'Sewer Line Service' } }],
};

// Tuesday 30 September 2026, 8:40pm local time.
const EVENING = new Date(2026, 8, 29, 20, 40);

describe('open now', () => {
  it('reads round-the-clock hours as 24/7', () => {
    expect(openStatus(drainPros, EVENING)).toEqual({ open: true, label: 'Open now · 24/7', always: true });
  });

  it('says when a closed business opens next, today or tomorrow by time, later by day', () => {
    expect(openStatus(hatzel, EVENING)?.label).toBe('Opens 7am');
    expect(openStatus(hatzel, new Date(2026, 8, 29, 10, 0))?.label).toBe('Open now · until 5pm');
    // Saturday 2pm: closed until Monday.
    expect(openStatus(hatzel, new Date(2026, 9, 3, 14, 0))?.label).toBe('Opens Mon 7am');
  });

  it('reads the compact form too, and nothing it cannot read', () => {
    expect(openStatus({ openingHours: 'Mo-Fr 08:00-17:00' }, new Date(2026, 8, 29, 9, 0))?.label).toBe('Open now · until 5pm');
    expect(openStatus({ name: 'No hours' }, EVENING)).toBeNull();
  });
});

describe('records', () => {
  it('finds the records in any wrapping of the response', () => {
    const body = { results: [drainPros, hatzel], total: 2 };
    expect(extractRecords({ content: [{ type: 'text', text: JSON.stringify(body) }] })).toHaveLength(2);
    expect(extractRecords({ content: [], structuredContent: body })).toHaveLength(2);
    expect(extractRecords(JSON.stringify(JSON.stringify(body)))).toHaveLength(2);
  });

  it('reads a record as the facts a visitor compares by', () => {
    const f = recordFacts(drainPros, EVENING);
    expect(f).toMatchObject({ name: 'Royal Oak Drain Pros', rating: 4.7, reviewCount: 412, since: 2009, phone: '(248) 555-3271' });
    expect(f.services.map((s) => s.name)).toEqual(['Emergency Drain Cleaning', 'Sewer Backup']);
    expect(f.reviews[0]).toEqual({ text: 'Mainline clog at 11pm on a Sunday. They had a tech here in 40 minutes.', author: 'Pat M.' });
  });
});

describe('grounding', () => {
  const f = recordFacts(drainPros, EVENING);
  it('keeps a reason the record states', () => {
    expect(grounded('Open around the clock, 24/7.', f)).toBe(true);
    expect(grounded('A reviewer had a tech there in 40 minutes.', f)).toBe(true);
    expect(grounded('Rated 4.7 from 412 reviews.', f)).toBe(true);
  });

  it('drops a number the record does not state', () => {
    expect(grounded('Rated 4.9 by 500 customers.', f)).toBe(false);
    expect(grounded('Drain cleaning from $99.', f)).toBe(false);
  });

  it('checks a claim about hours against the hours, not the words', () => {
    const closed = recordFacts(hatzel, EVENING);
    expect(grounded('Open now for your emergency.', closed)).toBe(false);
    expect(grounded('Open around the clock.', closed)).toBe(false);
    expect(grounded('Open now for your emergency.', recordFacts(hatzel, new Date(2026, 8, 29, 10, 0)))).toBe(true);
  });

  it('drops a reason that shares nothing with the record, or is about another result', () => {
    expect(grounded('Friendly and affordable.', f)).toBe(false);
    expect(grounded('Better than Hatzel & Sons Plumbing for drains.', f, ['hatzel & sons plumbing'])).toBe(false);
  });
});

describe('recommend', () => {
  const provider = (reply: Partial<{ text: string; call: { name: string; args: Record<string, unknown> } }>) => {
    const seen: unknown[] = [];
    return {
      seen,
      p: {
        name: 'scripted',
        ready: true,
        loading: false,
        complete: async (req: unknown) => {
          seen.push(req);
          return { text: '', ...reply };
        },
      } as never,
    };
  };
  const goal = 'Our basement drain is backing up. Who can come out?';

  it('keeps the pick and the reasons the record backs, and drops the rest', async () => {
    const { p, seen } = provider({
      call: {
        name: RECOMMEND_TOOL,
        args: {
          pick: 1,
          lead: "For a backup happening now, I'd call Royal Oak Drain Pros.",
          reasons: ['Open now, 24/7.', 'Drain and sewer backups are their specialty.', 'Charges only $79 for a visit.'],
        },
      },
    });
    const pick = await recommend({ provider: p, goal, records: [drainPros, hatzel], now: EVENING });
    expect(pick).toEqual({
      index: 0,
      key: drainPros['@id'],
      lead: "For a backup happening now, I'd call Royal Oak Drain Pros.",
      reasons: ['Open now, 24/7.', 'Drain and sewer backups are their specialty.'],
    });
    // The model saw both results, their hours as read now, and the question.
    const sent = JSON.stringify(seen[0]);
    expect(sent).toContain('Open now · 24/7');
    expect(sent).toContain('Opens 7am');
    expect(sent).toContain('basement drain');
  });

  it('writes its own lead when the model’s names nobody or says too much', async () => {
    const { p } = provider({ call: { name: RECOMMEND_TOOL, args: { pick: 2, lead: 'This one is 100% the best.', reasons: ['Rated 4.9 from 287 reviews.'] } } });
    const pick = await recommend({ provider: p, goal, records: [drainPros, hatzel], now: EVENING });
    expect(pick?.lead).toBe("I'd go with Hatzel & Sons Plumbing.");
  });

  it('gives no pick when nothing the model said is backed, or it picked nothing that exists', async () => {
    const vague = provider({ call: { name: RECOMMEND_TOOL, args: { pick: 1, lead: 'Royal Oak Drain Pros.', reasons: ['Friendly and affordable.'] } } });
    expect(await recommend({ provider: vague.p, goal, records: [drainPros, hatzel], now: EVENING })).toBeNull();
    const missing = provider({ call: { name: RECOMMEND_TOOL, args: { pick: 5, lead: 'x', reasons: ['Open now.'] } } });
    expect(await recommend({ provider: missing.p, goal, records: [drainPros, hatzel], now: EVENING })).toBeNull();
    const prose = provider({ text: 'They all look good!' });
    expect(await recommend({ provider: prose.p, goal, records: [drainPros, hatzel], now: EVENING })).toBeNull();
  });

  it('reads a pick written as JSON, and asks nothing about a single result', async () => {
    const json = provider({ text: '{"pick": 1, "lead": "Royal Oak Drain Pros is open now.", "reasons": ["Open now, 24/7."]}' });
    expect((await recommend({ provider: json.p, goal, records: [drainPros, hatzel], now: EVENING }))?.index).toBe(0);
    const one = provider({});
    expect(await recommend({ provider: one.p, goal, records: [drainPros], now: EVENING })).toBeNull();
    expect(one.seen).toHaveLength(0);
  });
});

describe('a search turn', () => {
  const run = async (opts: { recommend?: boolean; reply: () => unknown }) => {
    const shown: unknown[] = [];
    const bubble = { thinking() {}, update() {}, finalize() {} };
    const renderer = {
      streaming: () => bubble,
      message() {},
      status() {},
      confirm() {},
      ask() {},
      detail() {},
      toolError() {},
      results: (_tool: unknown, _res: unknown, extra?: unknown) => shown.push(extra),
    };
    const tool = { name: 'nxis_query', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } };
    let n = 0;
    const provider = {
      ready: true,
      load: async () => {},
      complete: async () => (n++ === 0 ? { text: '', call: { name: 'nxis_query', args: { text: 'plumber' } } } : opts.reply()),
    };
    const toolSource = {
      discoverTools: async () => [tool],
      execTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ results: [drainPros, hatzel] }) }] }),
    };
    const { AgentHarness } = await import('../src/index');
    const messages: { role: string; content: string }[] = [];
    const harness = new AgentHarness({ provider, toolSource, renderer, recommend: opts.recommend, now: () => EVENING } as never);
    await harness.turn('Our basement drain is backing up. Who can come out?', messages as never);
    return { shown, messages, calls: n };
  };

  it('ends with the pick, and tells the model what it recommended', async () => {
    const { shown, messages } = await run({
      reply: () => ({ text: '', call: { name: RECOMMEND_TOOL, args: { pick: 1, lead: 'Royal Oak Drain Pros is open now.', reasons: ['Open now, 24/7.'] } } }),
    });
    expect(shown[0]).toMatchObject({ pick: { index: 0, reasons: ['Open now, 24/7.'] } });
    const returned = messages.find((m) => m.content === '[nxis_query returned]') as { data?: string } | undefined;
    expect(returned?.data).toContain('(You recommended Royal Oak Drain Pros: Open now, 24/7.)');
  });

  it('shows the plain results when recommendations are off, without asking for a pick', async () => {
    const { shown, calls, messages } = await run({ recommend: false, reply: () => ({ text: 'Royal Oak Drain Pros is open now, 24/7.' }) });
    expect(shown[0]).toBeUndefined();
    // The search, then the answer from it: no recommendation in between.
    expect(calls).toBe(2);
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'Royal Oak Drain Pros is open now, 24/7.' });
  });
});
