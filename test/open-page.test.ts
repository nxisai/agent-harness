/**
 * Getting from a result to its page.
 *
 * The record the agent shows is rarely the page: the demo's plumber says its
 * `url` is the site root, and the listing lives in a separate WebPage record.
 * These cover tracing one to the other, the tool that opens it, the visit that
 * carries the conversation across, and a model that writes a call out as text
 * instead of making it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  findPage,
  loadSitePages,
  mergePages,
  pageForEntity,
  pagesFromActions,
  parsePage,
  type SitePage,
} from '../src/harness/tools/site-pages';
import { buildOpenPageTool, resolveDestination, visitFor, OPEN_PAGE_TOOL } from '../src/harness/tools/open-page';
import {
  savePendingAction,
  savePendingVisit,
  setConversationSource,
  takePendingAction,
  takePendingVisit,
  PENDING_TTL_MS,
} from '../src/harness/tools/pending-action';
import { beginJourney, recordStep } from '../src/harness/steps';
import { readTranscribedCall } from '../src/harness/harness';
import type { NxisAction } from '../src/webmcp-contract';

const ORIGIN = 'https://listings.example';
const LISTING = `${ORIGIN}/listings/detroit-metro-plumbing.html`;

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

/** The two records the live server holds for one listing. */
const PLUMBER = {
  name: 'Detroit Metro Plumbing',
  url: ORIGIN,
  telephone: '(248) 555-6184',
  '@type': 'Plumber',
  '@id': `${ORIGIN}/#organization/detroit-metro-plumbing`,
};
const LISTING_PAGE = {
  url: '/listings/detroit-metro-plumbing.html',
  description: 'Residential and light commercial plumbing across the Detroit metro.',
  '@type': 'WebPage',
  name: 'Detroit Metro Plumbing',
  '@id': `${LISTING}/23400b565a31`,
};

const PAGES: SitePage[] = [
  { url: LISTING, name: 'Detroit Metro Plumbing' },
  { url: `${ORIGIN}/listings/royal-oak.html`, name: 'Royal Oak Remodeling' },
  { url: `${ORIGIN}/index.html`, name: 'Royal Oak Contractors' },
];

describe('reading pages', () => {
  it('resolves a page recorded by path against the origin', () => {
    expect(parsePage(LISTING_PAGE, ORIGIN)).toEqual({ url: LISTING, name: 'Detroit Metro Plumbing' });
  });

  it('reads IRI keys, and what the page says it is about', () => {
    const page = parsePage(
      {
        '@type': 'https://schema.org/ItemPage',
        'https://schema.org/url': LISTING,
        'https://schema.org/name': 'Listing',
        'https://schema.org/mainEntity': { '@id': PLUMBER['@id'] },
      },
      ORIGIN,
    );
    expect(page).toEqual({ url: LISTING, name: 'Listing', about: [PLUMBER['@id']] });
  });

  it('refuses pages on another origin, unnamed pages, and non-pages', () => {
    expect(parsePage({ ...LISTING_PAGE, url: 'https://evil.example/x' }, ORIGIN)).toBeNull();
    expect(parsePage({ ...LISTING_PAGE, name: undefined }, ORIGIN)).toBeNull();
    expect(parsePage(PLUMBER, ORIGIN)).toBeNull();
  });

  it('names an action page for the business its form is fixed to', () => {
    const action = {
      '@type': 'InteractAction',
      '@id': 'urn:a',
      name: 'quote-form',
      target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': LISTING },
      input: [
        { '@type': 'PropertyValueSpecification', valueName: 'business', 'nxis:valueType': 'string', defaultValue: 'Detroit Metro Plumbing' },
      ],
    } as NxisAction;
    expect(pagesFromActions([action], ORIGIN)).toEqual([{ url: LISTING, name: 'Detroit Metro Plumbing' }]);
  });

  it('keeps each page once, under the first name it was given', () => {
    const merged = mergePages([{ url: LISTING, name: 'Detroit Metro Plumbing' }], [{ url: `${LISTING}?x=1`, name: 'detroit metro plumbing' }]);
    expect(merged).toEqual([{ url: LISTING, name: 'Detroit Metro Plumbing' }]);
  });

  it('queries page records by type, and caches them', async () => {
    const calls: unknown[] = [];
    const client = {
      callTool: vi.fn(async (req: { arguments: unknown }) => {
        calls.push(req.arguments);
        return { content: [{ type: 'text', text: JSON.stringify({ results: [LISTING_PAGE, PLUMBER], total: 2 }) }] };
      }),
    } as unknown as Client;
    const storage = memoryStorage();
    const info = { endpoint: 'https://mcp.example.com/mcp' };
    expect(await loadSitePages(client, info, { origin: ORIGIN, storage })).toEqual([
      { url: LISTING, name: 'Detroit Metro Plumbing' },
    ]);
    await loadSitePages(client, info, { origin: ORIGIN, storage });
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ filter: { field_filters: [{ path: '@type', value: 'Page' }] } });
  });
});

describe('the page a result came from', () => {
  it('finds the listing for a business whose url is the site root', () => {
    expect(pageForEntity(PLUMBER, PAGES, ORIGIN)?.url).toBe(LISTING);
  });

  it('prefers the page the record names', () => {
    const named = { ...PLUMBER, mainEntityOfPage: `${ORIGIN}/listings/royal-oak.html` };
    expect(pageForEntity(named, PAGES, ORIGIN)?.name).toBe('Royal Oak Remodeling');
  });

  it("uses the record's own url when it is a page of this site", () => {
    const deep = { ...PLUMBER, name: 'Somebody', url: '/listings/somebody.html' };
    expect(pageForEntity(deep, PAGES, ORIGIN)).toEqual({ url: `${ORIGIN}/listings/somebody.html`, name: 'Somebody' });
  });

  it('reads the page from an id formed from it, without matching names', () => {
    const formed = { ...PLUMBER, name: 'Renamed Since', '@id': `${LISTING}#organization` };
    expect(pageForEntity(formed, [], ORIGIN)).toEqual({ url: LISTING, name: 'Renamed Since' });
  });

  it('reads no page from a site-wide id, or from the hash-suffixed ids stored before', () => {
    const siteWide = { ...PLUMBER, name: 'Nobody', '@id': `${ORIGIN}/#organization/nobody` };
    const suffixed = { ...PLUMBER, name: 'Nobody', '@id': `${LISTING}/23400b565a31` };
    expect(pageForEntity(siteWide, PAGES, ORIGIN)).toBeNull();
    expect(pageForEntity(suffixed, PAGES, ORIGIN)).toBeNull();
  });

  it('uses a page that says it is about the record', () => {
    const pages = [{ url: LISTING, name: 'Listing', about: [PLUMBER['@id']] }];
    expect(pageForEntity(PLUMBER, pages, ORIGIN)?.url).toBe(LISTING);
  });

  it('never links off the site, and gives up when it cannot tell', () => {
    const away = { ...PLUMBER, name: 'Nobody', url: 'https://evil.example/listing', mainEntityOfPage: 'https://evil.example/p' };
    expect(pageForEntity(away, PAGES, ORIGIN)).toBeNull();
    const twins = [...PAGES, { url: `${ORIGIN}/other.html`, name: 'Detroit Metro Plumbing' }];
    expect(pageForEntity(PLUMBER, twins, ORIGIN)).toBeNull();
  });
});

describe('finding a page by what someone called it', () => {
  it('matches names loosely, and addresses exactly', () => {
    expect(findPage('detroit metro plumbing', PAGES, ORIGIN)?.url).toBe(LISTING);
    expect(findPage('Detroit Metro', PAGES, ORIGIN)?.url).toBe(LISTING);
    expect(findPage('/listings/detroit-metro-plumbing.html', PAGES, ORIGIN)?.url).toBe(LISTING);
  });

  it('refuses what is ambiguous, unknown, or elsewhere', () => {
    expect(findPage('Royal Oak', PAGES, ORIGIN)).toBeNull();
    expect(findPage('Nowhere', PAGES, ORIGIN)).toBeNull();
    expect(findPage('https://evil.example/listings/detroit-metro-plumbing.html', PAGES, ORIGIN)).toBeNull();
  });
});

describe('the open_page tool', () => {
  const build = (href: string, storage: Storage | null = memoryStorage()) => {
    const visited: string[] = [];
    const tool = buildOpenPageTool(PAGES, {
      origin: ORIGIN,
      href,
      storage,
      navigate: (url) => visited.push(url),
      conversationId: () => 'conv-1',
    });
    return { tool, visited, storage };
  };

  it('lists the pages it can open, and needs no confirmation', () => {
    const { tool } = build(`${ORIGIN}/index.html`);
    expect(tool.name).toBe(OPEN_PAGE_TOOL);
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema?.properties?.page.enum).toContain('Detroit Metro Plumbing');
  });

  it('goes there, carrying the conversation and the journey', async () => {
    beginJourney();
    recordStep({ id: 'choose', label: 'Open page', status: 'done' });
    const { tool, visited, storage } = build(`${ORIGIN}/index.html`);
    const res = await tool.execute({ page: 'Detroit Metro Plumbing' });
    expect(res.isError).toBeFalsy();
    expect(visited).toEqual([LISTING]);
    expect(takePendingVisit(LISTING, { storage })).toMatchObject({
      pageUrl: LISTING,
      label: 'Detroit Metro Plumbing',
      conversationId: 'conv-1',
      steps: [{ id: 'choose' }],
    });
  });

  it('stays put on the page already open, and says why', async () => {
    const { tool, visited } = build(LISTING);
    const res = await tool.execute({ page: 'Detroit Metro Plumbing' });
    expect(res.content[0].text).toContain('already on');
    expect(visited).toEqual([]);
  });

  it('reports a page it does not know, with some it does', async () => {
    const { tool, visited } = build(`${ORIGIN}/index.html`);
    const res = await tool.execute({ page: 'The moon' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Royal Oak Remodeling');
    expect(visited).toEqual([]);
  });

  it('tells the harness where a call is going before it runs', () => {
    build(`${ORIGIN}/index.html`);
    expect(visitFor({ name: OPEN_PAGE_TOOL }, { page: 'Detroit Metro Plumbing' }, `${ORIGIN}/index.html`)).toEqual({
      pageUrl: LISTING,
      label: 'Detroit Metro Plumbing',
    });
    expect(visitFor({ name: OPEN_PAGE_TOOL }, { page: 'Detroit Metro Plumbing' }, LISTING)).toBeNull();
    expect(visitFor({ name: 'nxis_get' }, { page: 'Detroit Metro Plumbing' })).toBeNull();
  });
});

describe('home and back', () => {
  const HOME_PAGE = `${ORIGIN}/index.html`;

  it('reads the ways people say home', () => {
    for (const said of ['home', 'Home page', 'homepage', 'the home page', 'main page', 'start', 'take me home', 'Take me to the home page']) {
      expect(resolveDestination(said, PAGES, ORIGIN)).toMatchObject({ kind: 'home', url: HOME_PAGE });
    }
  });

  it('opens the site root when no page record is the home page', () => {
    expect(resolveDestination('home', PAGES.filter((p) => p.url !== HOME_PAGE), ORIGIN)).toEqual({
      kind: 'home',
      url: `${ORIGIN}/`,
      label: 'the home page',
    });
  });

  it('goes back to the page the visitor came from, when it is on this site', () => {
    const came = () => LISTING;
    for (const said of ['back', 'go back', 'previous page', 'the previous page', 'last page', 'Go back to previous page', 'go back to the previous page']) {
      expect(resolveDestination(said, PAGES, ORIGIN, { referrer: came })).toEqual({
        kind: 'back',
        url: LISTING,
        label: 'Detroit Metro Plumbing',
      });
    }
  });

  it('a page actually called that is a page, not a direction', () => {
    const pages = [...PAGES, { url: `${ORIGIN}/listings/back.html`, name: 'Back' }];
    expect(resolveDestination('back', pages, ORIGIN, { referrer: () => LISTING })).toMatchObject({ kind: 'page', label: 'Back' });
    expect(resolveDestination('Detroit Metro Plumbing', PAGES, ORIGIN)).toMatchObject({ kind: 'page' });
  });

  it('will not go back off the site, or with nowhere to go', () => {
    expect(resolveDestination('back', PAGES, ORIGIN, { referrer: () => 'https://www.google.com/' })).toMatchObject({ kind: 'none' });
    expect(resolveDestination('back', PAGES, ORIGIN, { referrer: () => '' })).toMatchObject({ kind: 'none' });
  });

  it('goes back through history rather than loading the page again, carrying the conversation', async () => {
    const storage = memoryStorage();
    const visited: string[] = [];
    let wentBack = 0;
    const tool = buildOpenPageTool(PAGES, {
      origin: ORIGIN,
      href: HOME_PAGE,
      storage,
      navigate: (url) => visited.push(url),
      back: () => wentBack++,
      referrer: () => LISTING,
      conversationId: () => 'conv-9',
    });
    const res = await tool.execute({ page: 'back' });
    expect(res.isError).toBeFalsy();
    expect(wentBack).toBe(1);
    expect(visited).toEqual([]);
    expect(takePendingVisit(LISTING, { storage })).toMatchObject({ conversationId: 'conv-9' });
  });

  it('offers home and back to the model, and says what they mean', () => {
    const tool = buildOpenPageTool(PAGES, { origin: ORIGIN });
    const page = tool.inputSchema?.properties?.page;
    expect(page?.enum?.slice(0, 2)).toEqual(['home', 'back']);
    expect(page?.description).toMatch(/"home".*"back"/);
  });

  it('tells the harness a back call is leaving, before it runs', () => {
    buildOpenPageTool(PAGES, { origin: ORIGIN, href: HOME_PAGE, referrer: () => LISTING });
    expect(visitFor({ name: OPEN_PAGE_TOOL }, { page: 'back' }, HOME_PAGE)).toEqual({ pageUrl: LISTING, label: 'Detroit Metro Plumbing' });
    expect(visitFor({ name: OPEN_PAGE_TOOL }, { page: 'home' }, HOME_PAGE)).toBeNull();
  });
});

describe('the visit that travels', () => {
  it('comes back on its own page, once, and not after it has gone stale', () => {
    const storage = memoryStorage();
    let t = 1_000_000;
    savePendingVisit({ pageUrl: LISTING, label: 'Detroit Metro Plumbing' }, { storage, now: () => t });
    expect(takePendingVisit(`${ORIGIN}/index.html`, { storage, now: () => t })).toBeNull();
    expect(takePendingVisit(LISTING, { storage, now: () => t })).not.toBeNull();
    expect(takePendingVisit(LISTING, { storage, now: () => t })).toBeNull();

    savePendingVisit({ pageUrl: LISTING, label: 'x' }, { storage, now: () => t });
    t += PENDING_TTL_MS + 1;
    expect(takePendingVisit(LISTING, { storage, now: () => t })).toBeNull();
    expect(storage.length).toBe(0);
  });
});

describe('which conversation a page change belongs to', () => {
  it('asks the owner of the conversation, whoever built the tools', async () => {
    // The listings demo's page script connects before the element does, so
    // the tools are built without the element's options.
    const storage = memoryStorage();
    setConversationSource(() => 'conv-open');
    try {
      const tool = buildOpenPageTool(PAGES, { origin: ORIGIN, href: `${ORIGIN}/index.html`, storage, navigate: () => {} });
      await tool.execute({ page: 'Detroit Metro Plumbing' });
      expect(takePendingVisit(LISTING, { storage })?.conversationId).toBe('conv-open');

      savePendingAction(
        { actionId: 'urn:a', pageToolName: 'quote_form', toolName: 'quote_form_anywhere', values: {}, pageUrl: LISTING },
        { storage },
      );
      expect(takePendingAction(LISTING, { storage })?.conversationId).toBe('conv-open');
    } finally {
      setConversationSource(null);
    }
  });

  it('keeps an id given explicitly, and survives an owner that throws', () => {
    const storage = memoryStorage();
    setConversationSource(() => {
      throw new Error('gone');
    });
    try {
      savePendingVisit({ pageUrl: LISTING, label: 'x' }, { storage });
      expect(takePendingVisit(LISTING, { storage })?.conversationId).toBeUndefined();
      savePendingVisit({ pageUrl: LISTING, label: 'x', conversationId: 'given' }, { storage });
      expect(takePendingVisit(LISTING, { storage })?.conversationId).toBe('given');
    } finally {
      setConversationSource(null);
    }
  });
});

describe('a call the model wrote out instead of making', () => {
  it('reads the notation the transcript uses', () => {
    const id = `${ORIGIN}/#organization/detroit-metro-plumbing`;
    expect(readTranscribedCall(`[called nxis_get with {"id":"${id}"}]`)).toEqual({
      said: '',
      call: { name: 'nxis_get', args: { id } },
    });
  });

  it('keeps what was said before it', () => {
    expect(readTranscribedCall('Sure.\n[called open_page with {"page":"Detroit Metro Plumbing"}]')).toMatchObject({
      said: 'Sure.',
      call: { name: 'open_page' },
    });
  });

  it('reads the same call written with key=value, which is what a small model writes', () => {
    // Seen from Gemma 4 E2B: the transcript's shape, without its syntax.
    expect(readTranscribedCall('[called open_page with page="Quick Fix Plumbing LLC"]')).toEqual({
      said: '',
      call: { name: 'open_page', args: { page: 'Quick Fix Plumbing LLC' } },
    });
    expect(readTranscribedCall("[called open_page with page='home']")?.call.args).toEqual({ page: 'home' });
    expect(readTranscribedCall('[called nxis_query with schema_type=Plumber, limit=3]')?.call.args).toEqual({
      schema_type: 'Plumber',
      limit: '3',
    });
  });

  it('leaves ordinary text, and broken arguments, alone', () => {
    expect(readTranscribedCall('I called them yesterday.')).toBeNull();
    expect(readTranscribedCall('[called open_page with {not json}]')).toBeNull();
    expect(readTranscribedCall('[called open_page with ]')).toBeNull();
    expect(readTranscribedCall('[called open_page with {"page":"x"}] and then more')).toBeNull();
  });

  it('runs the call, rather than showing it', async () => {
    const said: string[] = [];
    const bubble = { thinking() {}, update() {}, finalize: (t: string) => said.push(t) };
    const renderer = {
      streaming: () => bubble,
      message: (_r: string, t: string) => said.push(t),
      status() {},
      results() {},
      detail() {},
      toolError() {},
    };
    const execTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"name":"Detroit Metro Plumbing"}' }] }));
    const { AgentHarness } = await import('../src/index');
    const harness = new AgentHarness({
      renderer,
      provider: {
        ready: true,
        complete: async () => ({ text: '[called nxis_get with {"id":"urn:x"}]' }),
      },
      toolSource: {
        discoverTools: async () => [
          { name: 'nxis_get', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        ],
        execTool,
      },
    } as never);
    const result = await harness.turn('take me there', []);
    expect(result.decision).toBe('execute');
    expect(execTool).toHaveBeenCalledOnce();
    expect(said.join('\n')).not.toContain('[called');
  });
});
