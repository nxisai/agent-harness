// @vitest-environment jsdom
/**
 * Step cards a conversation has moved past. In a real test run, after Back to assistant the earlier cards' buttons
 * (Change time, Change details, Not you? Clear details) still looked and acted live and the hold kept counting down;
 * the visitor's own held window read "Full"; and a reload lost what the visitor had typed on a card but not sent.
 */
import './helpers/lit-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { deep, deepAll, sleep, until } from './helpers/lit-dom';
import { mountSurface, stepsKit } from '../src/a2ui/host';
import { stepsCatalog } from '../src/a2ui/steps-catalog';
import { STEPS_CATALOG, type SurfaceAction } from '../src/a2ui/steps';
import { Surfaces, type SurfacesHost } from '../src/ui/surfaces';
import { ESTIMATE, SLOTS } from './fixtures/surfaces';

afterEach(() => {
  document.body.innerHTML = '';
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

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

function thread() {
  const root = document.createElement('div');
  document.body.append(root);
  const items: any[] = [];
  const reply = (raw: unknown[], s: Surfaces) => {
    const item: any = { kind: 'remote' };
    items.push(item);
    const el = document.createElement('div');
    root.append(el);
    if (s.receive(items, item, raw)) s.paint(el, item);
    return { item, el };
  };
  return { root, items, reply };
}

const FORM = {
  version: 'v1.0',
  createSurface: {
    surfaceId: 'quote-who',
    catalogId: STEPS_CATALOG,
    components: [
      { id: 'root', component: 'Column', children: ['name', 'go'] },
      { id: 'name', component: 'TextField', label: 'Name', value: { path: '/form/name' } },
      { id: 'go', component: 'Button', child: 'go_l', action: { event: { name: 'continue', context: { form: { path: '/form' }, label: 'Continue' } } } },
      { id: 'go_l', component: 'Text', text: 'Continue' },
    ],
    dataModel: { form: { name: '' } },
  },
};

describe('a superseded surface', () => {
  it('goes inert, dimmed, once a later reply creates a new surface; one the later reply updates stays live', async () => {
    const x = host();
    const s = new Surfaces(x.h);
    const t = thread();
    const a = t.reply([SLOTS], s);
    await sleep(10);
    const slots = a.el.querySelector<HTMLElement>('.surface')!;
    expect(slots.hasAttribute('data-stale')).toBe(false);

    const b = t.reply([ESTIMATE], s);
    await sleep(10);
    expect(slots.hasAttribute('inert')).toBe(true);
    expect(slots.hasAttribute('data-stale')).toBe(true);
    expect(b.el.querySelector('.surface')!.hasAttribute('data-stale')).toBe(false);
    expect(document.head.querySelector('style[data-surfaces]')!.textContent).toContain('.surface[data-stale] { opacity: .4; filter: grayscale(1); cursor: not-allowed; }');
    // Even if a press reached it, nothing is sent.
    deepAll<HTMLButtonElement>(a.el, 'nxis-step-windowgrid button.opt')[0].click();
    await sleep(10);
    expect(x.sent).toEqual([]);

    // A later reply that updates the older surface brings it back.
    t.reply([{ version: 'v1.0', updateDataModel: { surfaceId: 'booking-slots', path: '/booking/summary', value: 'Wed 10' } }], s);
    expect(slots.hasAttribute('data-stale')).toBe(false);
    expect(slots.hasAttribute('inert')).toBe(false);
  });

  it('surfaces one reply creates stay live together', async () => {
    const s = new Surfaces(host().h);
    const { el } = thread().reply([SLOTS, ESTIMATE], s);
    await sleep(10);
    expect([...el.querySelectorAll('.surface')].map((w) => w.hasAttribute('data-stale'))).toEqual([false, false]);
  });

  it('is superseded once the handoff is over, and after a reload of such a conversation', async () => {
    let live = true;
    const s = new Surfaces(host({ live: () => live }).h);
    const { el, item } = thread().reply([SLOTS], s);
    await sleep(10);
    live = false;
    s.sync();
    expect(el.querySelector('.surface')!.hasAttribute('data-stale')).toBe(true);

    document.body.innerHTML = '';
    const again = document.createElement('div');
    document.body.append(again);
    new Surfaces(host({ live: () => false }).h).paint(again, clone(item));
    expect(again.querySelector('.surface')!.hasAttribute('data-stale')).toBe(true);
    expect(again.querySelector('.surface')!.hasAttribute('inert')).toBe(true);
  });
});

describe('a countdown on a superseded surface', () => {
  async function countdown(expiresAt: string, stale: boolean) {
    const box = document.createElement('div');
    if (stale) box.setAttribute('data-stale', '');
    document.body.append(box);
    const actions: any[] = [];
    const m = mountSurface(
      box,
      [{ version: 'v1.0', createSurface: { surfaceId: 's', catalogId: STEPS_CATALOG, components: [{ id: 'root', component: 'HoldCountdown', expiresAt, action: { event: { name: 'hold_expired' } } }] } } as any],
      (e) => actions.push(e),
      stepsCatalog(stepsKit),
    )!;
    await sleep(10);
    return { box, el: m.element, actions };
  }

  it('draws nothing, and never sends its action when the hold runs out', async () => {
    const { el, actions } = await countdown(new Date(Date.now() + 1200).toISOString(), true);
    expect(deep(el, 'nxis-step-holdcountdown .hold')).toBeNull();
    await sleep(2300);
    expect(actions).toEqual([]);
    expect((deep(el, 'nxis-step-holdcountdown') as any)._timer).toBeUndefined();
  });

  it('stops ticking when its surface is superseded', async () => {
    const { box, el, actions } = await countdown(new Date(Date.now() + 1800).toISOString(), false);
    expect(text(deep(el, 'nxis-step-holdcountdown .hold'))).toMatch(/left$/);
    box.setAttribute('data-stale', '');
    await until(() => !deep(el, 'nxis-step-holdcountdown .hold'), 1500);
    expect((deep(el, 'nxis-step-holdcountdown') as any)._timer).toBeUndefined();
    await sleep(1500);
    expect(actions).toEqual([]);
  });
});

describe("the visitor's own held window", () => {
  it('reads "Held for you" and can be chosen, whatever its count says', async () => {
    const box = document.createElement('div');
    document.body.append(box);
    const windows = [
      { value: 'a', label: '8 – 10 am', open: 0, held: true },
      { value: 'b', label: '10 am – 12 pm', held: true, disabled: true },
      { value: 'c', label: '1 – 3 pm', open: 0 },
      { value: 'd', label: '3 – 5 pm', open: 2, held: 'yes' },
    ];
    const m = mountSurface(
      box,
      [{ version: 'v1.0', createSurface: { surfaceId: 's', catalogId: STEPS_CATALOG, components: [{ id: 'root', component: 'WindowGrid', windows, value: { path: '/w' } }] } } as any],
      () => {},
      stepsCatalog(stepsKit),
    )!;
    await sleep(10);
    const wins = deepAll<HTMLButtonElement>(m.element, 'nxis-step-windowgrid button.opt');
    expect(wins.map((b) => [b.querySelector('.small')?.textContent, b.getAttribute('aria-label'), b.disabled])).toEqual([
      ['Held for you', '8 – 10 am, Held for you', false],
      ['Held for you', '10 am – 12 pm, Held for you', false],
      ['Full', '1 – 3 pm, Full', true],
      ['2 open', '3 – 5 pm, 2 open', false],
    ]);
  });
});

describe("a live surface's unsent edits", () => {
  const type = async (el: Element, value: string) => {
    const input = deep<HTMLInputElement>(el, 'nxis-step-textfield input')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  };

  it('are kept with the conversation and drawn into the card again after a reload', async () => {
    let saves = 0;
    const s = new Surfaces(host({ save: () => void saves++ }).h);
    const { el, item } = thread().reply([FORM], s);
    await sleep(10);
    await type(el, 'Dana Reyes');
    await until(() => item.surface[0].draft, 1000);
    expect(item.surface[0].draft).toEqual({ form: { name: 'Dana Reyes' } });
    // What the target sent stays as it was.
    expect(item.surface[0].create.createSurface.dataModel).toEqual({ form: { name: '' } });
    expect(saves).toBeGreaterThan(0);

    // A reload: drawn from what was kept.
    const stored = clone(item);
    document.body.innerHTML = '';
    const again = document.createElement('div');
    document.body.append(again);
    new Surfaces(host().h).paint(again, stored);
    await sleep(10);
    expect(deep<HTMLInputElement>(again, 'nxis-step-textfield input')!.value).toBe('Dana Reyes');
  });

  it('take the target\'s data updates over them, and go once the card sends', async () => {
    const x = host();
    const s = new Surfaces(x.h);
    const t = thread();
    const { el, item } = t.reply([FORM], s);
    await sleep(10);
    await type(el, 'Dana');
    await until(() => item.surface[0].draft, 1000);
    t.reply([{ version: 'v1.0', updateDataModel: { surfaceId: 'quote-who', path: '/form/zip', value: '60630' } }], s);
    expect(item.surface[0].draft).toEqual({ form: { name: 'Dana', zip: '60630' } });

    deepAll<HTMLButtonElement>(el, 'button').find((b) => text(b) === 'Continue')!.click();
    await until(() => x.sent.length);
    await sleep(300);
    expect(x.sent[0].action.context.form).toEqual({ name: 'Dana', zip: '60630' });
    expect(item.surface[0].draft).toBeUndefined();
  });

  it('go once the card is superseded', async () => {
    const s = new Surfaces(host().h);
    const t = thread();
    const { el, item } = t.reply([FORM], s);
    await sleep(10);
    await type(el, 'Dana');
    await until(() => item.surface[0].draft, 1000);
    t.reply([ESTIMATE], s);
    expect(item.surface[0].draft).toBeUndefined();
  });
});
