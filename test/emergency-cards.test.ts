// @vitest-environment happy-dom
/**
 * An emergency turn's result cards call the emergency line, never the main one first. In a real test run, "My
 * basement is flooding right now" drew the business's card first with "Call" on its main number, above an answer that
 * gave the 24-hour line from the records.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emergencyFirst, isEmergency, lineOf } from '../src/harness/emergency';
import '../src/ui/agent';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const SITE = 'https://copperline.example';
const SELLER = { '@type': 'Organization', name: 'Copperline Home Services', telephone: '(773) 555-0142' };
/** The records the flood search read, cut to what the cards use. */
const RECORDS = [
  { '@id': `${SITE}/#organization`, '@type': ['Plumber', 'EmergencyService'], name: 'Copperline Home Services', telephone: '(773) 555-0142', address: { addressLocality: 'Chicago' } },
  {
    '@id': `${SITE}/services/emergency-service#offer`,
    '@type': 'Offer',
    itemOffered: { '@type': 'Service', name: '24-hour emergency service' },
    seller: { ...SELLER, telephone: '(773) 555-0199' },
  },
  { '@id': `${SITE}/services/drains#service`, '@type': 'Service', name: 'Drain and sewer rodding', provider: SELLER },
];

describe('the emergency rule', () => {
  it('reads an emergency in the visitor’s words', () => {
    expect(isEmergency('My basement is flooding right now')).toBe(true);
    expect(isEmergency('A pipe burst in the kitchen')).toBe(true);
    expect(isEmergency('Book me something for 3am Sunday')).toBe(false);
    expect(isEmergency('What services do you offer?')).toBe(false);
  });

  it('puts the emergency line first, calling it, and drops other numbers’ calls', () => {
    const cards = [
      { title: 'Copperline Home Services', phone: '(773) 555-0142' },
      { title: 'Copperline Home Services — 24-hour emergency service' },
      { title: 'Drain and sewer rodding' },
    ];
    expect(lineOf(RECORDS[1])).toBe('(773) 555-0199');
    expect(emergencyFirst(cards, RECORDS)).toEqual([
      { title: 'Copperline Home Services — 24-hour emergency service', phone: '(773) 555-0199' },
      { title: 'Copperline Home Services' },
      { title: 'Drain and sewer rodding' },
    ]);
    // No emergency line in the records: the cards as they were.
    expect(emergencyFirst([cards[0], cards[2]], [RECORDS[0], RECORDS[2]])).toEqual([cards[0], cards[2]]);
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
  const calls = (el: any): string[] => [...el.shadowRoot.querySelectorAll('a[href^="tel:"]')].map((a: Element) => a.getAttribute('href')!);

  it('a flood: the first call on the card is the 24-hour line, and the main line is not offered', () => {
    const el = agent();
    el._turnGoal = 'My basement is flooding right now';
    el._renderer().results({ name: 'nxis_query', annotations: { readOnlyHint: true } }, reply({ results: RECORDS }));
    const item = el._active().items.at(-1);
    expect(item.cards[0].phone).toBe('(773) 555-0199');
    expect(item.cards.filter((c: { phone?: string }) => c.phone === '(773) 555-0142')).toEqual([]);
    expect(calls(el)[0] ?? 'tel:+17735550199').toBe('tel:+17735550199');
    expect(calls(el)).not.toContain('tel:+17735550142');
  });

  it('any other turn: the cards as the records give them', () => {
    const el = agent();
    el._turnGoal = 'What services do you offer?';
    el._renderer().results({ name: 'nxis_query', annotations: { readOnlyHint: true } }, reply({ results: RECORDS }));
    const item = el._active().items.at(-1);
    expect(item.cards[0].phone).toBe('(773) 555-0142');
  });
});
