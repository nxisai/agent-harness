// @vitest-environment jsdom
/**
 * A sixth real test run of the page's assistant and its step cards (scripted models: no real model is called).
 *
 * - "What are your hours?" drew a results card listing the business four times, one row per record of it.
 * - The results card's call link had no country code: `tel:7735550142`.
 * - A reload right after an edit on a card lost the edit, and the panel opened above the card, not at the bottom.
 * - A press sent the values the card had before: a field filled without an input event (autofill that fires only
 *   change) was on screen but not sent, so the reply asked to "check name, email" and the card came back empty.
 * - After the agent ended, its last card's buttons stayed enabled and only slightly grayed.
 * - Office hours were credited to the record that names the place the reply mentioned, not the one they are from.
 */
import './helpers/lit-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepAll, sleep, until } from './helpers/lit-dom';
import { onceEach, telHref } from '../src/harness/entity';
import { hoursNote } from '../src/harness/records';
import { localAnswer, type LocalSource } from '../src/ui/sources';
import { mountSurface, stepsKit } from '../src/a2ui/host';
import { STEPS_CATALOG, type SurfaceAction } from '../src/a2ui/steps';
import { Surfaces, type SurfacesHost } from '../src/ui/surfaces';
import { SLOTS } from './fixtures/surfaces';
import { NxisAgent } from '../src/ui/agent';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const SITE = 'https://copperline.example';
const BIZ = (n: number, extra: Record<string, unknown> = {}) => ({
  '@id': `${SITE}/page-${n}#organization`,
  '@type': 'Plumber',
  name: 'Copperline Home Services',
  telephone: '(773) 555-0142',
  address: { '@type': 'PostalAddress', addressLocality: 'Chicago' },
  ...extra,
});

describe('one business once', () => {
  it('records of one name, type and address are one; a different address, type or no name is its own', () => {
    const records = [
      BIZ(1),
      BIZ(2),
      BIZ(3, { address: { addressLocality: 'Norridge' } }),
      BIZ(4, { '@type': 'EmergencyService' }),
      { '@type': 'Plumber' },
      { '@type': 'Plumber' },
      BIZ(5),
    ];
    expect(onceEach(records)).toEqual({ keep: [0, 2, 3, 4, 5], at: [0, 0, 1, 2, 3, 4, 0] });
  });

  it('on the results card', () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    const body = { results: [BIZ(1), BIZ(2), BIZ(3), BIZ(4), { '@id': `${SITE}/#drains`, '@type': 'Service', name: 'Drain and sewer rodding' }] };
    el._renderer().results({ name: 'nxis_query', annotations: { readOnlyHint: true } }, { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body });
    const item = el._active().items.at(-1);
    expect(item.cards.map((c: { title: string }) => c.title)).toEqual(['Copperline Home Services', 'Drain and sewer rodding']);
    // Its call link, in E.164.
    const calls = [...el.shadowRoot.querySelectorAll('a[href^="tel:"]')].map((a: Element) => a.getAttribute('href'));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((h) => h === 'tel:+17735550142')).toBe(true);
  });
});

describe('tel: links', () => {
  it('are E.164 where the country can be told', () => {
    expect(telHref('(773) 555-0142')).toBe('tel:+17735550142');
    expect(telHref('1-773-555-0142')).toBe('tel:+17735550142');
    expect(telHref('+44 20 7946 0958')).toBe('tel:+442079460958');
    expect(telHref('555-0142')).toBe('tel:5550142');
    expect(telHref('call us')).toBeUndefined();
  });
});

// ── The step cards ──────────────────────────────────────────────────────────

function host(over: Partial<SurfacesHost> = {}) {
  const sent: { text: string; action: SurfaceAction }[] = [];
  const h: SurfacesHost = {
    kit: stepsKit,
    mount: mountSurface,
    act: async (text, action) => (sent.push({ text, action }), true),
    go: () => {},
    origins: () => [],
    back: () => {},
    live: () => true,
    save: () => {},
    ...over,
  };
  return { h, sent };
}

function reply(s: Surfaces, raw: unknown[]) {
  const el = document.createElement('div');
  document.body.append(el);
  const item: any = { kind: 'remote' };
  if (s.receive([item], item, raw)) s.paint(el, item);
  return { el, item };
}

const FORM = {
  version: 'v1.0',
  createSurface: {
    surfaceId: 'quote-who',
    catalogId: STEPS_CATALOG,
    components: [
      { id: 'root', component: 'Column', children: ['city', 'name', 'go'] },
      { id: 'city', component: 'TextField', label: 'City', value: { path: '/form/city' } },
      { id: 'name', component: 'TextField', label: 'Name', value: { path: '/form/name' } },
      { id: 'go', component: 'Button', child: 'go_l', action: { event: { name: 'continue', context: { form: { path: '/form' }, label: 'Continue' } } } },
      { id: 'go_l', component: 'Text', text: 'Continue' },
    ],
    dataModel: { form: { city: 'Milwaukee', name: '' } },
  },
};

const inputs = (el: Element) => deepAll<HTMLInputElement>(el, 'nxis-step-textfield input');
const press = (el: Element) => deepAll<HTMLButtonElement>(el, 'button').find((b) => b.textContent?.trim() === 'Continue')!.click();

describe('a press', () => {
  it('sends a value that came with only a change event', async () => {
    const x = host();
    const { el } = reply(new Surfaces(x.h), [FORM]);
    await sleep(10);
    const [, name] = inputs(el);
    name.value = 'Dana Reyes';
    name.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    press(el);
    await until(() => x.sent.length);
    expect(x.sent[0].action.context.form).toEqual({ city: 'Milwaukee', name: 'Dana Reyes' });
  });

  it('sends what is on screen, even a value that came with no event at all', async () => {
    const x = host();
    const { el } = reply(new Surfaces(x.h), [FORM]);
    await sleep(10);
    const [city, name] = inputs(el);
    city.value = 'Chicago';
    name.value = 'Dana Reyes';
    press(el);
    await until(() => x.sent.length);
    expect(x.sent[0].action.context.form).toEqual({ city: 'Chicago', name: 'Dana Reyes' });
  });
});

describe('an edit on a card', () => {
  it('is kept at once, so a reload right after it keeps it', async () => {
    let saves = 0;
    const { el, item } = reply(new Surfaces(host({ save: () => void saves++ }).h), [FORM]);
    await sleep(10);
    const [city] = inputs(el);
    city.value = 'Chicago';
    city.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    // No wait: what a reload would read now.
    expect(item.surface[0].draft).toEqual({ form: { city: 'Chicago', name: '' } });
    expect(saves).toBeGreaterThan(0);
  });

  it('that fires only change is kept too', async () => {
    const { el, item } = reply(new Surfaces(host().h), [FORM]);
    await sleep(10);
    const [, name] = inputs(el);
    name.value = 'Dana';
    name.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    expect(item.surface[0].draft).toEqual({ form: { city: 'Milwaukee', name: 'Dana' } });
  });
});

describe('a card whose agent has ended', () => {
  it('has its buttons and fields disabled, and they come back if it is live again', async () => {
    let live = true;
    const s = new Surfaces(host({ live: () => live }).h);
    const { el } = reply(s, [SLOTS]);
    await sleep(10);
    const controls = () => deepAll<HTMLButtonElement>(el, 'button');
    const enabled = controls().filter((b) => !b.disabled);
    expect(enabled.length).toBeGreaterThan(0);

    // "Actually never mind": the agent hands back, and the card is over.
    live = false;
    s.sync();
    await sleep(80);
    expect(controls().every((b) => b.disabled)).toBe(true);
    expect(el.querySelector('.surface')!.hasAttribute('data-stale')).toBe(true);
    expect(document.head.querySelector('style[data-surfaces]')!.textContent).toContain('.surface[data-stale] { opacity: .4; filter: grayscale(1); cursor: not-allowed; }');

    live = true;
    s.sync();
    expect(enabled.every((b) => !b.disabled)).toBe(true);
  });
});

describe('the thread after a reload', () => {
  it('stays at its end once the cards drawn after it are in', async () => {
    let top = 0;
    let height = 400;
    const thread = { clientHeight: 300, get scrollHeight() { return height; }, get scrollTop() { return top; }, set scrollTop(v: number) { top = Math.min(v, height - 300); } };
    const el: any = Object.assign(Object.create(NxisAgent.prototype), { _els: { thread }, _endAt: 0 });
    el._scroll();
    expect(top).toBe(100);
    let drawn!: () => void;
    el._keepEnd(new Promise<void>((r) => (drawn = r)));
    height = 900; // the card renders
    drawn();
    await sleep(0);
    expect(top).toBe(600);

    // A visitor who scrolled up stays where they are.
    top = 200;
    el._keepEnd(Promise.resolve());
    height = 1200;
    await sleep(150);
    expect(top).toBe(200);
  });
});

// ── Hours ───────────────────────────────────────────────────────────────────

describe('hours', () => {
  const card = (id: string, name: string, type = 'Plumber') => ({ '@id': id, '@type': type, name });

  it('cite the record they are from, not one that names the place the reply mentions', () => {
    const sources: LocalSource[] = [
      { card: card('emergency', 'Copperline Home Services', 'EmergencyService'), keys: ['Copperline Home Services'], more: ['Park Ridge', 'Norridge'], hours: ['24 hours', '24/7'] },
      { card: card('office', 'Copperline Home Services — Park Ridge'), keys: ['Copperline Home Services — Park Ridge'], hours: ['7 a.m. to 6 p.m.', '7 a.m. to 1 p.m.'] },
    ];
    const a = localAnswer('Weekday office hours are Monday to Friday, 7 a.m. to 6 p.m., according to the Park Ridge location.', sources)!;
    expect(a.cites).toEqual([{ claim: 0, id: 'office' }]);
    expect(localAnswer('Emergency service is available 24/7.', sources)!.cites).toEqual([{ claim: 0, id: 'emergency' }]);
    // Hours no record gives credit none for naming a place.
    expect(localAnswer('We serve Park Ridge from 9 a.m. to 5 p.m.', sources)).toBeNull();
    // A place still cites the record that serves it when no hours are given.
    expect(localAnswer('We serve Park Ridge.', sources)!.cites).toEqual([{ claim: 0, id: 'emergency' }]);
  });

  it('are named for the model with what each record is', () => {
    const office = { '@type': 'Plumber', name: 'Copperline Home Services', openingHoursSpecification: [{ dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '07:00', closes: '18:00' }] };
    const always = { '@type': 'EmergencyService', name: 'Copperline Home Services', openingHoursSpecification: [{ dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: '00:00', closes: '23:59' }] };
    expect(hoursNote([office, always])).toBe(
      '\n(Hours in 12-hour time: Copperline Home Services (Plumber): Monday to Friday 7 a.m. to 6 p.m., Saturday to Sunday closed; Copperline Home Services (Emergency service): 24 hours, every day)',
    );
  });
});
