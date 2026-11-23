// @vitest-environment happy-dom
/**
 * A page's search or filter form (`method="get"`) is a read: it runs with no confirmation, opens its results page,
 * and is worded as a lookup. The model is pointed at the site's records first, with a time read on the visitor's
 * clock. And a form's id or its page's path never stands in for a name in what the visitor reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSiteActionTools,
  formNoun,
  handoffFor,
  pageTitle,
  readsOnly,
  resultsUrl,
  setPageTitles,
  withoutSiteSuffix,
  READ_FORM_LAST,
} from '../src/harness/tools/action-tools';
import { parseAction } from '../src/harness/tools/site-actions';
import { LocalModelContext } from '../src/harness/tools/local-context';
import { decide, policyFor } from '../src/harness/policy';
import { narrateCall } from '../src/harness/harness';
import { registerRemoteTools } from '../src/harness/tools/bridge';
import { onDuring, queryRange, rangeFor } from '../src/harness/when';
import { DEFAULT_SYSTEM_PROMPT } from '../src/ui/config';
import '../src/ui/agent';
import type { NxisAction } from '../src/webmcp-contract';

const ORIGIN = 'https://events.example';
const EVENTS = `${ORIGIN}/events/`;

const input = (valueName: string, extra: Record<string, unknown> = {}) => ({
  '@type': 'PropertyValueSpecification',
  valueName,
  'nxis:valueType': 'string' as const,
  ...extra,
});

/** `<form id="filters" method="get" action="/events/">`, as the crawler records it. */
const filters: NxisAction = {
  '@type': 'InteractAction',
  '@id': 'urn:nxis:action:filters',
  name: 'filters',
  target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': EVENTS },
  input: [input('q'), input('category'), input('when')],
};

/** A contact form with no method: the crawler records GET, and it still sends a message. */
const contact: NxisAction = {
  '@type': 'InteractAction',
  '@id': 'urn:nxis:action:contact',
  name: 'contact',
  target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': `${ORIGIN}/contact/` },
  input: [input('your_name'), input('email'), input('message')],
};

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

afterEach(() => {
  setPageTitles([]);
  vi.restoreAllMocks();
});

describe('a GET form is a read', () => {
  it('is read-only when it searches or filters, and not when it asks for what a sent form would', () => {
    expect(readsOnly(filters)).toBe(true);
    expect(readsOnly(contact)).toBe(false);
    expect(readsOnly({ ...filters, target: { ...filters.target, httpMethod: 'POST' } })).toBe(false);
    // A script handles it: it may send it anywhere, unless the form says it is a search.
    const scripted = { ...filters, target: { ...filters.target, 'nxis:jsHandled': true } };
    expect(readsOnly(scripted)).toBe(false);
    expect(readsOnly({ ...scripted, '@type': 'SearchAction' })).toBe(true);
    expect(readsOnly({ ...filters, input: [input('resume', { 'nxis:valueType': 'file' })] })).toBe(false);
  });

  it('becomes a read-only tool: no confirmation, and a description that puts the records first', () => {
    const [tool] = buildSiteActionTools([filters], new LocalModelContext(), { href: `${ORIGIN}/` });
    expect(tool.definition.annotations?.readOnlyHint).toBe(true);
    expect(decide(policyFor(tool.definition), 0)).toBe('execute');
    expect(tool.definition.description).toContain('sends nothing');
    expect(tool.definition.description).toContain(READ_FORM_LAST);
    expect(READ_FORM_LAST).toMatch(/nxis_query first/);

    const [write] = buildSiteActionTools([contact], new LocalModelContext(), { href: `${ORIGIN}/` });
    expect(write.definition.annotations?.readOnlyHint).toBe(false);
    expect(decide(policyFor(write.definition), 0)).toBe('confirm');
  });

  it('builds its results URL as the browser would submit it', () => {
    expect(resultsUrl(filters, { q: 'jazz', category: '', when: undefined })).toBe(`${EVENTS}?q=jazz`);
    expect(resultsUrl(filters, { category: ['music', 'film'], free: true })).toBe(`${EVENTS}?category=music&category=film&free=on`);
    // The crawler's template for where the form submits: its expressions are the fields.
    const observed = { ...filters, target: { ...filters.target, 'nxis:observedUrl': `${ORIGIN}/search?q={q}&category={category}` } };
    expect(resultsUrl(observed, { q: 'jazz' })).toBe(`${ORIGIN}/search?q=jazz`);
    const raw = parseAction({
      '@type': 'SearchAction',
      '@id': 'urn:x',
      name: 'search',
      target: { '@type': 'EntryPoint', httpMethod: 'get', 'nxis:pageUrl': EVENTS, 'nxis:observedUrl': `${ORIGIN}/search?q={q}` },
    });
    expect(raw?.target['nxis:observedUrl']).toBe(`${ORIGIN}/search?q={q}`);
    expect(raw && readsOnly(raw)).toBe(true);
  });

  it('opens its results page, keeping the conversation, with no send wording', async () => {
    setPageTitles([{ url: EVENTS, name: "What's on | Wrenfield" }]);
    const visited: string[] = [];
    const storage = memoryStorage();
    const [tool] = buildSiteActionTools([filters], new LocalModelContext(), {
      href: `${ORIGIN}/`,
      storage,
      navigate: (url) => visited.push(url),
    });
    const res = await tool.definition.execute({ q: 'jazz' });
    expect(res.isError).toBeFalsy();
    expect(visited).toEqual([`${EVENTS}?q=jazz`]);
    expect(res.content[0].text).toBe("Opening What's on…");
    expect(res.content[0].text).not.toMatch(/send|submit/i);
    expect(JSON.parse(storage.getItem('nxis:pending-visit:v1')!).pageUrl).toBe(`${EVENTS}?q=jazz`);
    // Nothing is held to be submitted on arrival.
    expect(storage.getItem('nxis:pending-action:v1')).toBeNull();
  });

  it('says "the results" when the page has no title it knows, never its path', async () => {
    const visited: string[] = [];
    const [tool] = buildSiteActionTools([filters], new LocalModelContext(), {
      href: `${ORIGIN}/`,
      storage: memoryStorage(),
      navigate: (url) => visited.push(url),
    });
    const res = await tool.definition.execute({});
    expect(res.content[0].text).toBe('Opening the results…');
    expect(visited).toEqual([EVENTS]);
  });

  it('is narrated as a lookup', () => {
    const [tool] = buildSiteActionTools([filters], new LocalModelContext(), { href: `${ORIGIN}/` });
    expect(narrateCall({ name: tool.name, args: {} }, [tool.definition])).toBe('Looking that up.');
  });
});

describe('names, not ids or paths', () => {
  it('calls a form by its name only where that reads as one', () => {
    expect(formNoun('filters_anywhere')).toBe('form');
    expect(formNoun('pass_form_anywhere_3')).toBe('pass form');
    expect(formNoun('quote-form')).toBe('quote form');
    expect(formNoun('booking_request_anywhere')).toBe('booking request');
    expect(withoutSiteSuffix('quote_form_anywhere_2')).toBe('quote_form');
  });

  it('narrates a write by what the form is called, or "form"', () => {
    const write = { name: 'filters_anywhere', annotations: { readOnlyHint: false } };
    expect(narrateCall({ name: write.name, args: {} }, [write])).toBe('Filling in the form.');
    expect(narrateCall({ name: 'quote-form', args: {} }, [{ name: 'quote-form' }])).toBe('Filling in the quote form.');
  });

  it("names a form's page by its title, never by its path", () => {
    const other = { ...contact, '@id': 'urn:other', target: { ...contact.target, 'nxis:pageUrl': `${ORIGIN}/visit/` } };
    const [tool] = buildSiteActionTools([contact, other], new LocalModelContext(), { href: `${ORIGIN}/` });
    // The added chooser's values are paths; the label is not.
    expect(handoffFor(tool.definition, { target: 'contact' }, `${ORIGIN}/`)?.label).toBe('');
    setPageTitles([{ url: `${ORIGIN}/contact/`, name: 'Get in touch | Wrenfield' }]);
    expect(handoffFor(tool.definition, { target: 'contact' }, `${ORIGIN}/`)?.label).toBe('Get in touch');
    expect(pageTitle(`${ORIGIN}/contact/?x=1`)).toBe('Get in touch');
  });
});

describe('what the card and the thread say', () => {
  const agent = (): any => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    return el;
  };

  it('never sends "this filters" to "events"', () => {
    document.title = 'Home | Wrenfield';
    const el = agent();
    const [tool] = buildSiteActionTools([{ ...filters, target: { ...filters.target, httpMethod: 'POST' } }], new LocalModelContext(), {
      href: `${ORIGIN}/`,
    });
    const { view } = el._describeAction(tool.definition, { q: 'jazz' }, '');
    expect(view.sentence).toBe("I'll send this form for you.");
    expect(view.noun).toBe('form');
    // Another page, with no title known: the site, not the current page or the path.
    expect(view.identity.name).toBe('Wrenfield');
    expect(`${view.sentence} ${view.identity.name} ${view.identity.sub}`).not.toMatch(/filters|events/i);
  });

  it('still names the business a form is for', () => {
    const el = agent();
    const tool = { name: 'quote_form_anywhere', annotations: { readOnlyHint: false } };
    const { view } = el._describeAction(tool, { business: 'McGreevy Plumbing' });
    expect(view.sentence).toBe("I'll send this quote form to McGreevy Plumbing.");
  });

  it('opens the page with no possessive name', () => {
    const el = agent();
    const tool = { name: 'filters_anywhere' };
    const item = { stage: 'review', identity: { name: 'events' } } as any;
    el._live = { tool, item };
    el._paintAction = () => {};
    el._cardLeft(tool, 'events');
    expect(item.message).toBe('Opening the form’s own page to send it from there.');

    const said: string[] = [];
    el._appendMsg = (_r: string, t: string) => said.push(t);
    el._cardLeft({ name: 'filters_anywhere', annotations: { readOnlyHint: true } }, null);
    expect(said).toEqual(['Opening the results…']);
  });
});

describe('the records first, with a time read on the visitor’s clock', () => {
  // Monday, November 16, 2026, 10:00 local.
  const monday = new Date(2026, 10, 16, 10);
  const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

  it('reads the times a visitor names', () => {
    expect(rangeFor('this weekend', monday)).toEqual({ from: at(2026, 11, 20, 17), to: at(2026, 11, 23) - 1 });
    // On Saturday, what is left of it.
    const saturday = new Date(2026, 10, 21, 14);
    expect(rangeFor('this weekend', saturday)).toEqual({ from: saturday.getTime(), to: at(2026, 11, 23) - 1 });
    expect(rangeFor('tonight', monday)).toEqual({ from: at(2026, 11, 16, 17), to: at(2026, 11, 17) - 1 });
    expect(rangeFor('tomorrow', monday)).toEqual({ from: at(2026, 11, 17), to: at(2026, 11, 18) - 1 });
    expect(rangeFor('next week', monday)).toEqual({ from: at(2026, 11, 23), to: at(2026, 11, 30) - 1 });
    // July has passed this year: next year's.
    expect(rangeFor('in July', monday)).toEqual({ from: at(2027, 7, 1), to: at(2027, 8, 1) - 1 });
    expect(rangeFor('this month', monday)).toEqual({ from: at(2026, 11, 16), to: at(2026, 12, 1) - 1 });
    expect(rangeFor('2026-12-05', monday)).toEqual({ from: at(2026, 12, 5), to: at(2026, 12, 6) - 1 });
    expect(rangeFor('whenever', monday)).toBeNull();
    expect(queryRange({ from: '2026-12-01', to: '2026-12-02' }, monday)).toEqual({ from: at(2026, 12, 1), to: at(2026, 12, 3) - 1 });
    expect(queryRange({ schema_type: 'Event' }, monday)).toBeNull();
  });

  it('keeps what is on during the time, including what began before it', () => {
    const weekend = rangeFor('this weekend', monday)!;
    expect(onDuring({ startDate: '2026-11-21T19:30:00' }, weekend)).toBe(true);
    expect(onDuring({ startDate: '2026-11-22' }, weekend)).toBe(true);
    expect(onDuring({ startDate: '2026-11-01', endDate: '2026-11-30' }, weekend)).toBe(true);
    expect(onDuring({ startDate: '2026-11-18T19:30:00' }, weekend)).toBe(false);
    expect(onDuring({ 'https://schema.org/startDate': '2026-11-24' }, weekend)).toBe(false);
    expect(onDuring({ name: 'No date' }, weekend)).toBe(false);
  });

  it("nxis_query takes when, reads soonest first, and returns only what is on", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(monday);
    try {
      const calls: Record<string, unknown>[] = [];
      const records = [
        { '@type': 'Event', name: 'Last week', startDate: '2026-11-10' },
        { '@type': 'Event', name: 'Saturday jazz', startDate: '2026-11-21T20:00:00' },
        { '@type': 'Event', name: 'Next month', startDate: '2026-12-10' },
      ];
      let registered: any;
      const client = {
        listTools: async () => ({ tools: [{ name: 'nxis_query' }] }),
        callTool: async ({ arguments: args }: { arguments: Record<string, unknown> }) => {
          calls.push(args);
          return { content: [{ type: 'text', text: JSON.stringify({ results: records, total: 3 }) }] };
        },
      };
      const mc = { getTools: async () => [], registerTool: (t: unknown) => void (registered = t) };
      await registerRemoteTools(client as never, mc as never, { publicTools: [] } as never);

      expect(registered.description).toMatch(/Use this first for questions that find, list or show things/);
      expect(registered.description).toMatch(/Today is Monday, 2026-11-16\./);
      expect(Object.keys(registered.inputSchema.properties)).toEqual(expect.arrayContaining(['when', 'from', 'to']));

      const res = await registered.execute({ schema_type: 'Event', when: 'this weekend' });
      const filter = calls[0].filter as Record<string, unknown>;
      expect(filter.sort_option).toEqual({ property: 'startDate', order: 'ASCENDING' });
      expect(calls[0].limit).toBe(100);
      expect(res.structuredContent.results.map((r: { name: string }) => r.name)).toEqual(['Saturday jazz']);
      expect(res.structuredContent.date_range).toBe('2026-11-20 to 2026-11-22');

      // No time asked: one call, as before.
      calls.length = 0;
      await registered.execute({ schema_type: 'Event' });
      expect(calls).toHaveLength(1);
      expect(calls[0].limit).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the default instructions say the same', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/search the site's records with nxis_query/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Use a page form only to do something the records cannot/);
  });
});
