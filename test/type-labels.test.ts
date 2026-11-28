// @vitest-environment happy-dom
/**
 * Kinds of records in a visitor's words: a card's type tag is never a schema.org name, and a type listing is never
 * drawn for a visitor at all (it is a step for the model).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTechnicalRecord, isTechnicalType, typeTag } from '../src/harness/type-labels';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import '../src/ui/agent';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** The listing a test site's records gave in a test run. */
const LISTING = [
  { type: 'BreadcrumbList', count: 16 },
  { type: 'Plumber', count: 16, group: 'LocalBusiness' },
  { type: 'EmergencyService', count: 15, group: 'LocalBusiness' },
  { type: 'WebPage', count: 12 },
  { type: 'Service', count: 18 },
  { type: 'WebSite', count: 1 },
  { type: 'Person', count: 5 },
  { type: 'Review', count: 4, group: 'Review' },
  { type: 'Offer', count: 3 },
  { type: 'SearchAction', count: 1 },
  { type: 'ImageObject', count: 9 },
  { type: 'QuoteAction', count: 2 },
  { type: 'https://schema.org/FAQPage', count: 2 },
  { type: 'MusicAlbum', count: 2 },
  { type: 'Pharmacy', count: 1, group: 'LocalBusiness' },
];

describe('type labels', () => {
  it('hides the site plumbing and any action', () => {
    for (const t of ['BreadcrumbList', 'WebSite', 'WebPage', 'SearchAction', 'ImageObject', 'ReserveAction', 'PostalAddress', 'https://schema.org/ListItem'])
      expect(isTechnicalType(t), t).toBe(true);
    for (const t of ['Service', 'Plumber', 'Offer', 'Event']) expect(isTechnicalType(t), t).toBe(false);
  });

  it('tags a card with its type in words, "Team" for staff, and nothing for plumbing', () => {
    expect(typeTag({ '@type': 'EmergencyService' })).toBe('Emergency service');
    expect(typeTag({ '@type': ['WebPage', 'Plumber'] })).toBe('Plumber');
    expect(typeTag({ '@type': 'BreadcrumbList' })).toBeUndefined();
    expect(typeTag({ '@type': 'Person', name: 'Dana' })).toBeUndefined();
    expect(typeTag({ '@type': 'Person', name: 'Dana', jobTitle: 'Master plumber' })).toBe('Team');
    expect(isTechnicalRecord({ '@type': 'WebSite' })).toBe(true);
    expect(isTechnicalRecord({ '@type': 'Service' })).toBe(false);
    expect(isTechnicalRecord({ name: 'No type' })).toBe(false);
  });
});

describe('in the element', () => {
  const agent = (): any => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    return el;
  };
  const reply = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body });

  it('never draws a type listing: no card, no "kinds", nothing kept', async () => {
    const el = agent();
    const before = el._active()?.items.length ?? 0;
    el._renderer().results({ name: 'nxis_list_types', annotations: { readOnlyHint: true } }, reply({ types: LISTING }));
    await sleep(0);
    expect(el._active()?.items.length ?? 0).toBe(before);
    expect(el.shadowRoot.querySelector('.results')).toBeNull();
    expect(el.shadowRoot.textContent).not.toMatch(/kinds|Locations|Services|BreadcrumbList/);
  });

  it('a list_types then query turn draws only the query results and the answer', async () => {
    const el = agent();
    const r = el._renderer();
    r.results({ name: 'nxis_list_types', annotations: { readOnlyHint: true } }, reply({ types: LISTING }));
    r.results({ name: 'nxis_query', annotations: { readOnlyHint: true } }, reply({ results: [{ '@id': 'https://x.example/#svc', '@type': 'Service', name: 'Drain rodding', telephone: '555-0142' }] }));
    r.message('assistant', 'We rod drains.');
    await sleep(0);
    const kinds = el._active().items.map((i: { kind: string }) => i.kind);
    expect(kinds.filter((k: string) => k === 'results')).toHaveLength(1);
    expect(el._active().items.find((i: { kind: string }) => i.kind === 'results').cards.map((c: { title: string }) => c.title)).toEqual(['Drain rodding']);
    expect(el.shadowRoot.textContent).toContain('Drain rodding');
    expect(el.shadowRoot.textContent).toContain('We rod drains.');
    expect(el.shadowRoot.textContent).not.toMatch(/\d+ kinds/);
  });

  it('a type listing an older version kept is not drawn on reload', () => {
    const el = agent();
    el._active().items.push({ kind: 'results', title: 'List types', note: '8 kinds', cards: [{ title: 'Locations', type: '', rows: [{ label: 'Listed', value: '16' }], archetype: 'thing' }] });
    el._renderThread();
    expect(el.shadowRoot.textContent).not.toMatch(/8 kinds|Locations/);
  });

  it('leaves plumbing out of a search\'s cards, and tags the rest in words', () => {
    const el = agent();
    el._renderer().results(
      { name: 'nxis_query', annotations: { readOnlyHint: true } },
      reply({
        results: [
          { '@id': 'https://x.example/#crumbs', '@type': 'BreadcrumbList', name: 'Home › Services' },
          { '@id': 'https://x.example/#site', '@type': 'WebSite', name: 'Copperline' },
          { '@id': 'https://x.example/#svc', '@type': 'Service', name: 'Drain rodding' },
          { '@id': 'https://x.example/#er', '@type': 'EmergencyService', name: 'Copperline 24/7', telephone: '555-0199' },
        ],
      }),
    );
    const item = el._active().items.at(-1);
    expect(item.cards.map((c: { title: string; type: string }) => [c.title, c.type])).toEqual([
      ['Drain rodding', 'Service'],
      ['Copperline 24/7', 'Emergency service'],
    ]);
  });
});
