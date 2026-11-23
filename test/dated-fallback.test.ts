// @vitest-environment happy-dom
/**
 * A dated search that finds nothing in its time says so in words, then shows the next events from now on, soonest
 * first. With nothing coming up either, it says that and offers past events or everything the site lists. It never
 * ends on "No results found." alone. A time that has events, and a search with no time, are as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { datedQuery, rangeFor, rangeWords } from '../src/harness/when';
import { mapQueryArgs } from '../src/harness/tools/bridge';
import '../src/ui/agent';

// Monday, November 16, 2026, 10:00 local.
const monday = new Date(2026, 10, 16, 10);

type Rec = { name: string; startDate: string; endDate?: string };

/** A server holding these records: it sorts by start date when asked, and pages them two at a time. */
function server(records: Rec[]) {
  const calls: Record<string, unknown>[] = [];
  const call = async (args: Record<string, unknown>) => {
    calls.push(args);
    const sort = (args.filter as { sort_option?: { property?: string } } | undefined)?.sort_option?.property;
    const all = sort === 'startDate' ? [...records].sort((a, b) => a.startDate.localeCompare(b.startDate)) : records;
    const at = Number(args.page_token ?? 0);
    const page = all.slice(at, at + 2).map((r) => ({ '@type': 'Event', ...r }));
    const body = { results: page, total: records.length, next_page_token: at + 2 < all.length ? String(at + 2) : null };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  };
  return { calls, call };
}

const run = (input: Record<string, unknown>, records: Rec[]) => {
  const s = server(records);
  return datedQuery(input, s.call as never, mapQueryArgs).then((res) => ({ res, body: res.structuredContent as any, calls: s.calls }));
};

const in2027: Rec[] = [
  { name: 'Spring gala', startDate: '2027-04-10T19:00:00' },
  { name: 'Winter market', startDate: '2027-01-15' },
  { name: 'Last year', startDate: '2025-11-21' },
  { name: 'Jazz night', startDate: '2027-02-05T20:00:00' },
  { name: 'Film club', startDate: '2027-03-01T18:00:00' },
  { name: 'Book fair', startDate: '2027-05-20' },
  { name: 'Summer fete', startDate: '2027-06-12' },
];

describe('a dated search that finds nothing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(monday);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('names the time in plain words', () => {
    const words = (input: Record<string, unknown>) => {
      const range = rangeFor(String(input.when ?? ''), monday) ?? { from: -Infinity, to: Infinity };
      return rangeWords(input, range, monday);
    };
    expect(words({ when: 'this weekend' })).toBe('this weekend');
    expect(words({ when: 'on the weekend' })).toBe('this weekend');
    expect(words({ when: 'tonight' })).toBe('tonight');
    expect(words({ when: 'in July' })).toBe('in July');
    expect(words({ when: '2026-11-21' })).toBe('Saturday, November 21');
    const days = (from: string, to: string) => rangeWords({ from, to }, { from: new Date(from + 'T00:00').getTime(), to: new Date(to + 'T23:59').getTime() }, monday);
    expect(days('2026-11-21', '2026-11-21')).toBe('Saturday, November 21');
    expect(days('2026-11-21', '2027-01-03')).toBe('between November 21 and January 3, 2027');
  });

  it("says nothing's on this weekend, and returns the next five from now, soonest first, marked upcoming", async () => {
    const { body, calls } = await run({ schema_type: 'Event', when: 'this weekend' }, in2027);
    expect(body.notice).toBe("Nothing's on this weekend. The next events are:");
    expect(body.upcoming).toBe(true);
    expect(body.results.map((r: Rec) => r.name)).toEqual(['Winter market', 'Jazz night', 'Film club', 'Spring gala', 'Book fair']);
    expect(body.total).toBe(5);
    expect(body.date_range).toBe('2026-11-20 to 2026-11-22');
    // The second search is soonest first too.
    expect(calls.at(-1)!.filter).toMatchObject({ sort_option: { property: 'startDate', order: 'ASCENDING' } });
    // The notice leads what the model reads.
    expect(JSON.stringify(body).startsWith('{"notice":')).toBe(true);
  });

  it('says "the next event is" for one', async () => {
    const { body } = await run({ schema_type: 'Event', when: 'tonight' }, [{ name: 'Only one', startDate: '2027-01-15' }]);
    expect(body.notice).toBe("Nothing's on tonight. The next event is:");
    expect(body.results).toHaveLength(1);
  });

  it('with nothing upcoming either, says so and offers past events', async () => {
    const { body } = await run({ schema_type: 'Event', when: 'this weekend' }, [{ name: 'Last year', startDate: '2025-11-21' }]);
    expect(body.notice).toBe("Nothing's on this weekend, and there are no upcoming events. I can show past events, or everything the site lists.");
    expect(body.upcoming).toBe(false);
    expect(body.results).toEqual([]);
  });

  it('keeps a time that has events as it was', async () => {
    const records = [...in2027, { name: 'Saturday jazz', startDate: '2026-11-21T20:00:00' }];
    const { body, calls } = await run({ schema_type: 'Event', when: 'this weekend' }, records);
    expect(body.results.map((r: Rec) => r.name)).toEqual(['Saturday jazz']);
    expect(body.notice).toBeUndefined();
    expect(body.upcoming).toBeUndefined();
    // Two pages of the one search, the second starting after the weekend: no search for what's next.
    expect(calls).toHaveLength(2);
  });

  it('leaves a search with no time alone', async () => {
    const { res, calls } = await run({ schema_type: 'Event' }, in2027);
    expect(calls).toHaveLength(1);
    expect(JSON.parse((res.content as { text: string }[])[0].text).notice).toBeUndefined();
  });

  const agent = (): any => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    return el;
  };
  const tool = { name: 'nxis_query', annotations: { readOnlyHint: true } };

  it('draws the lead-in line, then the next events as cards', async () => {
    const { res } = await run({ schema_type: 'Event', when: 'this weekend' }, in2027);
    const el = agent();
    const said: string[] = [];
    el._appendMsg = (_r: string, t: string) => said.push(t);
    el._renderer().results(tool, res);
    expect(said).toEqual(["Nothing's on this weekend. The next events are:"]);
    const item = el._active().items.at(-1);
    expect(item.kind).toBe('results');
    expect(item.cards.map((c: { title: string }) => c.title)).toEqual(['Winter market', 'Jazz night', 'Film club', 'Spring gala', 'Book fair']);
  });

  it('with nothing upcoming, says so in place of "No results found."', async () => {
    const { res } = await run({ schema_type: 'Event', when: 'this weekend' }, []);
    const el = agent();
    const said: string[] = [];
    el._appendMsg = (_r: string, t: string) => said.push(t);
    el._renderer().results(tool, res);
    expect(said).toEqual(["Nothing's on this weekend, and there are no upcoming events. I can show past events, or everything the site lists."]);
    expect(el.shadowRoot.textContent).not.toMatch(/No results found/);
  });
});
