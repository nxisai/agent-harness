/**
 * The site as a graph: trails read, inverted, and walked.
 *
 * A page publishes only its own path from the root, so everything else — who is
 * beside you, what is under you — comes from having every page's trail at once.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  applyTrails,
  buildNav,
  buildPageLinksTool,
  describeNav,
  loadSiteTrails,
  nameOf,
  navFor,
  parentOf,
  parseTrail,
  registerPageLinksTool,
  PAGE_LINKS_TOOL,
  type SiteTrail,
} from '../src/harness/tools/site-nav';
import { resolveDestination } from '../src/harness/tools/open-page';
import type { SitePage } from '../src/harness/tools/site-pages';

const ORIGIN = 'https://listings.example';
const HOME = `${ORIGIN}/`;
const SECTION = `${ORIGIN}/plumbers/`;
const LISTING = `${ORIGIN}/listings/detroit-metro-plumbing.html`;
const SIBLING = `${ORIGIN}/listings/royal-oak-drain-pros.html`;
const AREA = `${ORIGIN}/areas/royal-oak.html`;

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

/** A trail as the server stores it: id on the page, levels with absolute urls. */
const record = (page: string, levels: [string, string?][]) => ({
  '@type': 'BreadcrumbList',
  '@id': `${page}#breadcrumblist`,
  itemListElement: levels.map(([name, item], i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name,
    ...(item ? { item } : {}),
  })),
});

const PAGES: SitePage[] = [
  { url: HOME, name: 'Royal Oak Contractors' },
  { url: SECTION, name: 'Plumbers' },
  { url: LISTING, name: 'Detroit Metro Plumbing', links: [AREA] },
  { url: SIBLING, name: 'Royal Oak Drain Pros' },
  { url: AREA, name: 'Royal Oak' },
];

const TRAILS: SiteTrail[] = [
  record(LISTING, [['Home', HOME], ['Plumbers', SECTION], ['Detroit Metro Plumbing']]),
  record(SIBLING, [['Home', HOME], ['Plumbers', SECTION], ['Royal Oak Drain Pros']]),
  record(SECTION, [['Home', HOME], ['Plumbers']]),
].map((r) => parseTrail(r, ORIGIN)!);

const nav = () => buildNav(PAGES, TRAILS, ORIGIN);

describe('reading a trail', () => {
  it('reads levels in order, and the page it belongs to', () => {
    const trail = parseTrail(record(LISTING, [['Home', HOME], ['Plumbers', SECTION], ['Detroit Metro Plumbing']]), ORIGIN);
    expect(trail).toEqual({
      page: LISTING,
      levels: [{ name: 'Home', url: HOME }, { name: 'Plumbers', url: SECTION }, { name: 'Detroit Metro Plumbing' }],
    });
  });

  it('sorts by position, whatever order the levels arrived in', () => {
    const jumbled = {
      '@type': 'BreadcrumbList',
      '@id': `${LISTING}#breadcrumblist`,
      itemListElement: [
        { '@type': 'ListItem', position: 2, name: 'Plumbers', item: SECTION },
        { '@type': 'ListItem', position: 1, name: 'Home', item: HOME },
      ],
    };
    expect(parseTrail(jumbled, ORIGIN)?.levels.map((l) => l.name)).toEqual(['Home', 'Plumbers']);
  });

  it('drops a level pointing off the site, and refuses what is not a trail', () => {
    const away = parseTrail(record(LISTING, [['Home', HOME], ['Partner', 'https://evil.example/x']]), ORIGIN);
    expect(away?.levels).toEqual([{ name: 'Home', url: HOME }, { name: 'Partner' }]);
    expect(parseTrail({ '@type': 'WebPage', name: 'x' }, ORIGIN)).toBeNull();
    expect(parseTrail(record(LISTING, []), ORIGIN)).toBeNull();
  });

  it('reads IRI-keyed records, as the server returns them', () => {
    const iri = {
      '@type': 'https://schema.org/BreadcrumbList',
      '@id': `${LISTING}#breadcrumblist`,
      'https://schema.org/itemListElement': [
        { 'https://schema.org/position': 1, 'https://schema.org/name': 'Home', 'https://schema.org/item': HOME },
      ],
    };
    expect(parseTrail(iri, ORIGIN)?.levels).toEqual([{ name: 'Home', url: HOME }]);
  });
});

describe('the graph the trails make', () => {
  it('puts a listing under its section, and the section under the root', () => {
    expect(parentOf(LISTING, nav())).toBe(SECTION);
    expect(parentOf(SECTION, nav())).toBe(HOME);
    expect(parentOf(HOME, nav())).toBeUndefined();
  });

  it('answers what is beside, above, under and linked from a page', () => {
    const at = navFor(nav(), LISTING);
    expect(at.ancestors.map((a) => a.name)).toEqual(['Royal Oak Contractors', 'Plumbers']);
    expect(at.siblings.map((s) => s.name)).toEqual(['Royal Oak Drain Pros']);
    expect(at.links.map((l) => l.name)).toEqual(['Royal Oak']);
    expect(navFor(nav(), SECTION).children.map((c) => c.name).sort()).toEqual([
      'Detroit Metro Plumbing',
      'Royal Oak Drain Pros',
    ]);
  });

  it('names a link by the page it points at, not by its address', () => {
    expect(nameOf(AREA, nav())).toBe('Royal Oak');
    expect(nameOf(`${ORIGIN}/guides/frozen-pipes.html`, nav())).toBe('frozen pipes');
  });

  it('a page with no trail is simply unplaced', () => {
    const alone = buildNav(PAGES, [], ORIGIN);
    expect(parentOf(LISTING, alone)).toBeUndefined();
    expect(navFor(alone, LISTING)).toMatchObject({ ancestors: [], siblings: [], children: [] });
  });

  it('survives a trail that points at itself', () => {
    const circular = [parseTrail(record(LISTING, [['Detroit Metro Plumbing', LISTING]]), ORIGIN)!];
    expect(navFor(buildNav(PAGES, circular, ORIGIN), LISTING).ancestors).toEqual([]);
  });
});

describe('what the agent says about where it is', () => {
  it('reads the trail back, with what is near', () => {
    const said = describeNav(nav(), LISTING);
    expect(said).toContain('You are on Detroit Metro Plumbing (/listings/detroit-metro-plumbing.html), one of 5 pages');
    expect(said).toContain('Trail: Home › Plumbers › Detroit Metro Plumbing');
    expect(said).toContain('Also in this section: Royal Oak Drain Pros');
    expect(said).toContain('Linked from here: Royal Oak');
  });

  it('answers where the visitor is even when the site publishes no sections', () => {
    const flat = buildNav(PAGES, [], ORIGIN);
    const said = describeNav(flat, AREA);
    expect(said).toContain('You are on Royal Oak (/areas/royal-oak.html)');
    expect(said).toContain('no sections');
    expect(said).toContain('Detroit Metro Plumbing');
  });

  it('says so plainly when the site has nothing else at all', () => {
    const alone = buildNav([{ url: AREA, name: 'Royal Oak' }], [], ORIGIN);
    expect(describeNav(alone, AREA)).toContain('Nothing else on the site links to or from it.');
  });

  it('and so is open_page, with nothing but the address bar to work from', async () => {
    // A corpus the server is rate limiting used to take these down with it, leaving an agent that
    // could not say which page it was on — a question needing no read at all.
    const { LocalModelContext } = await import('../src/harness/tools/local-context');
    const { registerOpenPageTool, OPEN_PAGE_TOOL } = await import('../src/harness/tools/open-page');
    const mc = new LocalModelContext();
    expect(await registerOpenPageTool(mc, [], { origin: ORIGIN })).toBe(true);
    const tool = (await mc.getTools()).find((t) => t.name === OPEN_PAGE_TOOL);
    expect(tool?.inputSchema?.properties?.page.enum).toBeUndefined();
    expect(tool?.description).toMatch(/home/);
  });

  it('is registered whatever the site publishes: "where am I" always has an answer', async () => {
    const { LocalModelContext } = await import('../src/harness/tools/local-context');
    const mc = new LocalModelContext();
    expect(await registerPageLinksTool(mc, buildNav([], [], ORIGIN))).toBe(true);
    expect((await mc.getTools()).map((t) => t.name)).toContain(PAGE_LINKS_TOOL);
  });

  it('quotes the address the site publishes, not the one this tab is using', () => {
    // ?surface= and ?open= are a surface's own, and nothing is indexed under them.
    const said = describeNav(nav(), `${LISTING}?surface=window&open=1`);
    expect(said).toContain('(/listings/detroit-metro-plumbing.html)');
    expect(said).not.toContain('surface');
  });

  it('drops the tab\'s query even when no record matches the page', () => {
    const said = describeNav(buildNav([], [], ORIGIN), `${ORIGIN}/?surface=window`);
    expect(said).toContain('(/)');
    expect(said).not.toContain('surface');
  });

  it('is offered as a read-only tool', async () => {
    const tool = buildPageLinksTool(nav(), { href: () => LISTING });
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const res = await tool.execute({});
    expect(res.content[0].text).toContain('Plumbers');
  });
});

describe('going somewhere relative to here', () => {
  const at = (href: string) => ({ origin: ORIGIN, href, nav: nav() });

  it('goes up to the section above', () => {
    for (const said of ['up', 'up a level', 'go up', 'the section above', 'parent']) {
      expect(resolveDestination(said, PAGES, ORIGIN, at(LISTING))).toMatchObject({ url: SECTION, label: 'Plumbers' });
    }
  });

  it('says so when there is nothing above', () => {
    expect(resolveDestination('up', PAGES, ORIGIN, at(HOME))).toMatchObject({ kind: 'none' });
    expect(resolveDestination('up', PAGES, ORIGIN, { origin: ORIGIN, href: LISTING })).toMatchObject({ kind: 'none' });
  });

  it('opens a page beside this one, or one it links to, by name', () => {
    expect(resolveDestination('Royal Oak Drain Pros', PAGES, ORIGIN, at(LISTING))).toMatchObject({ url: SIBLING });
    expect(resolveDestination('Royal Oak', PAGES, ORIGIN, at(LISTING))).toMatchObject({ url: AREA });
  });

  it('offers what is near first, and says the rest is reachable', async () => {
    const { buildOpenPageTool } = await import('../src/harness/tools/open-page');
    const tool = buildOpenPageTool(PAGES, at(LISTING));
    const page = tool.inputSchema?.properties?.page;
    expect(page?.enum?.slice(0, 3)).toEqual(['home', 'back', 'up']);
    expect(page?.enum).toContain('Plumbers');
    expect(page?.description).toMatch(/"up"/);
  });
});

describe('a graph that fills in later', () => {
  it('folds trails into the graph the tools are already holding', () => {
    const held = buildNav(PAGES, [], ORIGIN);
    expect(parentOf(LISTING, held)).toBeUndefined();
    applyTrails(held, TRAILS);
    expect(parentOf(LISTING, held)).toBe(SECTION);
    expect(navFor(held, LISTING).siblings.map((s) => s.name)).toEqual(['Royal Oak Drain Pros']);
  });

  it('fetches them the first time navigation needs them, not at connect', async () => {
    const { buildOpenPageTool } = await import('../src/harness/tools/open-page');
    const held = buildNav(PAGES, [], ORIGIN);
    const loadNav = vi.fn(async () => applyTrails(held, TRAILS));
    const visited: string[] = [];
    const tool = buildOpenPageTool(PAGES, {
      origin: ORIGIN,
      href: LISTING,
      nav: held,
      loadNav,
      storage: null,
      navigate: (url) => visited.push(url),
    });
    expect(loadNav).not.toHaveBeenCalled();

    const res = await tool.execute({ page: 'up' });
    expect(loadNav).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeFalsy();
    expect(visited).toEqual([SECTION]);
  });

  it('still answers when the fetch fails', async () => {
    const held = buildNav(PAGES, [], ORIGIN);
    const tool = buildPageLinksTool(held, {
      href: () => LISTING,
      loadNav: async () => {
        throw new Error('You have used all 3 read requests allowed per 60s. Retry after 52s.');
      },
    });
    expect((await tool.execute({})).content[0].text).toContain('You are on Detroit Metro Plumbing');
  });
});

describe('fetching the trails', () => {
  it('queries by type, and reuses what the tab already fetched', async () => {
    const calls: unknown[] = [];
    const client = {
      callTool: vi.fn(async (req: { arguments: unknown }) => {
        calls.push(req.arguments);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ results: [record(LISTING, [['Home', HOME], ['Detroit Metro Plumbing']])], total: 1 }) },
          ],
        };
      }),
    } as unknown as Client;
    const storage = memoryStorage();
    const info = { endpoint: 'https://mcp.example.com/mcp' };

    const trails = await loadSiteTrails(client, info, { origin: ORIGIN, storage });
    expect(trails).toHaveLength(1);
    await loadSiteTrails(client, info, { origin: ORIGIN, storage });
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ filter: { field_filters: [{ path: '@type', value: 'BreadcrumbList' }] } });
  });
});

describe('an answer in words, not records', () => {
  it('is what the page-links tool returns, and what a surface should say', async () => {
    const { proseAnswer } = await import('../src/harness/tools/schema');
    const tool = buildPageLinksTool(nav(), { href: () => LISTING });
    const res = await tool.execute({});
    // The exact shape that reaches the surface, through the registry and the harness.
    expect(proseAnswer(res)).toContain('You are on Detroit Metro Plumbing');
  });

  it('leaves records to the cards that draw them', async () => {
    const { proseAnswer } = await import('../src/harness/tools/schema');
    expect(proseAnswer({ content: [{ type: 'text', text: '{"results":[],"total":0}' }] })).toBe('');
    expect(proseAnswer({ content: [], structuredContent: { results: [] } })).toBe('');
    expect(proseAnswer({ content: [] })).toBe('');
    expect(proseAnswer(null)).toBe('');
  });

  it('reads an answer a native registry stringified on its way out', async () => {
    const { proseAnswer } = await import('../src/harness/tools/schema');
    const wrapped = {
      content: [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text: 'You are on Plumbers (/plumbers/).' }] }) }],
    };
    expect(proseAnswer(wrapped)).toBe('You are on Plumbers (/plumbers/).');
  });
});

describe('a registry with an envelope of its own', () => {
  it('reads the answer as words whatever it wrapped it in', async () => {
    const { proseAnswer } = await import('../src/harness/tools/schema');
    const answer = 'You are on Plumbers (/plumbers/).';
    // A native document.modelContext attaches fields to every response — empty, echoing the
    // content, or its own bookkeeping. None of them make an answer in words into records.
    for (const structuredContent of [
      {},
      { content: [{ type: 'text', text: answer }] },
      { isError: false, toolName: 'page_links' },
    ]) {
      expect(proseAnswer({ content: [{ type: 'text', text: answer }], structuredContent })).toBe(answer);
    }
  });

  it('still leaves records to the cards, through the same envelopes', async () => {
    const { proseAnswer } = await import('../src/harness/tools/schema');
    const records = '{"results":[],"total":0}';
    expect(proseAnswer({ content: [{ type: 'text', text: records }], structuredContent: { results: [] } })).toBe('');
    expect(proseAnswer({ content: [{ type: 'text', text: records }] })).toBe('');
  });
});
