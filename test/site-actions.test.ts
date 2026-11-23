/**
 * Site actions: reading typed-retrieval records as actions, and which of them
 * the harness keeps.
 *
 * The MCP client is a stub answering `nxis_query`, and storage is an in-memory
 * `Storage`, so these exercise parsing, filtering and caching without a server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { findEmbeddedAction, loadSiteActions, parseAction } from '../src/harness/tools/site-actions';

const S = 'https://schema.org/';
const N = 'https://nxis.ai/ns#';
const ORIGIN = 'https://listings.example';
const INFO = { endpoint: 'https://mcp.example.com/mcp' };

/** A record as the live server returns it: expanded IRI keys throughout. */
function record(id: string, page: string, extra: Record<string, unknown> = {}) {
  return {
    '@context': 'https://schema.org/',
    '@id': id,
    '@type': `${S}InteractAction`,
    [`${S}name`]: 'quote-form',
    [`${S}description`]: 'Request a quote from McGreevy Plumbing.',
    [`${S}target`]: {
      '@type': `${S}EntryPoint`,
      [`${S}httpMethod`]: 'GET',
      [`${S}encodingType`]: 'application/x-www-form-urlencoded',
      [`${N}targetKind`]: 'selfPage',
      [`${N}pageUrl`]: `${ORIGIN}${page}`,
    },
    [`${N}input`]: [
      {
        '@type': `${S}PropertyValueSpecification`,
        [`${S}valueName`]: 'business',
        [`${S}defaultValue`]: 'McGreevy Plumbing',
        [`${N}valueType`]: 'string',
      },
      {
        '@type': `${S}PropertyValueSpecification`,
        [`${S}valueName`]: 'timeline',
        [`${S}description`]: 'Timeline',
        [`${N}valueType`]: 'string',
        [`${N}valueOption`]: [
          { '@type': `${N}ValueOption`, [`${S}value`]: 'Select…' },
          { '@type': `${N}ValueOption`, [`${S}value`]: 'this-week', [`${S}name`]: 'This week' },
        ],
      },
    ],
    [`${N}extractedAt`]: '2026-09-10T15:47:13.724Z',
    ...extra,
  };
}

/** A client whose `nxis_query` answers with each body in turn, as JSON text. */
function stubClient(...bodies: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  const callTool = vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => {
    calls.push(req.arguments);
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  });
  return { client: { callTool } as unknown as Client, calls };
}

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

afterEach(() => vi.restoreAllMocks());

describe('parseAction', () => {
  it('reads an IRI-keyed record into compact keys and a bare type', () => {
    const action = parseAction(record('urn:nxis:action:1', '/listings/mcgreevy-plumbing.html'));
    expect(action).toEqual({
      '@type': 'InteractAction',
      '@id': 'urn:nxis:action:1',
      name: 'quote-form',
      description: 'Request a quote from McGreevy Plumbing.',
      target: {
        '@type': 'EntryPoint',
        httpMethod: 'GET',
        encodingType: 'application/x-www-form-urlencoded',
        'nxis:targetKind': 'selfPage',
        'nxis:pageUrl': `${ORIGIN}/listings/mcgreevy-plumbing.html`,
      },
      input: [
        {
          '@type': 'PropertyValueSpecification',
          valueName: 'business',
          'nxis:valueType': 'string',
          defaultValue: 'McGreevy Plumbing',
        },
        {
          '@type': 'PropertyValueSpecification',
          valueName: 'timeline',
          'nxis:valueType': 'string',
          description: 'Timeline',
          'nxis:valueOption': [
            { '@type': 'nxis:ValueOption', value: 'Select…' },
            { '@type': 'nxis:ValueOption', value: 'this-week', name: 'This week' },
          ],
        },
      ],
      'nxis:extractedAt': '2026-09-10T15:47:13.724Z',
    });
  });

  it('reads compact keys too', () => {
    const action = parseAction({
      '@type': 'ContactAction',
      '@id': 'urn:x',
      name: 'contact',
      target: { httpMethod: 'post', 'nxis:pageUrl': `${ORIGIN}/contact` },
      'nxis:input': [{ valueName: 'email', valueRequired: true, 'nxis:valueType': 'string' }],
    });
    expect(action?.target.httpMethod).toBe('POST');
    expect(action?.input?.[0]).toMatchObject({ valueName: 'email', valueRequired: true });
  });

  it('rejects records that are not usable actions', () => {
    const base = record('urn:x', '/p');
    expect(parseAction({ ...base, '@type': `${S}Transaction` })).toBeNull();
    expect(parseAction({ ...base, '@type': `${S}LocalBusiness` })).toBeNull();
    expect(parseAction({ ...base, '@id': undefined })).toBeNull();
    expect(parseAction({ ...base, [`${S}name`]: undefined })).toBeNull();
    expect(parseAction({ ...base, [`${S}target`]: 'https://example.com/search?q={q}' })).toBeNull();
  });

  it('drops inputs with no name, and defaults an unknown value type to string', () => {
    const action = parseAction(
      record('urn:x', '/p', {
        [`${N}input`]: [
          { [`${N}valueType`]: 'string' },
          { [`${S}valueName`]: 'when', [`${N}valueType`]: 'time' },
        ],
      }),
    );
    expect(action?.input).toEqual([
      { '@type': 'PropertyValueSpecification', valueName: 'when', 'nxis:valueType': 'string' },
    ]);
  });
});

describe('loadSiteActions', () => {
  it('queries by @type, since the server does not yet expand Action to its subtypes', async () => {
    const { client, calls } = stubClient({ results: [], total: 0 });
    await loadSiteActions(client, INFO, { origin: ORIGIN, storage: null });
    expect(calls[0]).toMatchObject({
      filter: {
        schema_type: '',
        field_filters: [{ path: '@type', operator: 'CONTAINS', value: 'Action' }],
      },
      limit: 100,
    });
  });

  it('keeps each action once, and drops non-actions', async () => {
    const { client } = stubClient({
      results: [
        record('urn:a', '/listings/a.html'),
        record('urn:a', '/listings/a.html'),
        { ...record('urn:t', '/t'), '@type': `${S}MoneyTransfer` },
        record('urn:b', '/listings/b.html'),
      ],
      total: 4,
    });
    const actions = await loadSiteActions(client, INFO, { origin: ORIGIN, storage: null });
    expect(actions.map((a) => a['@id'])).toEqual(['urn:a', 'urn:b']);
  });

  it('drops actions whose page is on another origin, or that name no page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const offsite = record('urn:evil', '/x');
    (offsite[`${S}target`] as Record<string, unknown>)[`${N}pageUrl`] = 'https://evil.example/x';
    const pageless = record('urn:none', '/x');
    delete (pageless[`${S}target`] as Record<string, unknown>)[`${N}pageUrl`];
    const { client } = stubClient({
      results: [offsite, pageless, record('urn:ok', '/ok')],
      total: 3,
    });
    const actions = await loadSiteActions(client, INFO, { origin: ORIGIN, storage: null });
    expect(actions.map((a) => a['@id'])).toEqual(['urn:ok']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('follows page tokens when the server returns them', async () => {
    const { client, calls } = stubClient(
      { results: [record('urn:a', '/a')], total: 2, next_page_token: 'p2' },
      { results: [record('urn:b', '/b')], total: 2 },
    );
    const actions = await loadSiteActions(client, INFO, { origin: ORIGIN, storage: null });
    expect(actions).toHaveLength(2);
    expect(calls[1]).toMatchObject({ page_token: 'p2' });
  });

  it('warns when the server reports more actions than it returned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = stubClient({ results: [record('urn:a', '/a')], total: 140 });
    await loadSiteActions(client, INFO, { origin: ORIGIN, storage: null });
    expect(warn.mock.calls[0][0]).toMatch(/fetched 1 of 140/);
  });

  it('reads structuredContent when the server sends it', async () => {
    const callTool = vi.fn(async () => ({
      content: [],
      structuredContent: { results: [record('urn:a', '/a')], total: 1 },
    }));
    const actions = await loadSiteActions({ callTool } as unknown as Client, INFO, {
      origin: ORIGIN,
      storage: null,
    });
    expect(actions).toHaveLength(1);
  });

  it('throws when the query fails, so the caller can report it', async () => {
    const callTool = vi.fn(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'RESOURCE_EXHAUSTED' }],
    }));
    await expect(
      loadSiteActions({ callTool } as unknown as Client, INFO, { origin: ORIGIN, storage: null }),
    ).rejects.toThrow('RESOURCE_EXHAUSTED');
  });

  it('reuses a cached list within the TTL, and refetches after it', async () => {
    const storage = memoryStorage();
    const { client } = stubClient({ results: [record('urn:a', '/a')], total: 1 });
    let t = 1_000_000;
    const opts = { origin: ORIGIN, storage, now: () => t, ttlMs: 60_000 };

    await loadSiteActions(client, INFO, opts);
    t += 59_000;
    const cached = await loadSiteActions(client, INFO, opts);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(cached.map((a) => a['@id'])).toEqual(['urn:a']);

    t += 2_000;
    await loadSiteActions(client, INFO, opts);
    expect(client.callTool).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by server, and survives corrupt or blocked storage', async () => {
    const storage = memoryStorage();
    const { client } = stubClient({ results: [record('urn:a', '/a')], total: 1 });
    await loadSiteActions(client, INFO, { origin: ORIGIN, storage });
    await loadSiteActions(client, { endpoint: 'https://other.example/mcp' }, { origin: ORIGIN, storage });
    expect(client.callTool).toHaveBeenCalledTimes(2);

    storage.setItem(`nxis:site-actions:v1:${INFO.endpoint}`, '{not json');
    await loadSiteActions(client, INFO, { origin: ORIGIN, storage });
    expect(client.callTool).toHaveBeenCalledTimes(3);

    const blocked = memoryStorage();
    blocked.setItem = () => {
      throw new DOMException('QuotaExceededError');
    };
    await expect(loadSiteActions(client, INFO, { origin: ORIGIN, storage: blocked })).resolves.toHaveLength(1);
  });
});

describe('findEmbeddedAction', () => {
  /** A business record, with its quote form embedded as the index keeps it after a partial re-crawl. */
  const business = (name: string, page: string, form: Record<string, unknown> = {}) => ({
    '@id': `urn:biz:${page}`,
    '@type': `${S}Plumber`,
    name,
    potentialAction: {
      ...record(`urn:nxis:action:${page}`, page),
      [`${N}input`]: [
        { '@type': `${S}PropertyValueSpecification`, [`${S}valueName`]: 'business', [`${S}defaultValue`]: name, [`${N}valueType`]: 'string' },
      ],
      ...form,
    },
  });
  const find = (client: Client, value = 'Hatzel & Sons Plumbing') =>
    findEmbeddedAction(client, { actionName: 'quote-form', field: 'business', value, origin: ORIGIN });

  it('finds a form the index holds only inside its business, by name', async () => {
    const { client, calls } = stubClient({ results: [business('Hatzel & Sons Plumbing', '/listings/hatzel.html')] });
    const action = await find(client);
    expect(action?.target['nxis:pageUrl']).toBe(`${ORIGIN}/listings/hatzel.html`);
    expect(calls[0]).toMatchObject({ filter: { field_filters: [{ path: 'name', operator: 'CONTAINS', value: 'Hatzel & Sons Plumbing' }] } });
  });

  it('matches the name in any casing', async () => {
    const { client } = stubClient({ results: [business('Hatzel & Sons Plumbing', '/listings/hatzel.html')] });
    expect(await find(client, 'hatzel & sons plumbing')).not.toBeNull();
  });

  it('takes only the same form: not another form the business has', async () => {
    const { client } = stubClient({ results: [business('Hatzel & Sons Plumbing', '/listings/hatzel.html', { [`${S}name`]: 'newsletter' })] });
    expect(await find(client)).toBeNull();
  });

  it('never takes a form whose page is on another origin', async () => {
    const off = business('Hatzel & Sons Plumbing', '/listings/hatzel.html');
    (off.potentialAction[`${S}target`] as Record<string, unknown>)[`${N}pageUrl`] = 'https://elsewhere.example/hatzel.html';
    const { client } = stubClient({ results: [off] });
    expect(await find(client)).toBeNull();
  });

  it('takes only the form meant for the value, not one a similar name also matches', async () => {
    // "Hatzel" CONTAINS-matches both; only one form is Hatzel & Sons' own.
    const { client } = stubClient({
      results: [business('Hatzel & Sons Plumbing', '/listings/hatzel.html'), business('Hatzel Heating', '/listings/hatzel-heating.html')],
    });
    expect((await find(client))?.target['nxis:pageUrl']).toBe(`${ORIGIN}/listings/hatzel.html`);
  });

  it('asks rather than guesses when two different pages answer to the name', async () => {
    const { client } = stubClient({
      results: [business('Hatzel & Sons Plumbing', '/listings/hatzel.html'), business('Hatzel & Sons Plumbing', '/listings/hatzel-2.html')],
    });
    expect(await find(client)).toBeNull();
  });

  it('finds nothing when nothing matches, and asks nothing for an empty value', async () => {
    const { client, calls } = stubClient({ results: [] });
    expect(await find(client)).toBeNull();
    expect(await find(client, '  ')).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
