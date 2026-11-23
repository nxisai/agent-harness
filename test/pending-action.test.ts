/**
 * Carrying a confirmed action to the page that can submit it.
 *
 * Covers the record that travels (what survives, what expires, what is refused)
 * and the two ends of the journey: a call made from the wrong page, and the
 * call that runs on arrival.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  savePendingAction,
  takePendingAction,
  clearPendingAction,
  PENDING_TTL_MS,
} from '../src/harness/tools/pending-action';
import {
  buildSiteActionTools,
  handoffFor,
  awaitPageTool,
  pageToolRef,
  ACTION_ID_HINT,
} from '../src/harness/tools/action-tools';
import { LocalModelContext } from '../src/harness/tools/local-context';
import type { NxisAction } from '../src/webmcp-contract';
import type { ModelContextToolInfo } from '../src/types';

const ORIGIN = 'https://listings.example';
const MCGREEVY = `${ORIGIN}/listings/mcgreevy-plumbing.html`;
const ROYAL_OAK = `${ORIGIN}/listings/royal-oak.html`;

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

const quoteForm = (business: string, page: string): NxisAction => ({
  '@type': 'InteractAction',
  '@id': `urn:nxis:action:${business}`,
  name: 'quote-form',
  description: `Request a quote from ${business}.`,
  target: { '@type': 'EntryPoint', httpMethod: 'GET', 'nxis:pageUrl': page },
  input: [
    {
      '@type': 'PropertyValueSpecification',
      valueName: 'business',
      'nxis:valueType': 'string',
      defaultValue: business,
    },
    { '@type': 'PropertyValueSpecification', valueName: 'full_name', 'nxis:valueType': 'string' },
  ],
});

const ACTIONS = [quoteForm('McGreevy Plumbing', MCGREEVY), quoteForm('Royal Oak Remodeling', ROYAL_OAK)];

const pending = (over: Record<string, unknown> = {}) => ({
  actionId: 'urn:nxis:action:McGreevy Plumbing',
  pageToolName: 'quote_form',
  toolName: 'quote_form_anywhere',
  values: { full_name: 'Dana' },
  pageUrl: MCGREEVY,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('the record that travels', () => {
  it('comes back on its own page, once', () => {
    const storage = memoryStorage();
    expect(savePendingAction(pending(), { storage })).toBe(true);

    const taken = takePendingAction(`${MCGREEVY}?utm=email`, { storage });
    expect(taken?.values).toEqual({ full_name: 'Dana' });
    // Read once: a reload must not submit the same form again.
    expect(takePendingAction(MCGREEVY, { storage })).toBeNull();
  });

  it('waits while the browser is somewhere else', () => {
    const storage = memoryStorage();
    savePendingAction(pending(), { storage });
    expect(takePendingAction(ROYAL_OAK, { storage })).toBeNull();
    expect(takePendingAction(MCGREEVY, { storage })).not.toBeNull();
  });

  it('expires, and is discarded wherever it is found', () => {
    const storage = memoryStorage();
    let t = 1_000_000;
    savePendingAction(pending(), { storage, now: () => t });
    t += PENDING_TTL_MS + 1;
    expect(takePendingAction(MCGREEVY, { storage, now: () => t })).toBeNull();
    // Discarded, not merely withheld.
    expect(storage.length).toBe(0);
  });

  it('survives nothing it cannot trust', () => {
    const storage = memoryStorage();
    storage.setItem('nxis:pending-action:v1', '{not json');
    expect(takePendingAction(MCGREEVY, { storage })).toBeNull();

    savePendingAction(pending({ actionId: '' }), { storage });
    expect(takePendingAction(MCGREEVY, { storage })).toBeNull();
  });

  it('reports when it cannot be stored, so the caller does not navigate', () => {
    const blocked = memoryStorage();
    blocked.setItem = () => {
      throw new DOMException('QuotaExceededError');
    };
    expect(savePendingAction(pending(), { storage: blocked })).toBe(false);
    expect(savePendingAction(pending(), { storage: null })).toBe(false);
  });

  it('can be forgotten', () => {
    const storage = memoryStorage();
    savePendingAction(pending(), { storage });
    clearPendingAction({ storage });
    expect(takePendingAction(MCGREEVY, { storage })).toBeNull();
  });
});

describe('telling the harness where a call is bound', () => {
  const tool = (href: string): ModelContextToolInfo =>
    buildSiteActionTools(ACTIONS, new LocalModelContext(), { href })[0]
      .definition as unknown as ModelContextToolInfo;

  it('names the destination when the form is on another page', () => {
    const handoff = handoffFor(tool(MCGREEVY), { business: 'Royal Oak Remodeling' }, MCGREEVY);
    expect(handoff).toMatchObject({ pageUrl: ROYAL_OAK, label: 'Royal Oak Remodeling' });
  });

  it('says nothing when the form is already here', () => {
    expect(handoffFor(tool(MCGREEVY), { business: 'McGreevy Plumbing' }, MCGREEVY)).toBeNull();
  });

  it('says nothing until the call says which one it means', () => {
    expect(handoffFor(tool(MCGREEVY), { full_name: 'Dana' }, MCGREEVY)).toBeNull();
  });

  it('ignores tools that are not site tools', () => {
    const plain = { name: 'nxis_query', annotations: { readOnlyHint: true } } as ModelContextToolInfo;
    expect(handoffFor(plain, {}, MCGREEVY)).toBeNull();
  });
});

describe('leaving for the page that can submit', () => {
  const run = (href: string, args: Record<string, unknown>, storage: Storage | null) => {
    const visited: string[] = [];
    const tool = buildSiteActionTools(ACTIONS, new LocalModelContext(), {
      href,
      storage,
      navigate: (url) => visited.push(url),
      conversationId: 'conv-1',
    })[0];
    return { visited, call: tool.definition.execute(args) };
  };

  it('holds the values, then goes there', async () => {
    const storage = memoryStorage();
    const { visited, call } = run(MCGREEVY, { business: 'Royal Oak Remodeling', full_name: 'Dana' }, storage);
    const res = await call;

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Royal Oak Remodeling');
    expect(visited).toEqual([ROYAL_OAK]);

    const carried = takePendingAction(ROYAL_OAK, { storage });
    expect(carried).toMatchObject({
      pageUrl: ROYAL_OAK,
      conversationId: 'conv-1',
      values: { business: 'Royal Oak Remodeling', full_name: 'Dana' },
    });
  });

  it('stays put when the values cannot be carried', async () => {
    const { visited, call } = run(MCGREEVY, { business: 'Royal Oak Remodeling' }, null);
    const res = await call;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('open that page');
    expect(visited).toEqual([]);
  });

  it('refuses to leave the site', async () => {
    const storage = memoryStorage();
    const offsite = [
      ACTIONS[0],
      { ...ACTIONS[1], target: { ...ACTIONS[1].target, 'nxis:pageUrl': 'https://evil.example/x' } },
    ];
    const visited: string[] = [];
    const tool = buildSiteActionTools(offsite, new LocalModelContext(), {
      href: MCGREEVY,
      storage,
      navigate: (url) => visited.push(url),
    })[0];
    const res = await tool.definition.execute({ business: 'Royal Oak Remodeling' });
    expect(res.isError).toBe(true);
    expect(visited).toEqual([]);
    expect(storage.length).toBe(0);
  });
});

describe('picking the form up on arrival', () => {
  it('waits for the page script to register it', async () => {
    const mc = new LocalModelContext();
    const ref = pageToolRef(ACTIONS[1]);
    const waiting = awaitPageTool(mc, ref, 2000);
    // The page's script reads its JSON-LD after the agent has already started.
    setTimeout(() => {
      void mc.registerTool({
        name: 'quote_form',
        description: 'Request a quote',
        annotations: { [ACTION_ID_HINT]: ref.id },
        execute: async () => ({ content: [] }),
      });
    }, 20);
    expect(await waiting).toMatchObject({ name: 'quote_form' });
  });

  it('gives up rather than hanging when the form never appears', async () => {
    const found = await awaitPageTool(new LocalModelContext(), pageToolRef(ACTIONS[0]), 60);
    expect(found).toBeNull();
  });
});
