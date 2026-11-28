// @vitest-environment happy-dom
/**
 * A service-area answer is cited. In a real test run, "Do you service Norridge? What about Evanston?" was answered
 * from the site's Offer records, which name the places they serve in `areaServed`, and got no citation: a record was
 * matched only by its name, phone and street address.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localAnswer } from '../src/ui/sources';
import '../src/ui/agent';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const SITE = 'https://copperline.example';
const AREA = ['Chicago', 'Oak Park', 'Evanston', 'Berwyn', 'Skokie', 'Norridge', 'Elmwood Park', 'Park Ridge'];
const SELLER = { '@type': 'Organization', name: 'Copperline Home Services', telephone: '(773) 555-0142' };
const RECORDS = [
  { '@id': `${SITE}/#organization`, '@type': 'Plumber', name: 'Copperline Home Services', url: `${SITE}/` },
  { '@id': `${SITE}/services/drains#offer`, '@type': 'Offer', name: 'Drain and sewer rodding', price: 189, priceCurrency: 'USD', areaServed: AREA, seller: SELLER },
  { '@id': `${SITE}/service-areas/evanston#offer`, '@type': 'Offer', name: 'Rodding in Evanston', areaServed: { '@type': 'AdministrativeArea', name: 'Evanston' }, seller: SELLER },
];
const REPLY =
  'Yes, both are in our service area. Norridge and Evanston are both on the list of areas we serve.\nTo arrange a visit or get a quote, call (773) 555-0142.';

describe('a service-area answer', () => {
  it('cites the records that name the places, and the one that gives the phone', () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    el._noteSources({ content: [{ type: 'text', text: JSON.stringify({ results: RECORDS }) }], structuredContent: { results: RECORDS } });
    const answer = localAnswer(REPLY, el._turnSources)!;
    expect(answer).not.toBeNull();
    expect(answer.claims).toEqual(['Norridge and Evanston are both on the list of areas we serve.', 'To arrange a visit or get a quote, call (773) 555-0142.']);
    expect(answer.cards.map((c) => c['@id'])).toEqual([`${SITE}/services/drains#offer`]);
  });

  it('a record’s own name still wins over a place it serves', () => {
    const sources = [
      { card: { '@id': 'a', '@type': 'Offer', name: 'Drains' }, keys: ['Drains'], more: ['Evanston'] },
      { card: { '@id': 'b', '@type': 'City', name: 'Evanston' }, keys: ['Evanston'] },
    ];
    expect(localAnswer('We work in Evanston.', sources)!.cards.map((c) => c['@id'])).toEqual(['b']);
  });
});
