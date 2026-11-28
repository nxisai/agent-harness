// @vitest-environment jsdom
/**
 * The step components, drawn by the A2UI renderer with the steps catalog: what each one draws, how it reads to
 * assistive technology (real buttons, `aria-pressed`, disabled full choices, labels), and what it sends back when a
 * choice is made or a button pressed. Then the surfaces in a conversation (./surfaces.ts): where they go,
 * how updates reach them, what an action carries to the target, and that only a ConfirmCard commits.
 */
import './helpers/lit-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deep, deepAll, sleep, until } from './helpers/lit-dom';
import { mountSurface, stepsKit } from '../src/a2ui/host';
import { clock, priceRange, secondsLeft, stepsCatalog, tileParts } from '../src/a2ui/steps-catalog';
import { STEPS_CATALOG, readSurfaceMessages, type SurfaceAction } from '../src/a2ui/steps';
import { toV09 } from '../src/a2ui/to-v09';
import { Surfaces, type SurfacesHost } from '../src/ui/surfaces';
import { ESTIMATE, INTAKE, RECEIPT, SLOTS, confirmSurface } from './fixtures/surfaces';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Mount one surface; every action it dispatches is collected. */
async function draw(message: any) {
  const box = document.createElement('div');
  document.body.append(box);
  const actions: any[] = [];
  const m = mountSurface(box, [clone(message)], (e) => actions.push(e), stepsCatalog(stepsKit))!;
  await sleep(10);
  return { box, m, actions, el: m.element };
}

/** One component on a surface of its own. */
const one = (component: Record<string, unknown>, dataModel: Record<string, unknown> = {}) => ({
  version: 'v1.0',
  createSurface: { surfaceId: 's', catalogId: STEPS_CATALOG, components: [{ id: 'root', ...component }], dataModel },
});

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** A choice's words, its spans apart: "Wed 25", "8 – 10 am · 2 open". */
const words = (el: Element) => [...el.querySelectorAll('span')].map((s) => text(s)).filter(Boolean).join(' · ');

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('DayStrip', () => {
  it('draws each day as a button, pressed for the chosen one, a full day disabled with its note', async () => {
    const { el } = await draw(SLOTS);
    const days = deepAll<HTMLButtonElement>(el, 'nxis-step-daystrip button.opt');
    expect(days.map((b) => [words(b), b.getAttribute('aria-pressed'), b.disabled, b.getAttribute('aria-label'), b.type])).toEqual([
      ['Tue · 24', 'false', false, 'Tue 24', 'button'],
      ['Wed · 25', 'true', false, 'Wed 25', 'button'],
      ['Fri · Full', 'false', true, 'Fri 27 Full', 'button'],
    ]);
    const group = deep(el, 'nxis-step-daystrip [role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('This week');
  });

  it('a choice writes the bound value, then sends its action with the new value and the day as the words', async () => {
    const { el, m, actions } = await draw(SLOTS);
    deepAll<HTMLButtonElement>(el, 'nxis-step-daystrip button.opt')[0].click();
    await sleep(10);
    expect(m.read('booking')).toMatchObject({ date: '2026-11-24' });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ name: 'pick_day', surfaceId: 'booking-slots', sourceComponentId: 'days', context: { date: '2026-11-24', label: 'Tue 24' } });
    expect(deepAll(el, 'nxis-step-daystrip button.opt').map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
  });

  it('draws Earlier and Later days only when given, as named buttons that send their actions', async () => {
    const plain = await draw(one({ component: 'DayStrip', days: [], value: { path: '/d' } }));
    expect(deepAll(plain.el, 'nxis-step-daystrip .nav button')).toHaveLength(0);
    const nav = await draw(one({ component: 'DayStrip', label: 'This week', days: [], value: { path: '/d' }, previous: { event: { name: 'earlier' } }, next: { event: { name: 'later' } } }));
    const [prev, next] = deepAll<HTMLButtonElement>(nav.el, 'nxis-step-daystrip .nav button');
    expect([prev.getAttribute('aria-label'), next.getAttribute('aria-label')]).toEqual(['Earlier days', 'Later days']);
    expect(prev.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    next.click();
    await sleep(5);
    expect(nav.actions.map((a) => [a.name, a.context.label])).toEqual([['later', 'Later days']]);
  });
});

describe('WindowGrid', () => {
  it('draws windows with the receiver’s open counts; a full one says Full and is disabled', async () => {
    const { el } = await draw(SLOTS);
    const wins = deepAll<HTMLButtonElement>(el, 'nxis-step-windowgrid button.opt');
    expect(wins.map((b) => [words(b), b.getAttribute('aria-label'), b.disabled, b.getAttribute('aria-pressed')])).toEqual([
      ['8 – 10 am · 2 open', '8 – 10 am, 2 open', false, 'false'],
      ['10 am – 12 pm · 1 open', '10 am – 12 pm, 1 open', false, 'false'],
      ['1 – 3 pm · Full', '1 – 3 pm, Full', true, 'false'],
    ]);
    expect(deep(el, 'nxis-step-windowgrid [role="group"]')!.getAttribute('aria-label')).toBe('Wednesday, arrival window');
  });

  it('without counts, draws no count; disabled is Full too', async () => {
    const { el } = await draw(one({ component: 'WindowGrid', windows: [{ value: 'a', label: '8 – 10 am' }, { value: 'b', label: '1 – 3 pm', disabled: true }], value: { path: '/w' } }));
    expect(deepAll<HTMLButtonElement>(el, 'nxis-step-windowgrid button.opt').map((b) => [words(b), b.disabled])).toEqual([
      ['8 – 10 am', false],
      ['1 – 3 pm · Full', true],
    ]);
  });

  it('a choice sends the day and the window, and its words', async () => {
    const { el, actions } = await draw(SLOTS);
    deepAll<HTMLButtonElement>(el, 'nxis-step-windowgrid button.opt')[1].click();
    await sleep(10);
    expect(actions[0]).toMatchObject({ name: 'pick_window', context: { date: '2026-11-25', window: 'win-10', label: '10 am – 12 pm' } });
    expect(deepAll(el, 'nxis-step-windowgrid button.opt').map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  });
});

describe('HoldCountdown and DateTile', () => {
  it('counts down from expires_at as a timer, then says the hold ended and sends its action once', async () => {
    const at = new Date(Date.now() + 2500).toISOString();
    const { el, actions } = await draw(one({ component: 'HoldCountdown', expiresAt: at, action: { event: { name: 'hold_expired' } } }));
    const line = () => deep(el, 'nxis-step-holdcountdown .hold')!;
    expect(line().getAttribute('role')).toBe('timer');
    expect(text(line())).toMatch(/^Held for you · 0:0[23] left$/);
    expect(line().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await until(() => line().classList.contains('end'), 800);
    expect(line().getAttribute('role')).toBe('status');
    expect(text(line())).toBe('The hold has ended. Pick the time again.');
    await sleep(1100);
    expect(actions.map((a) => a.name)).toEqual(['hold_expired']);
  });

  it('draws nothing without a hold', async () => {
    const { el } = await draw(one({ component: 'HoldCountdown', expiresAt: '' }));
    expect(deep(el, 'nxis-step-holdcountdown .hold')).toBeNull();
  });

  it('a date tile shows the month and day, and reads the whole date', async () => {
    const { el } = await draw(one({ component: 'DateTile', date: '2026-11-25' }));
    const t = deep(el, 'nxis-step-datetile .tile')!;
    expect(text(t.querySelector('.mon'))).toBe('NOV');
    expect(text(t.querySelector('.dn'))).toBe('25');
    expect(t.querySelector('.mon')!.getAttribute('aria-hidden')).toBe('true');
    expect(text(t.querySelector('.sr'))).toBe('Wednesday, November 25');
  });

  it('the helpers: seconds left, the clock, the tile, the price', () => {
    expect(secondsLeft('2026-11-25T15:10:00Z', Date.parse('2026-11-25T15:00:19Z'))).toBe(581);
    expect(secondsLeft('2026-11-25T15:10:00Z', Date.parse('2026-11-25T16:00:00Z'))).toBe(0);
    expect(secondsLeft('soon')).toBeNull();
    expect([clock(581), clock(5), clock(3723)]).toEqual(['9:41', '0:05', '1:02:03']);
    expect(tileParts('2026-02-30')).toMatchObject({ mon: 'MAR', day: '2' });
    expect(tileParts('Nov 25')).toBeNull();
    expect(priceRange(1800, 2600, 'USD')).toBe('$1,800 – $2,600');
    expect(priceRange(99.5, undefined, 'USD')).toBe('$99.50');
    expect(priceRange(150, 150, 'USD')).toBe('$150');
    expect(priceRange(150, 300, 'NOPE')).toBe('150 – 300');
    expect(priceRange(undefined, undefined, 'USD')).toBe('');
  });
});

describe('EstimateCard', () => {
  it('draws the range, what is included and what is priced on site, with Heroicons, not emoji', async () => {
    const { el } = await draw(ESTIMATE);
    const card = deep(el, 'nxis-step-estimatecard .card')!;
    expect(text(card.querySelector('.cap'))).toBe('Estimate · Service');
    expect(text(card.querySelector('.t'))).toBe('Water heater replacement');
    expect(text(card.querySelector('.price'))).toBe('$1,800 – $2,600installed');
    const lists = [...card.querySelectorAll('ul')].map((ul) => [...ul.querySelectorAll('li')].map((li) => [text(li), li.querySelector('svg')!.getAttribute('class')]));
    expect(lists).toEqual([
      [
        ['Haul-away of the old tank', 'ok'],
        ['Permit and code check', 'ok'],
      ],
      [['Venting changes priced on site', 'ink2']],
    ]);
    expect(card.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('its source markers are named buttons that tell the page which Source row to show', async () => {
    const { el } = await draw(ESTIMATE);
    const marks = deepAll<HTMLButtonElement>(el, 'nxis-step-estimatecard .mark');
    expect(marks.map((b) => [text(b), b.getAttribute('aria-label')])).toEqual([
      ['1', 'Source 1'],
      ['2', 'Source 2'],
    ]);
    const cited: unknown[] = [];
    el.addEventListener('nxis-cite', (e) => cited.push((e as CustomEvent).detail));
    marks[1].click();
    expect(cited).toEqual([2]);
  });

  it('its buttons send their actions with their words; one is primary', async () => {
    const { el, actions } = await draw(ESTIMATE);
    const btns = deepAll<HTMLButtonElement>(el, 'nxis-step-estimatecard .acts button');
    expect(btns.map((b) => [text(b), b.className])).toEqual([
      ['Request this quote', 'btn p'],
      ['Adjust details', 'btn'],
    ]);
    btns[0].click();
    await sleep(5);
    expect(actions.map((a) => [a.name, a.context])).toEqual([['request_quote', { label: 'Request this quote' }]]);
  });
});

describe('ConfirmCard', () => {
  it('draws exactly what will be sent, with the date tile and the hold', async () => {
    const { el } = await draw(confirmSurface(new Date(Date.now() + 581_000).toISOString()));
    const card = deep(el, 'nxis-step-confirmcard .card')!;
    expect(text(card.querySelector('.hd'))).toBe('Confirm your visit');
    expect(text(card.querySelector('.tile .sr'))).toBe('Wednesday, November 25');
    expect(text(card.querySelector('.hold'))).toMatch(/^Held for you · 9:4\d left$/);
    expect([...card.querySelectorAll('dl div')].map((d) => [text(d.querySelector('dt')), text(d.querySelector('dd'))])).toEqual([
      ['Address', '12 Elm St, Chicago 60630'],
      ['Contact', 'Dana R. · (312) 555-0136'],
    ]);
    expect([...card.querySelectorAll('.acts button')].map((b) => text(b))).toEqual(['Change time', 'Confirm booking']);
  });

  it('confirm sends the commit key with the rows shown, once; the card then says it was sent', async () => {
    const { el, actions } = await draw(confirmSurface(new Date(Date.now() + 581_000).toISOString()));
    const yes = () => deepAll<HTMLButtonElement>(el, 'nxis-step-confirmcard .acts button')[1];
    yes().click();
    yes().click();
    await sleep(10);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      name: 'confirm_booking',
      sourceComponentId: 'root',
      context: { hold: 'hold-42', label: 'Confirm booking', 'nxis:commit': [{ label: 'Address', value: '12 Elm St, Chicago 60630' }, { label: 'Contact', value: 'Dana R. · (312) 555-0136' }] },
    });
    expect(yes().disabled).toBe(true);
    expect(text(deep(el, 'nxis-step-confirmcard [role="status"]'))).toBe('Sent. Waiting for the answer…');
  });

  it('cancel carries no commit key, and neither does a target that writes one into its own context', async () => {
    const msg = confirmSurface(new Date(Date.now() + 581_000).toISOString());
    (msg.createSurface.components[0] as any).cancel.action.event.context = { 'nxis:commit': [{ label: 'x', value: 'y' }] };
    const { el, actions } = await draw(msg);
    deepAll<HTMLButtonElement>(el, 'nxis-step-confirmcard .acts button')[0].click();
    await sleep(5);
    expect(actions[0].name).toBe('change_time');
    expect(actions[0].context).toEqual({ label: 'Change time' });
  });

  it('once the hold has ended, confirm is disabled', async () => {
    const { el } = await draw(confirmSurface(new Date(Date.now() - 1000).toISOString()));
    expect(deepAll<HTMLButtonElement>(el, 'nxis-step-confirmcard .acts button')[1].disabled).toBe(true);
    expect(text(deep(el, 'nxis-step-confirmcard .hold.end'))).toBe('The hold has ended. Pick the time again.');
  });
});

describe('ReceiptCard', () => {
  it('draws the reference, next steps, Add to calendar first, the follow-ups, and Cancel as a quiet link', async () => {
    const { el } = await draw(RECEIPT);
    const card = deep(el, 'nxis-step-receiptcard .card')!;
    expect(text(card.querySelector('.t'))).toBe("You're booked");
    expect(text(card.querySelector('.ref'))).toBe('CPL-4821');
    expect(text(card.querySelector('.cap'))).toBe('Reference');
    expect([...card.querySelectorAll('.acts button')].map((b) => [text(b), b.className])).toEqual([
      // Secondary, as the mock draws it: the target's own primary is the one primary.
      ['Add to calendar', 'btn'],
      ['Reschedule', 'btn'],
      ['Back to assistant', 'btn'],
    ]);
    expect(text(card.querySelector('button.link'))).toBe('Cancel this visit');
  });

  it('Add to calendar asks the page to download the .ics; the follow-ups send their actions', async () => {
    const { el, actions } = await draw(RECEIPT);
    const opened: unknown[] = [];
    el.addEventListener('nxis-open', () => opened.push('opened as a page'));
    el.addEventListener('nxis-download', (e) => opened.push((e as CustomEvent).detail));
    const [cal, again] = deepAll<HTMLButtonElement>(el, 'nxis-step-receiptcard .acts button');
    cal.click();
    again.click();
    deep<HTMLButtonElement>(el, 'nxis-step-receiptcard button.link')!.click();
    await sleep(5);
    expect(opened).toEqual([{ url: 'https://relay.example/v1/s/site/booking/ics/CPL-4821.ics' }]);
    expect(actions.map((a) => a.name)).toEqual(['reschedule', 'cancel_visit']);
  });

  it('"To change or cancel, call …" with a phone number is a real tel: link, not a button (run 4, step16)', async () => {
    const msg = clone(RECEIPT);
    (msg.createSurface.components[0] as any).cancel = {
      label: 'To change or cancel, call Copperline Home Services at (773) 555-0142',
      action: { event: { name: 'nxis.open', context: { url: 'tel:7735550142', label: 'Call Copperline Home Services' } } },
    };
    const { el, actions } = await draw(msg);
    const link = deep<HTMLAnchorElement>(el, 'nxis-step-receiptcard a.link')!;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('tel:7735550142');
    expect(text(link)).toBe('To change or cancel, call Copperline Home Services at (773) 555-0142');
    expect(deep(el, 'nxis-step-receiptcard button.link')).toBeNull();
    // Anything but a phone number stays a button that sends its action.
    for (const url of ['https://elsewhere.example/', 'javascript:alert(1)', 'tel:not-a-number']) {
      const other = clone(msg);
      (other.createSurface.components[0] as any).cancel.action.event.context.url = url;
      const drawn = await draw(other);
      expect(deep(drawn.el, 'nxis-step-receiptcard a.link')).toBeNull();
      expect(deep(drawn.el, 'nxis-step-receiptcard button.link')).toBeTruthy();
    }
    expect(actions).toEqual([]);
  });

  it('a calendar link that is not https is not drawn', async () => {
    const msg = clone(RECEIPT);
    (msg.createSurface.components[0] as any).calendar.url = 'javascript:alert(1)';
    const { el } = await draw(msg);
    expect(deepAll(el, 'nxis-step-receiptcard .acts button').map(text)).toEqual(['Reschedule', 'Back to assistant']);
  });
});

describe('ChoiceChips', () => {
  const chips = (el: Element, id = 'service') =>
    deepAll<HTMLButtonElement>(el, 'nxis-step-choicechips button.chip').filter((b) => b.getRootNode() === deepAll(el, 'nxis-step-choicechips').find((h) => (h as any).context?.componentModel?.id === id)?.shadowRoot);

  it('draws each choice as a pressed-or-not button in a labelled group, the rest behind More, the chosen one always shown', async () => {
    const { el } = await draw(INTAKE);
    const service = chips(el);
    // max 4, and the chosen one (the sixth) shown besides: five, then More.
    expect(service.map((b) => [text(b), b.getAttribute('aria-pressed'), b.type])).toEqual([
      ['Water heater replacement', 'false', 'button'],
      ['Plumbing service call', 'false', 'button'],
      ['Drain and sewer rodding', 'false', 'button'],
      ['Sump pumps and flood control', 'false', 'button'],
      ['Furnace repair and installation', 'true', 'button'],
      ['More (2)', null, 'button'],
    ]);
    const more = service[5];
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const group = more.closest('[role="group"]')!;
    expect(group.getAttribute('aria-labelledby')).toBe('lbl');
    expect(text(group.getRootNode()!.querySelector('#lbl') as Element)).toBe('Service');
    more.click();
    await sleep(5);
    const open = chips(el);
    expect(open).toHaveLength(8);
    expect(text(open[7])).toBe('Fewer');
    expect(open[7].getAttribute('aria-expanded')).toBe('true');
  });

  it('a choice writes the bound value; with no action it sends nothing, and a step header bound to it follows', async () => {
    const { el, m, actions } = await draw(INTAKE);
    chips(el)[0].click();
    await sleep(10);
    expect(m.read('form')).toMatchObject({ service: 'Water heater replacement' });
    expect(actions).toEqual([]);
    expect(chips(el).filter((b) => b.getAttribute('aria-pressed') === 'true').map(text)).toEqual(['Water heater replacement']);
    expect(text(deep(el, 'nxis-step-stepheader .job'))).toBe('Water heater replacement');
  });

  it('two or three short choices are a segmented control; a choice sends its action with its words', async () => {
    const { el, m, actions } = await draw(INTAKE);
    const fuel = chips(el, 'fuel');
    expect(fuel.map(text)).toEqual(['Gas', 'Electric']);
    const seg = fuel[0].closest('.seg') as HTMLElement;
    expect(seg?.getAttribute('style')).toBe('--n:2');
    expect(fuel[0].closest('.chips')).toBeNull();
    fuel[1].click();
    await sleep(10);
    expect(m.read('form')).toMatchObject({ fuel: 'electric' });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ name: 'pick_fuel', sourceComponentId: 'fuel', context: { fuel: 'electric', label: 'Electric' } });
  });

  it('not segmented when asked not to, or for long words or hints; several choices toggle a list', async () => {
    const opts = [{ value: 'a', label: 'Gas' }, { value: 'b', label: 'Electric' }];
    const off = await draw(one({ component: 'ChoiceChips', options: opts, segmented: false, value: { path: '/v' } }));
    expect(deep(off.el, 'nxis-step-choicechips .seg')).toBeNull();
    const long = await draw(one({ component: 'ChoiceChips', options: [{ value: 'a', label: 'A very long choice indeed' }, { value: 'b', label: 'B' }], value: { path: '/v' } }));
    expect(deep(long.el, 'nxis-step-choicechips .seg')).toBeNull();
    const many = await draw(one({ component: 'ChoiceChips', multiple: true, options: opts, value: { path: '/v' }, action: { event: { name: 'pick' } } }, { v: [] }));
    const [gas, electric] = deepAll<HTMLButtonElement>(many.el, 'nxis-step-choicechips button.chip');
    expect(deep(many.el, 'nxis-step-choicechips .seg')).toBeNull();
    gas.click();
    await sleep(5);
    electric.click();
    await sleep(5);
    expect(many.m.read('v')).toEqual(['a', 'b']);
    expect(many.actions.map((a) => a.context.label)).toEqual(['Gas', 'Gas, Electric']);
    deepAll<HTMLButtonElement>(many.el, 'nxis-step-choicechips button.chip')[0].click();
    await sleep(5);
    expect(many.m.read('v')).toEqual(['b']);
  });

  it('a bound list over the limit draws nothing, rather than some of it', async () => {
    const big = Array.from({ length: 51 }, (_, i) => ({ value: `v${i}`, label: `Choice ${i}` }));
    const { el } = await draw(one({ component: 'ChoiceChips', label: 'Too many', options: '${/opts}', value: { path: '/v' } }, { opts: big }));
    expect(deepAll(el, 'nxis-step-choicechips button')).toHaveLength(0);
  });
});

describe('StepHeader and FieldNote', () => {
  it('a step header says where the visitor is and draws a bar per step, as a progressbar', async () => {
    const { el } = await draw(one({ component: 'StepHeader', step: 2, of: 3, caption: 'The job', title: 'Water heater replacement' }));
    expect(deepAll(el, 'nxis-step-stepheader .top span').map(text)).toEqual(['Step 2 of 3 · The job', 'Water heater replacement']);
    const bar = deep(el, 'nxis-step-stepheader [role="progressbar"]')!;
    expect([bar.getAttribute('aria-valuemin'), bar.getAttribute('aria-valuemax'), bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuetext')]).toEqual([
      '1',
      '3',
      '2',
      'Step 2 of 3 · The job: Water heater replacement',
    ]);
    expect(deepAll(el, 'nxis-step-stepheader .bars i').map((i) => i.className)).toEqual(['on', 'on', '']);
  });

  it('a step past the last is drawn as the last; a header without steps draws nothing', async () => {
    const past = await draw(one({ component: 'StepHeader', step: '${/s}', of: 3 }, { s: 7 }));
    expect(deepAll(past.el, 'nxis-step-stepheader .top span').map(text)).toEqual(['Step 3 of 3']);
    const none = await draw(one({ component: 'StepHeader', step: 1, of: '${/n}' }, { n: 0 }));
    expect(deep(none.el, 'nxis-step-stepheader .sh')).toBeNull();
  });

  it('a field note draws its line with a Heroicon for its tone, follows its data, and draws nothing when empty', async () => {
    const { el, m } = await draw(INTAKE);
    const note = deep(el, 'nxis-step-fieldnote .fn')!;
    expect(note.className).toBe('fn ok');
    expect(note.getAttribute('role')).toBe('status');
    expect(text(note)).toBe('Inside the Chicago service area');
    expect(note.querySelector('svg path')?.getAttribute('d')).toBe('m4.5 12.75 6 6 9-13.5');
    m.send([{ version: 'v1.0', updateDataModel: { surfaceId: 'quote-intake', path: '/area', value: '' } }]);
    await sleep(10);
    expect(deep(el, 'nxis-step-fieldnote .fn')).toBeNull();
    const warn = await draw(one({ component: 'FieldNote', text: 'We may not serve 99999.', tone: 'warn' }));
    expect(deep(warn.el, 'nxis-step-fieldnote .fn')!.className).toBe('fn warn');
    const info = await draw(one({ component: 'FieldNote', text: 'Optional' }));
    expect(deep(info.el, 'nxis-step-fieldnote .fn')!.className).toBe('fn info');
  });
});

describe('field markers and errors (ui.surfaces 3)', () => {
  const FORM = {
    version: 'v1.0',
    createSurface: {
      surfaceId: 'where',
      catalogId: STEPS_CATALOG,
      components: [
        { id: 'root', component: 'Column', children: ['zip', 'street', 'notes', 'when'] },
        { id: 'zip', component: 'TextField', label: 'ZIP code', value: { path: '/form/zip' }, required: true, error: { path: '/errors/zip' } },
        { id: 'street', component: 'TextField', label: 'Street address', value: { path: '/form/street' }, required: true, error: { path: '/errors/street' } },
        { id: 'notes', component: 'TextField', label: 'Anything else?', value: { path: '/form/notes' }, optional: true, variant: 'longText' },
        {
          id: 'when',
          component: 'ChoiceChips',
          label: 'When',
          options: [{ value: 'soon', label: 'This week' }, { value: 'later', label: 'Later' }],
          value: { path: '/form/when' },
          required: true,
          error: { path: '/errors/when' },
        },
      ],
      dataModel: { form: { zip: '53202' }, errors: {} },
    },
  };

  it('draws "Required" or "Optional" after the label, as the mock does, and marks a required field', async () => {
    const { el } = await draw(FORM);
    const [zip, street, notes] = deepAll(el, 'nxis-step-textfield .fld');
    expect(text(zip.querySelector('label'))).toBe('ZIP code Required');
    expect(zip.querySelector('label .mk')?.textContent).toBe('Required');
    expect(zip.querySelector('label')?.getAttribute('for')).toBe('in');
    expect(zip.querySelector('input')?.getAttribute('aria-required')).toBe('true');
    expect((zip.querySelector('input') as HTMLInputElement).value).toBe('53202');
    expect(text(street.querySelector('label'))).toBe('Street address Required');
    expect(text(notes.querySelector('label'))).toBe('Anything else? Optional');
    expect(notes.querySelector('textarea')?.hasAttribute('aria-required')).toBe(false);
    const chips = deep(el, 'nxis-step-choicechips .fld')!;
    expect(text(chips.querySelector('.lbl'))).toBe('When Required');
    expect(chips.querySelector('[role="group"]')?.getAttribute('aria-required')).toBe('true');
    expect(deepAll(el, '.fn')).toHaveLength(0);
  });

  it('a basic primary Button follows the element\'s accent: no primary color is set on the surface', async () => {
    const { el } = await draw({
      version: 'v1.0',
      createSurface: {
        surfaceId: 'acts',
        catalogId: STEPS_CATALOG,
        components: [
          { id: 'root', component: 'Row', children: ['go'] },
          { id: 'go', component: 'Button', child: 'go_l', variant: 'primary', action: { event: { name: 'continue' } } },
          { id: 'go_l', component: 'Text', text: 'Continue' },
        ],
      },
    });
    await sleep(10);
    const styled = deepAll<HTMLElement>(el, '*').filter((e) => e.style?.getPropertyValue('--a2ui-color-primary'));
    expect(styled).toEqual([]);
    expect(toV09(readSurfaceMessages([ESTIMATE]), { primaryColor: null })[0]).toEqual({ version: 'v0.9', createSurface: { surfaceId: 'quote-estimate', catalogId: STEPS_CATALOG } });
  });

  it('a card inside a Card (under its StepHeader) draws without its own border when it is inset', async () => {
    const inset = await draw(one({ component: 'ReceiptCard', title: 'Quote request sent', inset: true }));
    expect(deep(inset.el, 'nxis-step-receiptcard .card')!.className).toBe('card inset');
    const plain = await draw(one({ component: 'ReceiptCard', title: 'Quote request sent' }));
    expect(deep(plain.el, 'nxis-step-receiptcard .card')!.className).toBe('card');
  });

  it('an email field is an email input, a ZIP code a numeric one, each with its autofill hint', async () => {
    const form = await draw({
      version: 'v1.0',
      createSurface: {
        surfaceId: 'who',
        catalogId: STEPS_CATALOG,
        components: [
          { id: 'root', component: 'Column', children: ['email', 'zip', 'phone', 'name'] },
          { id: 'email', component: 'TextField', label: 'Email', value: { path: '/form/email' }, required: true, inputType: 'email', autocomplete: 'email' },
          { id: 'zip', component: 'TextField', label: 'ZIP code', value: { path: '/form/zip' }, required: true, inputType: 'numeric', autocomplete: 'postal-code' },
          { id: 'phone', component: 'TextField', label: 'Phone', value: { path: '/form/phone' }, inputType: 'tel', autocomplete: 'tel' },
          { id: 'name', component: 'TextField', label: 'Name', value: { path: '/form/name' } },
        ],
        dataModel: { form: {} },
      },
    });
    const [email, zip, phone, name] = deepAll<HTMLInputElement>(form.el, 'nxis-step-textfield input');
    expect([email.type, email.getAttribute('inputmode'), email.getAttribute('autocomplete')]).toEqual(['email', 'email', 'email']);
    expect([zip.type, zip.getAttribute('inputmode'), zip.getAttribute('autocomplete')]).toEqual(['text', 'numeric', 'postal-code']);
    expect([phone.type, phone.getAttribute('inputmode'), phone.getAttribute('autocomplete')]).toEqual(['tel', 'tel', 'tel']);
    expect([name.type, name.hasAttribute('inputmode'), name.hasAttribute('autocomplete')]).toEqual(['text', false, false]);
  });

  it('draws every field\'s error under it at once, from one data update, and clears each when it is emptied', async () => {
    const { el, m } = await draw(FORM);
    m.send([{ version: 'v1.0', updateDataModel: { surfaceId: 'where', path: '/errors', value: { zip: 'We don\'t serve ZIP code 53202.', street: 'Add the street address.', when: 'Pick when.' } } }]);
    await sleep(10);
    const [zip, street, notes] = deepAll(el, 'nxis-step-textfield .fld');
    for (const [field, words] of [[zip, 'We don\'t serve ZIP code 53202.'], [street, 'Add the street address.']] as const) {
      const note = field.querySelector('.fn')!;
      expect(note.className).toBe('fn warn');
      expect(text(note)).toBe(words);
      expect(note.querySelector('svg path')?.getAttribute('d')).toMatch(/^M12 9v3\.75/);
      // Under its own field: after the input, in the same field.
      expect(note.previousElementSibling?.tagName).toBe('INPUT');
      const input = field.querySelector('input')!;
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe(note.id);
    }
    expect(notes.querySelector('.fn')).toBeNull();
    const chips = deep(el, 'nxis-step-choicechips .fld')!;
    expect(text(chips.querySelector('.fn.warn'))).toBe('Pick when.');
    expect(chips.querySelector('[role="group"]')?.getAttribute('aria-describedby')).toBe('err');
    m.send([{ version: 'v1.0', updateDataModel: { surfaceId: 'where', path: '/errors/zip', value: '' } }]);
    await sleep(10);
    const after = deepAll(el, 'nxis-step-textfield .fld')[0];
    expect(after.querySelector('.fn')).toBeNull();
    expect(after.querySelector('input')?.hasAttribute('aria-invalid')).toBe(false);
  });

  it('editing a field clears its error on the page until the target checks it again', async () => {
    const { el, m } = await draw(FORM);
    m.send([{ version: 'v1.0', updateDataModel: { surfaceId: 'where', path: '/errors', value: { zip: "We don't serve ZIP code 53202.", street: 'Add the street address.', when: 'Pick when.' } } }]);
    await sleep(10);
    const zip = deepAll<HTMLInputElement>(el, 'nxis-step-textfield input')[0];
    zip.value = '60630';
    zip.dispatchEvent(new Event('input'));
    await sleep(10);
    expect(m.read('errors')).toMatchObject({ zip: '', street: 'Add the street address.' });
    const [z, st] = deepAll(el, 'nxis-step-textfield .fld');
    expect(z.querySelector('.fn')).toBeNull();
    expect(z.querySelector('input')?.hasAttribute('aria-invalid')).toBe(false);
    expect(st.querySelector('.fn')).not.toBeNull();
    // A chip picked clears the chips' error too.
    deepAll<HTMLButtonElement>(el, 'nxis-step-choicechips button.chip')[0].click();
    await sleep(10);
    expect(m.read('errors')).toMatchObject({ when: '' });
    // The target's next check draws it again.
    m.send([{ version: 'v1.0', updateDataModel: { surfaceId: 'where', path: '/errors/zip', value: 'Give a 5-digit ZIP code.' } }]);
    await sleep(10);
    expect(deepAll(el, 'nxis-step-textfield .fld')[0].querySelector('.fn')?.textContent).toContain('Give a 5-digit ZIP code.');
  });

  it('typing writes the bound value; a bound error over the word limit draws nothing', async () => {
    const { el, m } = await draw(FORM);
    const input = deepAll<HTMLInputElement>(el, 'nxis-step-textfield input')[1];
    input.value = '5217 N. Elston Ave';
    input.dispatchEvent(new Event('input'));
    await sleep(10);
    expect(m.read('form')).toMatchObject({ street: '5217 N. Elston Ave' });
    m.send([{ version: 'v1.0', updateDataModel: { surfaceId: 'where', path: '/errors/zip', value: 'x'.repeat(201) } }]);
    await sleep(10);
    expect(deepAll(el, 'nxis-step-textfield .fn')).toHaveLength(0);
  });
});

describe('every choice is a 44 px target', () => {
  it('the step styles give buttons a 44 px minimum both ways and a focus ring', async () => {
    const { el } = await draw(SLOTS);
    const css = [...deep(el, 'nxis-step-daystrip')!.shadowRoot!.querySelectorAll('style')].map((s) => s.textContent).join('') ||
      ((deep(el, 'nxis-step-daystrip') as any).constructor.elementStyles ?? []).map((s: any) => s.cssText).join('');
    expect(css).toMatch(/\.opt,\.btn\{min-height:44px;min-width:44px/);
    expect(css).toMatch(/\.link\{min-height:44px/);
    expect(css).toMatch(/\.chip\{min-height:44px;/);
    expect(css).toMatch(/:focus-visible\{outline:2px solid var\(--blue/);
    // The source marker is small to look at, with a hit area that reaches 44 px.
    expect(css).toMatch(/\.mark::before\{content:"";position:absolute;inset:-13px -8px\}/);
  });
});

// ── The surfaces in a conversation ─────────────────────────────────────────────

function host(over: Partial<SurfacesHost> = {}) {
  const sent: { text: string; action: SurfaceAction }[] = [];
  const opened: [string, string][] = [];
  let backs = 0;
  let saves = 0;
  const h: SurfacesHost = {
    kit: stepsKit,
    mount: mountSurface,
    act: async (text, action) => (sent.push({ text, action }), true),
    go: (url, name) => void opened.push([url, name]),
    origins: () => ['https://relay.example'],
    back: () => void backs++,
    live: () => true,
    save: () => void saves++,
    ...over,
  };
  return { h, sent, opened, backs: () => backs, saves: () => saves };
}

/** A conversation's items, and a reply element in a thread. */
function thread() {
  const root = document.createElement('div');
  document.body.append(root);
  const items: any[] = [];
  const reply = (raw: unknown[], s: Surfaces) => {
    const item: any = { kind: 'remote' };
    items.push(item);
    const el = document.createElement('div');
    el.className = 'remote';
    root.append(el);
    if (s.receive(items, item, raw)) s.paint(el, item);
    return { item, el };
  };
  return { root, items, reply };
}

describe('Surfaces: where they go and how they update', () => {
  it('draws a new surface under its reply, and keeps it as last updated', async () => {
    const { h } = host();
    const s = new Surfaces(h);
    const t = thread();
    const { item, el } = t.reply([SLOTS], s);
    await sleep(10);
    expect(el.classList.contains('has-surface')).toBe(true);
    expect(el.querySelector('.surface')?.getAttribute('data-surface')).toBe('booking-slots');
    expect(item.surface.map((e: any) => e.id)).toEqual(['booking-slots']);
    // An update from a later reply with no surface of its own goes to the live card, and into what is kept.
    const later = t.reply([{ version: 'v1.0', updateDataModel: { surfaceId: 'booking-slots', path: '/booking/hold', value: new Date(Date.now() + 600_000).toISOString() } }], s);
    expect(later.item.surface).toBeUndefined();
    expect(later.el.querySelector('.surface')).toBeNull();
    await sleep(10);
    expect(text(deep(el, 'nxis-step-holdcountdown .hold'))).toMatch(/^Held for you · (10:00|9:5\d) left$/);
    expect(item.surface[0].create.createSurface.dataModel.booking.hold).toMatch(/^20/);
    expect(document.head.querySelector('style[data-surfaces]')).not.toBeNull();
  });

  it('a step surface spans the panel, and its basic fields share one label color, size and weight', async () => {
    const s = new Surfaces(host().h);
    thread().reply([INTAKE], s);
    const css = document.head.querySelector('style[data-surfaces]')!.textContent!;
    expect(css).toMatch(/\.surface \{ width: 100%; margin-top: 6px; \}/);
    expect(css).not.toMatch(/420px|460px/);
    expect(css).toMatch(/\.remote\.has-surface \{ max-width: 100%; width: 100%; \}/);
    expect(css).toContain('--a2ui-choicepicker-label-color: var(--ink); --a2ui-choicepicker-label-font-size: 13px; --a2ui-choicepicker-label-font-weight: 600;');
    expect(css).toContain('--a2ui-textfield-label-font-size: 13px; --a2ui-textfield-label-font-weight: 600;');
  });

  it('a surface created again replaces the earlier card; deleteSurface removes it', async () => {
    const s = new Surfaces(host().h);
    const t = thread();
    const a = t.reply([SLOTS], s);
    const b = t.reply([SLOTS], s);
    await sleep(10);
    expect(a.item.surface).toEqual([]);
    expect(a.el.querySelector('.surface')).toBeNull();
    expect(b.el.querySelector('.surface')).not.toBeNull();
    t.reply([{ version: 'v1.0', deleteSurface: { surfaceId: 'booking-slots' } }], s);
    expect(b.item.surface).toEqual([]);
    expect(b.el.querySelector('.surface')).toBeNull();
  });

  it('keeps at most eight surfaces in a conversation: the oldest goes first', () => {
    const s = new Surfaces(host().h);
    const t = thread();
    for (let i = 0; i < 10; i++) t.reply([{ version: 'v1.0', createSurface: { surfaceId: `s${i}`, catalogId: STEPS_CATALOG, components: [{ id: 'root', component: 'Text', text: `n${i}` }] } }], s);
    expect(t.items.flatMap((it) => it.surface ?? []).map((e: any) => e.id)).toEqual(['s2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
  });

  it('a stored conversation draws its surfaces as they were kept', async () => {
    const s = new Surfaces(host().h);
    const t = thread();
    const { item } = t.reply([SLOTS], s);
    const stored = JSON.parse(JSON.stringify(item));
    document.body.innerHTML = '';
    const el = document.createElement('div');
    document.body.append(el);
    new Surfaces(host().h).paint(el, stored);
    await sleep(10);
    expect(deepAll(el, 'nxis-step-windowgrid button.opt')).toHaveLength(3);
  });
});

describe('Surfaces: what an action sends', () => {
  it('a choice goes to the target as an action part with the visitor’s words; every surface waits for the answer', async () => {
    const x = host();
    const s = new Surfaces(x.h);
    const t = thread();
    const { el } = t.reply([SLOTS, ESTIMATE], s);
    await sleep(10);
    deepAll<HTMLButtonElement>(el, 'nxis-step-windowgrid button.opt')[1].click();
    await until(() => x.sent.length);
    expect(x.sent[0]).toEqual({
      text: '10 am – 12 pm',
      action: { handoff: 'action', surfaceId: 'booking-slots', name: 'pick_window', component: 'windows', context: { date: '2026-11-25', window: 'win-10', label: '10 am – 12 pm' } },
    });
    const wraps = [...el.querySelectorAll<HTMLElement>('.surface')];
    expect(wraps.map((w) => [w.hasAttribute('inert'), w.getAttribute('aria-busy')])).toEqual([
      [true, 'true'],
      [true, 'true'],
    ]);
    // A second press before the answer sends nothing.
    deepAll<HTMLButtonElement>(el, 'nxis-step-windowgrid button.opt')[0].click();
    await sleep(10);
    expect(x.sent).toHaveLength(1);
    // The target answers: the surfaces are the visitor's again.
    s.sync(true);
    expect(wraps.map((w) => w.hasAttribute('inert'))).toEqual([false, false]);
  });

  it('a Button sends its context, the words from context.label, else its name', async () => {
    const x = host();
    const s = new Surfaces(x.h);
    const { el } = thread().reply(
      [
        {
          version: 'v1.0',
          createSurface: {
            surfaceId: 'quote-intake',
            catalogId: STEPS_CATALOG,
            components: [
              { id: 'root', component: 'Row', children: ['back', 'go'] },
              { id: 'back', component: 'Button', child: 'back_l', action: { event: { name: 'back' } } },
              { id: 'back_l', component: 'Text', text: 'Back' },
              { id: 'go', component: 'Button', child: 'go_l', variant: 'primary', action: { event: { name: 'continue', context: { form: { path: '/form' }, label: 'See the estimate' } } } },
              { id: 'go_l', component: 'Text', text: 'See the estimate' },
            ],
            dataModel: { form: { tank: 'Tank, 50 gal', fuel: 'Gas', zip: '60630' } },
          },
        },
      ],
      s,
    );
    await sleep(10);
    deepAll<HTMLButtonElement>(el, 'a2ui-basic-button button')[1].click();
    await until(() => x.sent.length);
    expect(x.sent[0]).toEqual({ text: 'See the estimate', action: { handoff: 'action', surfaceId: 'quote-intake', name: 'continue', component: 'go', context: { form: { tank: 'Tank, 50 gal', fuel: 'Gas', zip: '60630' }, label: 'See the estimate' } } });
    s.sync(true);
    deepAll<HTMLButtonElement>(el, 'a2ui-basic-button button')[0].click();
    await until(() => x.sent.length > 1);
    expect(x.sent[1].text).toBe('back');
  });

  it('a ConfirmCard’s confirm commits, with the rows the visitor saw; its surface stays done', async () => {
    const x = host();
    const s = new Surfaces(x.h);
    const { el, item } = thread().reply([confirmSurface(new Date(Date.now() + 581_000).toISOString())], s);
    await sleep(10);
    deepAll<HTMLButtonElement>(el, 'nxis-step-confirmcard .acts button')[1].click();
    await until(() => x.sent.length);
    const { action, text: words } = x.sent[0];
    expect(words).toBe('Confirm booking');
    expect(action).toMatchObject({ name: 'confirm_booking', commit: true, context: { hold: 'hold-42', label: 'Confirm booking' } });
    expect(action.context).not.toHaveProperty('nxis:commit');
    expect(action.consent!.rows).toEqual([
      { label: 'Address', value: '12 Elm St, Chicago 60630' },
      { label: 'Contact', value: 'Dana R. · (312) 555-0136' },
    ]);
    expect(Date.parse(action.consent!.at)).toBeGreaterThan(Date.now() - 5000);
    expect(item.surface[0].done).toBe(true);
    s.sync(true);
    expect(el.querySelector('.surface')!.hasAttribute('inert')).toBe(true);
  });

  it('a commit is a ConfirmCard’s: a Button whose context claims one sends a plain choice', async () => {
    const x = host();
    const s = new Surfaces(x.h);
    const { el } = thread().reply(
      [
        {
          version: 'v1.0',
          createSurface: {
            surfaceId: 'sneaky',
            catalogId: STEPS_CATALOG,
            components: [
              { id: 'root', component: 'Button', child: 'l', action: { event: { name: 'confirm_booking', context: { 'nxis:commit': [{ label: 'a', value: 'b' }], commit: true } } } },
              { id: 'l', component: 'Text', text: 'Book' },
            ],
          },
        },
      ],
      s,
    );
    await sleep(10);
    deep<HTMLButtonElement>(el, 'a2ui-basic-button button')!.click();
    await until(() => x.sent.length);
    expect(x.sent[0].action.commit).toBeUndefined();
    expect(x.sent[0].action.consent).toBeUndefined();
    expect(x.sent[0].action.context).not.toHaveProperty('nxis:commit');
  });

  it('a commit that was not sent gives the card back', async () => {
    const x = host({ act: async () => false });
    const s = new Surfaces(x.h);
    const { el, item } = thread().reply([confirmSurface(new Date(Date.now() + 581_000).toISOString())], s);
    await sleep(10);
    deepAll<HTMLButtonElement>(el, 'nxis-step-confirmcard .acts button')[1].click();
    await sleep(20);
    expect(item.surface[0].done).toBe(false);
    expect(el.querySelector('.surface')!.hasAttribute('inert')).toBe(false);
    expect(deepAll<HTMLButtonElement>(el, 'nxis-step-confirmcard .acts button')[1].disabled).toBe(false);
  });

  it('nxis.back and nxis.open are the page’s own; Add to calendar downloads through the page; nothing is sent', async () => {
    const x = host();
    const s = new Surfaces(x.h);
    const { el } = thread().reply(
      [
        RECEIPT,
        {
          version: 'v1.0',
          createSurface: {
            surfaceId: 'emergency',
            catalogId: STEPS_CATALOG,
            components: [
              { id: 'root', component: 'Button', child: 'l', action: { event: { name: 'nxis.open', context: { url: 'tel:+13125550136', label: 'Call now' } } } },
              { id: 'l', component: 'Text', text: 'Call now' },
            ],
          },
        },
      ],
      s,
    );
    await sleep(10);
    const dialed: string[] = [];
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      dialed.push(this.href);
      if (this.hasAttribute('download')) downloads.push(this.getAttribute('download')!);
    });
    const receipt = deepAll<HTMLButtonElement>(el, 'nxis-step-receiptcard .acts button');
    receipt[0].click();
    receipt[2].click();
    deep<HTMLButtonElement>(el, 'a2ui-basic-button button')!.click();
    await sleep(10);
    // The file is downloaded where it is: no confirmation, no new window, no navigation.
    expect(x.opened).toEqual([]);
    expect(downloads).toEqual(['']);
    expect(dialed).toEqual(['https://relay.example/v1/s/site/booking/ics/CPL-4821.ics', 'tel:+13125550136']);
    expect(x.backs()).toBe(1);
    expect(x.sent).toEqual([]);
  });

  it('downloads a file only from https on this page’s origin or the host’s, as a download, never a page', () => {
    const x = host();
    const s = new Surfaces(x.h);
    const clicked: { href: string; download: string; target: string }[] = [];
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const open = vi.spyOn(window, 'open');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.getAttribute('download') ?? '(none)', target: this.target });
    });
    for (const url of ['https://relay.example/a.ics', `${location.origin}/b.ics`, 'https://elsewhere.example/a.ics', 'http://relay.example/a.ics', 'javascript:alert(1)', 'data:text/calendar,x']) s.download(url);
    expect(clicked).toEqual([
      { href: 'https://relay.example/a.ics', download: '', target: '' },
      { href: `${location.origin}/b.ics`, download: '', target: '' },
    ]);
    expect(x.opened).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens only https links on this page’s origin or the host’s: anything else stays shut', () => {
    const x = host();
    const s = new Surfaces(x.h);
    for (const url of ['https://relay.example/a.ics', `${location.origin}/book`, 'https://elsewhere.example/a.ics', 'http://relay.example/a.ics', 'javascript:alert(1)', 'data:text/calendar,x', 'tel:not-a-number']) s.open(url, 'n');
    expect(x.opened.map(([u]) => u)).toEqual(['https://relay.example/a.ics', `${location.origin}/book`]);
  });

  it('a source marker on the estimate moves to its row in the reply’s Sources list', async () => {
    const s = new Surfaces(host().h);
    const t = thread();
    const item: any = { kind: 'remote' };
    t.items.push(item);
    const el = document.createElement('div');
    el.innerHTML = '<div class="msg"><div class="ra-src"><ol><li><a class="ra-srow" data-n="1" href="#a">A</a></li><li><a class="ra-srow" data-n="2" href="#b">B</a></li></ol></div></div>';
    t.root.append(el);
    s.receive(t.items, item, [ESTIMATE]);
    s.paint(el, item);
    await sleep(10);
    deepAll<HTMLButtonElement>(el, 'nxis-step-estimatecard .mark')[1].click();
    const row = el.querySelector<HTMLElement>('.ra-srow[data-n="2"]')!;
    expect(row.classList.contains('ra-hl')).toBe(true);
    expect(el.ownerDocument.activeElement).toBe(row);
  });

  it('once the handoff is over, every surface is inert and nothing is sent', async () => {
    let live = true;
    const x = host({ live: () => live });
    const s = new Surfaces(x.h);
    const { el } = thread().reply([SLOTS], s);
    await sleep(10);
    live = false;
    s.sync();
    expect(el.querySelector('.surface')!.hasAttribute('inert')).toBe(true);
    expect(el.querySelector('.surface')!.getAttribute('aria-busy')).toBe('false');
    deepAll<HTMLButtonElement>(el, 'nxis-step-daystrip button.opt')[0].click();
    await sleep(10);
    expect(x.sent).toEqual([]);
  });
});
