/**
 * Podcast episodes and series, as the NxisAI app draws them: Listen
 * and Subscribe worded by access, a series card with its parts, durations, and episodes grouped by show.
 *
 * The fixture is the MCP server's own podcast fixture, as is: Brackwater Audio's records
 * from the podcast example (free, preview, paid and sign-up episodes, and three series with their parts in full).
 * The cases follow the MCP server's widget tests, so the two surfaces draw the same buttons.
 */
import { describe, expect, it } from 'vitest';
import F from './fixtures/podcast-records.json';
import { actionCta, cardCtas, mediaCtas, seriesCtas, targetUrl, type CardButton, type CardCtas } from '../src/harness/cta';
import { access, accessAction, archetype, clock, runtime, subtitle } from '../src/harness/entity';
import { groupBySeries, mediaLineText, mediaRow, seriesCard, seriesHeadings } from '../src/harness/media';
import { emitCardsSurface, emitSeriesSurface, showAllMessages, toCardData } from '../src/a2ui/cards';
import { emitResultsSurface } from '../src/a2ui/results';
import { toV09 } from '../src/a2ui/to-v09';
import { openTarget, openWay } from '../src/harness/tools/open-target';

type Obj = Record<string, any>;
const E = F.episodes as Record<string, Obj>;
const S = F.series as Record<string, Obj>;
const SITE = 'https://podcast.example';

/** "*Listen, Subscribe": the lead starred, as the MCP server's widget tests write it. */
const labels = (c: CardCtas | undefined): string[] => (c ? [`*${c.lead.label}`, ...(c.secondary ? [c.secondary.label] : [])] : []);
const url = (b: CardButton | undefined) => (b && b.kind === 'open' ? b.url : undefined);

describe('Listen and Subscribe on an episode', () => {
  it('free: Listen opens the player, Subscribe the show’s subscribe page, each with what a tap reports', () => {
    const c = cardCtas(E.free)!;
    expect(labels(c)).toEqual(['*Listen', 'Subscribe']);
    expect(c.lead).toEqual({
      kind: 'open',
      label: 'Listen',
      url: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#player`,
      intent: 'consume',
      actionType: 'ListenAction',
      actionId: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#listen`,
      reportToken: 'tok.listen',
    });
    expect(c.secondary).toMatchObject({ url: `${SITE}/subscribe/lantern-hours.html`, actionType: 'SubscribeAction', reportToken: 'tok.subscribe' });
  });

  it('a free preview: Listen to preview, then Subscribe', () => {
    expect(labels(cardCtas(E.preview))).toEqual(['*Listen to preview', 'Subscribe']);
  });

  it('paid: Subscribe to listen opens the subscribe page, locked, with their page second', () => {
    const c = cardCtas(E.paid)!;
    expect(labels(c)).toEqual(['*Subscribe to listen', 'Their page']);
    expect(c.lead).toMatchObject({ url: `${SITE}/subscribe/lantern-hours.html`, actionType: 'SubscribeAction', intent: 'transact', locked: true });
    expect(url(c.secondary)).toBe(`${SITE}/shows/lantern-hours/05-brass-tarnish-patience.html`);
  });

  it('a free sign-up: Sign up to listen, not locked', () => {
    const c = cardCtas(E.signup)!;
    expect(labels(c)).toEqual(['*Sign up to listen', 'Their page']);
    expect(c.lead).not.toHaveProperty('locked');
  });

  it('another show’s free episode, with no report token, reports none', () => {
    const c = cardCtas(E.tidecount)!;
    expect(labels(c)).toEqual(['*Listen', 'Subscribe']);
    expect(c.lead).not.toHaveProperty('reportToken');
  });

  it('paid by the record alone, with no Subscribe: Listen’s own target, as Subscribe to listen', () => {
    const r = { '@type': 'PodcastEpisode', name: 'x', isAccessibleForFree: false, potentialAction: { '@type': 'ListenAction', target: 'https://x.example/e#player' } };
    expect(labels(cardCtas(r))).toEqual(['*Subscribe to listen']);
    expect(url(cardCtas(r)!.lead)).toBe('https://x.example/e#player');
  });

  it('draws no button for a target with a blank to fill in, or one that isn’t http(s)', () => {
    const r = {
      '@type': 'PodcastEpisode',
      name: 'x',
      isAccessibleForFree: true,
      potentialAction: [
        { '@type': 'ListenAction', target: { urlTemplate: 'https://x.example/{id}' } },
        { '@type': 'SubscribeAction', target: 'javascript:alert(1)' },
      ],
    };
    expect(cardCtas(r)).toBeUndefined();
    expect(targetUrl({ target: { '@type': 'EntryPoint', url: 'https://x.example/s' } })).toBe('https://x.example/s');
  });

  it('reads access from Listen: a free sign-up, and a work that isn’t free but is open to anyone as a preview', () => {
    expect(access(E.signup, accessAction(E.signup))).toEqual({ state: 'registration', label: 'Free with sign-up' });
    expect(access(E.paid, accessAction(E.paid))).toEqual({ state: 'subscription', label: 'Subscription' });
    expect(access(E.preview, accessAction(E.preview))?.state).toBe('preview');
  });
});

describe('an episode’s row', () => {
  const row = (r: Obj) => {
    const m = mediaRow(r);
    return [m.series, m.episode, m.duration, m.access?.label, m.ctas?.lead.label];
  };

  it('says its show, number, length and access, with its lead', () => {
    expect(row(E.free)).toEqual(['Lantern Hours', 2, '0:10', 'Free', 'Listen']);
    expect(row(E.preview)).toEqual(['Lantern Hours', 4, '0:11', 'Preview', 'Listen to preview']);
    expect(row(E.paid)).toEqual(['Lantern Hours', 5, '0:09', 'Subscribers', 'Subscribe to listen']);
    expect(row(E.signup)).toEqual(['Lantern Hours', 12, '0:09', 'Free with sign-up', 'Sign up to listen']);
    expect(row(E.tidecount)).toEqual(['Tidecount', 1, '0:09', 'Free', 'Listen']);
  });

  it('reads as one line: "Lantern Hours · Episode 2 · 0:10 · Free"', () => {
    expect(mediaLineText(mediaRow(E.free))).toBe('Lantern Hours · Episode 2 · 0:10 · Free');
    expect(mediaLineText(mediaRow(E.paid), { withSeries: false })).toBe('Episode 5 · 0:09 · Subscribers');
    expect(mediaLineText(mediaRow(E.preview), { inSeries: true })).toBe('0:11 · Preview');
    expect(subtitle(E.free)).toBe('Lantern Hours · Episode 2');
  });
});

describe('durations', () => {
  it('read ISO 8601 as a clock does', () => {
    expect(['PT8S', 'PT1H2M', 'PT12M5S', 'PT59.6S', 'P1DT1S', 'PT', '8 seconds', undefined].map(clock)).toEqual([
      '0:08', '1:02:00', '12:05', '1:00', '24:00:01', undefined, undefined, undefined,
    ]);
  });

  it('come from the record, else its associated media or audio, else nowhere', () => {
    expect(runtime({ associatedMedia: { duration: 'PT1H2M' } })).toBe('1:02:00');
    expect(runtime({ timeRequired: 'PT4M5S' })).toBe('4:05');
    expect(runtime({ name: 'x' })).toBeUndefined();
  });
});

describe('a podcast series', () => {
  it('Lantern Hours: some free, so it leads with the latest free episode and says so in its badge', () => {
    const s = seriesCard(S['lantern-hours'])!;
    expect(archetype(S['lantern-hours'])).toBe('series');
    expect(s.subtitle).toBe('Podcast · Brackwater Audio · 12 episodes');
    expect(s.badge).toEqual({ state: 'mixed', label: 'Free · some for subscribers' });
    expect(labels(s.ctas)).toEqual(['*Listen to the latest', 'Subscribe']);
    // The latest free episode is the third, by date then number; its Listen is what the tap opens.
    expect(s.latest).toBe('Glue, and when not to use it');
    expect(s.ctas!.lead).toMatchObject({
      url: `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#player`,
      actionType: 'ListenAction',
      actionId: `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#listen`,
    });
    expect(url(s.ctas!.secondary)).toBe(`${SITE}/subscribe/lantern-hours.html`);
    expect(s.art).toBe(`${SITE}/covers/lantern-hours.svg`);
  });

  it('Lantern Hours: every part a row with its own access and button; a paid one subscribes through the series', () => {
    const s = seriesCard(S['lantern-hours'])!;
    expect(s.parts).toHaveLength(12);
    const rows = s.parts.map((p) => [p.episode, p.duration, p.access?.label, p.ctas?.lead.label]);
    expect(rows.slice(0, 5)).toEqual([
      [1, '0:10', 'Free', 'Listen'],
      [2, '0:10', 'Free', 'Listen'],
      [3, '0:10', 'Free', 'Listen'],
      [4, '0:11', 'Preview', 'Listen to preview'],
      [5, '0:09', 'Subscribers', 'Subscribe to listen'],
    ]);
    expect(rows[11]).toEqual([12, '0:09', 'Free with sign-up', 'Sign up to listen']);
    const counts = s.parts.reduce<Record<string, number>>((m, p) => ((m[p.access!.state] = (m[p.access!.state] ?? 0) + 1), m), {});
    expect(counts).toEqual({ free: 3, preview: 1, subscription: 7, registration: 1 });
    expect(s.parts.every((p) => url(p.ctas?.lead))).toBe(true);
    expect(s.parts[4].ctas!.lead).toMatchObject({ url: `${SITE}/subscribe/lantern-hours.html`, actionType: 'SubscribeAction' });
    expect(url(s.parts[0].ctas!.lead)).toBe(`${SITE}/shows/lantern-hours/01-why-old-things-break.html#player`);
    expect(s.parts[0].series).toBe('Lantern Hours');
  });

  it('Tidecount: all free, so its badge is Free and it leads with its fourth episode', () => {
    const s = seriesCard(S.tidecount)!;
    expect(s.badge).toEqual({ state: 'free', label: 'Free' });
    expect(labels(s.ctas)).toEqual(['*Listen to the latest', 'Subscribe']);
    expect(url(s.ctas!.lead)).toMatch(/\/shows\/tidecount\/04-[^/]+\.html#player$/);
    expect(s.subtitle).toBe('Podcast · Brackwater Audio · 4 episodes');
  });

  it('Margin Notes: none free, so Subscribers, and Subscribe to listen leads', () => {
    const s = seriesCard(S['margin-notes'])!;
    expect(s.badge).toEqual({ state: 'subscription', label: 'Subscribers' });
    expect(labels(s.ctas)).toEqual(['*Subscribe to listen', 'Their page']);
    expect(s.ctas!.lead).toMatchObject({ url: `${SITE}/subscribe/margin-notes.html`, actionType: 'SubscribeAction', locked: true });
    expect(s.parts.every((p) => p.ctas?.lead.label === 'Subscribe to listen')).toBe(true);
  });

  it('a series that doesn’t list its parts has no card of its own, and its own Listen and Subscribe', () => {
    const bare = { ...S['lantern-hours'], hasPart: undefined, numberOfEpisodes: 12 };
    expect(seriesCard(bare)).toBeUndefined();
    expect(subtitle(bare)).toBe('Podcast · Brackwater Audio · 12 episodes');
    expect(labels(seriesCtas(bare))).toEqual(['*Listen', 'Subscribe']);
    expect(subtitle({ '@type': 'PodcastSeries', name: 'x', author: [{ name: 'Ines' }] })).toBe('Podcast · Ines');
    expect(seriesCard({ ...S['lantern-hours'], image: 'http://x.example/a.png' })!.art).toBeUndefined();
  });
});

describe('a results list’s show headings', () => {
  it('has none, and no crash, when the list holds no episodes (businesses, or a lone series)', () => {
    expect(seriesHeadings([])).toEqual({ bySeries: false, counts: new Map() });
  });
  it('groups only when episodes span more than one show', () => {
    expect(seriesHeadings(['Lantern Hours', 'Lantern Hours']).bySeries).toBe(false);
    const several = seriesHeadings(['Lantern Hours', 'Tidecount', 'Lantern Hours', undefined]);
    expect(several.bySeries).toBe(true);
    expect([...several.counts]).toEqual([
      ['Lantern Hours', 'Lantern Hours · 2'],
      ['Tidecount', 'Tidecount · 1'],
      ['Other episodes', 'Other episodes · 1'],
    ]);
  });
});

describe('episodes from several shows', () => {
  it('are grouped by show, in the order each first came, with a count', () => {
    const groups = groupBySeries([E.free, E.tidecount, E.paid].map(mediaRow));
    expect(groups.map((g) => [g.heading, g.rows.map((r) => r.title)])).toEqual([
      ['Lantern Hours · 2', ['The drawer that sticks', 'Brass, tarnish and patience']],
      ['Tidecount · 1', ['Counting herons at dawn']],
    ]);
  });

  it('from one show stay one list, without a heading', () => {
    expect(groupBySeries([E.free, E.paid].map(mediaRow))).toEqual([{ rows: [E.free, E.paid].map(mediaRow) }]);
  });
});

/** The v0.9 messages a surface renders from: its components, and its data by key. */
function rendered(messages: ReturnType<typeof emitResultsSurface>) {
  const v09 = toV09(messages);
  const components = v09.find((m) => m.updateComponents)!.updateComponents.components as Obj[];
  const data = Object.fromEntries(v09.filter((m) => m.updateDataModel).map((m) => [m.updateDataModel.path.slice(1), m.updateDataModel.value]));
  return { components, data, byId: (id: string) => components.find((c) => c.id === id)! };
}

describe('the A2UI surfaces', () => {
  it('draw episodes as rows: their line, and the lead always on show, opening its target', () => {
    const { data, byId } = rendered(emitResultsSurface('nxis_query', [E.free, E.preview, E.paid, E.signup]));
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].heading).toEqual([]);
    const rows = data.groups[0].rows as Obj[];
    expect(rows.map((r) => r.line)).toEqual([
      'Lantern Hours · Episode 2 · 0:10 · Free',
      'Lantern Hours · Episode 4 · 0:11 · Preview',
      'Lantern Hours · Episode 5 · 0:09 · Subscribers',
      'Lantern Hours · Episode 12 · 0:09 · Free with sign-up',
    ]);
    expect(rows.map((r) => r.lead[0].label)).toEqual(['▶ Listen', '▶ Listen to preview', 'Subscribe to listen', 'Sign up to listen']);
    expect(rows[0].lead[0]).toMatchObject({ url: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#player`, name: 'The drawer that sticks', actionType: 'ListenAction' });
    // No initials avatar: a row is its words and its button.
    expect(byId('ep_row').children).toEqual(['ep_who', 'ep_lead']);
    // A tap opens; it never asks the agent.
    expect(byId('ep_btn').action.event).toEqual({
      name: 'nxis.open',
      context: { url: { path: 'url' }, name: { path: 'name' }, actionType: { path: 'actionType' }, actionId: { path: 'actionId' } },
    });
    expect(data.more).toEqual([]);
  });

  it('group episodes from several shows under their show, and leave the show out of the row', () => {
    const { data } = rendered(emitResultsSurface('nxis_query', [E.free, E.tidecount, E.paid]));
    expect((data.groups as Obj[]).map((g) => g.heading.map((h: Obj) => h.label))).toEqual([['Lantern Hours · 2'], ['Tidecount · 1']]);
    expect((data.groups as Obj[]).flatMap((g) => g.rows.map((r: Obj) => r.line))).toEqual([
      'Episode 2 · 0:10 · Free',
      'Episode 5 · 0:09 · Subscribers',
      'Episode 1 · 0:09 · Free',
    ]);
  });

  it('end a long episode list with "Show all N episodes"', () => {
    const many = (S['lantern-hours'].hasPart as Obj[]).map((p) => ({ '@type': 'PodcastEpisode', partOfSeries: { name: 'Lantern Hours' }, ...p }));
    const { data } = rendered(emitResultsSurface('nxis_query', many));
    expect((data.groups as Obj[]).flatMap((g) => g.rows)).toHaveLength(5);
    expect(data.more).toEqual([{ label: 'Show all 12 episodes' }]);
    expect(data.all.groups[0].rows).toHaveLength(12);
  });

  it('draw a lone series as its card: identity, actions, three parts, then Show all episodes', () => {
    const messages = emitResultsSurface('nxis_get', [S['lantern-hours']]);
    const { data, byId } = rendered(messages);
    expect([data.title, data.subtitle, data.badge]).toEqual(['Lantern Hours', 'Podcast · Brackwater Audio · 12 episodes', 'Free · some for subscribers']);
    expect(data.art).toEqual([{ url: `${SITE}/covers/lantern-hours.svg`, alt: 'Lantern Hours' }]);
    expect(data.lead).toEqual([{
      label: '▶ Listen to the latest',
      url: `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#player`,
      name: 'Glue, and when not to use it',
      actionType: 'ListenAction',
      actionId: `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#listen`,
    }]);
    expect(data.secondary.map((b: Obj) => b.label)).toEqual(['Subscribe']);
    expect(byId('series_lead_btn').variant).toBe('primary');
    expect(byId('series_eyebrow').text).toBe('Episodes');
    expect((data.parts as Obj[]).map((p) => [p.title, p.line, p.lead[0].label])).toEqual([
      ['Why old things break where they do', '0:10 · Free', '▶ Listen'],
      ['The drawer that sticks', '0:10 · Free', '▶ Listen'],
      ['Glue, and when not to use it', '0:10 · Free', '▶ Listen'],
    ]);
    expect(data.more).toEqual([{ label: 'Show all episodes' }]);
    expect(byId('more_btn').action.event.name).toBe('nxis.more');

    // "Show all episodes" swaps in every part and takes the button away.
    const all = showAllMessages('results', (key) => (messages[0].createSurface as Obj).dataModel[key]);
    const parts = all.find((m) => (m.updateDataModel as Obj).path === '/parts')!.updateDataModel as Obj;
    expect(parts.value).toHaveLength(12);
    expect(parts.value[4]).toMatchObject({ line: '0:09 · Subscribers', lead: [{ label: 'Subscribe to listen', url: `${SITE}/subscribe/lantern-hours.html` }] });
    expect(all.at(-1)).toEqual({ version: 'v1.0', updateDataModel: { surfaceId: 'results', path: '/more', value: [] } });
  });

  it('draw Margin Notes and Tidecount with their badges, and Show all past three parts', () => {
    const margin = rendered(emitSeriesSurface(seriesCard(S['margin-notes'])!)).data;
    expect([margin.badge, margin.lead[0].label, margin.secondary[0].label]).toEqual(['Subscribers', 'Subscribe to listen', 'Their page']);
    const tide = rendered(emitSeriesSurface(seriesCard(S.tidecount)!)).data;
    expect(tide.badge).toBe('Free');
    expect(tide.more).toEqual([{ label: 'Show all episodes' }]);
  });
});

describe('Quote, Reserve and the other funnel cards', () => {
  const plumber = { '@type': 'Plumber', name: 'Hatzel & Sons Plumbing', telephone: '(248) 555-0100', potentialAction: { '@type': 'QuoteAction' } };
  const bistro = { '@type': 'Restaurant', name: 'Copperline', potentialAction: { '@type': 'ReserveAction' } };

  it('keep one button that asks the agent, worded as before', () => {
    expect(cardCtas(plumber)).toEqual({ lead: { kind: 'ask', label: 'Get a quote', message: 'Get a quote from Hatzel & Sons Plumbing' } });
    expect(cardCtas(bistro)).toEqual({ lead: { kind: 'ask', label: 'Reserve', message: 'Reserve at Copperline' } });
    expect(actionCta(plumber)).toEqual({ label: 'Get a quote', message: 'Get a quote from Hatzel & Sons Plumbing' });
    expect(mediaCtas(plumber)).toBeUndefined();
  });

  it('draw the same A2UI surface as before', () => {
    const before = emitCardsSurface('Find plumbers — 2 results', [plumber, bistro].map(toCardData));
    expect(emitResultsSurface('find_plumbers', [plumber, bistro])).toEqual(before);
    const { byId } = rendered(before);
    expect(byId('action_tpl').action.event).toEqual({ name: 'nxis.ask', context: { message: { path: 'message' } } });
  });
});

describe('a tap on Listen or Subscribe', () => {
  const here = `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html`;

  it('moves to the player on this page, goes to another of the site’s pages, or opens another site in a new tab', () => {
    expect(openWay(`${here}#player`, here)).toBe('in-place');
    expect(openWay(`${SITE}/subscribe/lantern-hours.html`, here)).toBe('same-site');
    expect(openWay('https://payments.example/subscribe', here)).toBe('new-tab');
    expect(openWay('https://x.example/', undefined)).toBe('new-tab');
  });

  it('keeps the conversation for the page it lands on, and only then', () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) } as Storage;
    const went: string[] = [];
    const tabs: string[] = [];
    const opts = { here, storage, conversationId: 'c1', navigate: (u: string) => went.push(u), openTab: (u: string) => tabs.push(u) };

    expect(openTarget(`${here}#player`, 'The drawer that sticks', opts)).toBe('in-place');
    expect(saved.size).toBe(0);
    expect(openTarget(`${SITE}/subscribe/lantern-hours.html`, 'Lantern Hours', opts)).toBe('same-site');
    expect(JSON.parse([...saved.values()][0])).toMatchObject({ pageUrl: `${SITE}/subscribe/lantern-hours.html`, label: 'Lantern Hours', conversationId: 'c1' });
    expect(openTarget('https://payments.example/subscribe', 'Lantern Hours', opts)).toBe('new-tab');
    expect(went).toEqual([`${here}#player`, `${SITE}/subscribe/lantern-hours.html`]);
    expect(tabs).toEqual(['https://payments.example/subscribe']);
  });
});
