/**
 * What can play in the chat, and the gate, on the podcast example's own records and
 * on synthetic shapes: free plays, a free preview plays only its preview, paid and sign-up media never plays, and a
 * record that says nothing plays only when the site opts in.
 */
import { describe, expect, it } from 'vitest';
import F from './fixtures/podcast-records.json';
import M from './fixtures/media-shapes.json';
import { access, accessAction, compact, idIndex } from '../src/harness/entity';
import { BLOCKED_KEY, blockedHosts, mayPlay, mediaOf, playableOf, type MediaModel } from '../src/harness/playable';
import { cardCtas, playButtonFor, playCtas, playLatestCtas, seriesCtas } from '../src/harness/cta';
import { emitMediaSurface, emitSeriesSurface, pressMessages } from '../src/a2ui/cards';
import { mediaRow, seriesCard } from '../src/harness/media';

type Obj = Record<string, any>;
const E = F.episodes as Record<string, Obj>;
const S = F.series as Record<string, Obj>;
const R = M as unknown as Record<string, Obj>;
const SITE = 'https://podcast.example';
const HERE = `${SITE}/`;

const play = (r: Obj, opts: Obj = {}) => playableOf(r, { recordAccess: access(r, accessAction(r))?.state, here: HERE, ...opts });

/** A Storage in memory. */
function memory(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)) };
}

describe('the podcast example', () => {
  it('a free episode plays its own file, resolved through its @id reference', () => {
    const m = play(E.free)!;
    expect(m).toMatchObject({
      kind: 'audio',
      access: 'free',
      sources: [{ src: `${SITE}/audio/lantern-hours/02.mp3`, type: 'audio/mpeg' }],
      title: 'The drawer that sticks',
      show: 'Lantern Hours',
      seconds: 10,
      page: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html`,
      poster: `${SITE}/covers/lantern-hours.svg`,
    });
    expect(m.transcript).toMatch(/^Lantern Hours, episode two/);
    expect(m.embed).toBe(`${SITE}/embed/lantern-hours/02.html`);
    expect(mayPlay(m, { storage: memory() })).toBe(true);
  });

  it('a free preview plays only 04-preview.mp3, never the full episode', () => {
    const m = play(E.preview)!;
    expect(m.sources.map((s) => s.src)).toEqual([`${SITE}/audio/lantern-hours/04-preview.mp3`]);
    expect(m.access).toBe('free');
    expect(JSON.stringify(m)).not.toMatch(/04\.mp3/);
  });

  it('paid and sign-up episodes are locked, though their files are public, and never pass the gate', () => {
    for (const r of [E.paid, E.signup]) {
      const m = play(r)!;
      expect(m.access).toBe('locked');
      expect(mayPlay(m, { unmarked: true, storage: memory() })).toBe(false);
    }
    expect(play(E.paid)!.sources[0].src).toBe(`${SITE}/audio/lantern-hours/05.mp3`);
  });

  it('a series’ parts carry no media; its "Listen to the latest" waits for its episode', () => {
    expect(play(S['lantern-hours'].hasPart[0])).toBeUndefined();
    const ctas = seriesCtas(S['lantern-hours'])!;
    const pending = playLatestCtas(ctas, `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#episode`);
    expect(pending.lead).toMatchObject({ kind: 'play', label: 'Listen to the latest', mediaId: `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#episode` });
    expect(pending.lead).not.toHaveProperty('media');
    expect((pending.lead as Obj).fallback).toEqual(ctas.lead);
    expect(pending.secondary).toEqual(ctas.secondary);
  });

  it('every one of its episodes: free and preview play, the rest are locked', () => {
    const parts = (S['lantern-hours'].hasPart as Obj[]).map((p) => ({ ...p, associatedMedia: { '@type': 'AudioObject', contentUrl: `${SITE}/audio/x/${p.episodeNumber}.mp3` } }));
    const states = parts.map((p) => play(p)?.access);
    const free = parts.filter((p) => p.isAccessibleForFree === true).length;
    expect(states.filter((s) => s === 'free')).toHaveLength(free);
    expect(states.every((s) => s === 'free' || s === 'locked')).toBe(true);
  });
});

describe('the gate', () => {
  it('a record that says nothing about access plays only with media-play="unmarked"', () => {
    const m = play(R.unmarked)!;
    expect(m.access).toBe('unknown');
    expect(mayPlay(m, { storage: memory() })).toBe(false);
    expect(mayPlay(m, { unmarked: true, storage: memory() })).toBe(true);
  });

  it('an expired item never plays, even when its card was saved before it expired', () => {
    expect(play(R.expired)!.access).toBe('locked');
    const saved: MediaModel = { id: 'x', kind: 'audio', sources: [{ src: 'https://media.example/a.mp3' }], access: 'free', title: 'x', expires: '2026-01-01' };
    expect(mayPlay(saved, { now: Date.parse('2025-12-31'), storage: memory() })).toBe(true);
    expect(mayPlay(saved, { now: Date.parse('2026-02-01'), storage: memory() })).toBe(false);
  });

  it('a host blocked this session no longer plays', () => {
    const storage = memory();
    const m = play(E.free)!;
    storage.setItem(BLOCKED_KEY, JSON.stringify(['podcast.example']));
    expect(blockedHosts(storage)).toEqual(['podcast.example']);
    expect(mayPlay(m, { storage })).toBe(false);
  });

  it('a paid film’s free trailer plays; an unmarked trailer of a paid film doesn’t', () => {
    expect(play(R.trailer)).toMatchObject({ kind: 'video', access: 'free', sources: [{ src: 'https://media.example/films/estuary-trailer.mp4' }] });
    const unmarked = { ...R.trailer, trailer: { ...R.trailer.trailer, isAccessibleForFree: undefined } };
    expect(play(unmarked)!.access).toBe('locked');
  });
});

describe('shapes', () => {
  it('a free video: poster, WebVTT captions, its frame’s proportions', () => {
    expect(play(R.freeVideo)).toMatchObject({
      kind: 'video',
      access: 'free',
      sources: [{ src: 'https://media.example/videos/tide.mp4', type: 'video/mp4' }],
      poster: 'https://media.example/videos/tide-poster.jpg',
      captions: [{ src: 'https://media.example/videos/tide.en.vtt', lang: 'en', label: 'en' }],
      aspect: '1280 / 720',
      seconds: 30,
    });
  });

  it('encodings become sources: HLS kept for browsers that play it natively, DASH dropped', () => {
    expect(play(R.encodings)!.sources).toEqual([
      { src: 'https://media.example/videos/two.webm', type: 'video/webm' },
      { src: 'https://media.example/videos/two.mp4', type: 'video/mp4' },
      { src: 'https://media.example/videos/two.m3u8', type: 'application/vnd.apple.mpegurl' },
    ]);
  });

  it('a @graph: the episode’s audio is another node', () => {
    const [audio, episode] = R.graphEpisode['@graph'];
    expect(playableOf(episode, { recordAccess: 'free', index: idIndex(R.graphEpisode), here: HERE })).toMatchObject({ id: audio['@id'], sources: [{ src: 'https://media.example/ep/7.mp3' }] });
  });

  it('expanded JSON-LD', () => {
    const expanded = {
      '@type': ['http://schema.org/AudioObject'],
      'http://schema.org/name': [{ '@value': 'Expanded' }],
      'http://schema.org/contentUrl': [{ '@value': 'https://media.example/e.mp3' }],
      'http://schema.org/isAccessibleForFree': [{ '@value': true }],
    };
    expect(playableOf(expanded, { here: HERE })).toMatchObject({ title: 'Expanded', access: 'free', sources: [{ src: 'https://media.example/e.mp3' }] });
    expect(playableOf(compact(expanded), { here: HERE })).toMatchObject({ title: 'Expanded', access: 'free' });
  });

  it('hostile files never become sources; an embed alone plays nothing here', () => {
    for (const u of M.hostile) expect(playableOf({ '@type': 'AudioObject', contentUrl: u, isAccessibleForFree: true }, { here: HERE }), u).toBeUndefined();
    expect(playableOf(R.embedOnly, { here: HERE })).toBeUndefined();
  });

  it('mediaOf() gives pictures and what plays together', () => {
    const m = mediaOf(R.freeVideo, { recordAccess: 'free', here: HERE });
    expect(m.images[0].url).toBe('https://media.example/videos/tide-poster.jpg');
    expect(m.play?.kind).toBe('video');
  });
});

describe('play buttons', () => {
  it('Listen becomes a play button that reports its action and keeps its page as the fallback', () => {
    const ctas = cardCtas(E.free)!;
    const p = playCtas(ctas, play(E.free)!);
    expect(p.lead).toMatchObject({ kind: 'play', label: 'Listen', mediaId: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#audio`, fallback: ctas.lead });
    expect((p.lead as Obj).media).toMatchObject({ actionType: 'ListenAction', actionId: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#listen`, reportToken: 'tok.listen' });
    expect(p.secondary).toEqual(ctas.secondary);
    expect(playButtonFor([p], (p.lead as Obj).mediaId)).toBe(p.lead);
  });

  it('"Listen to preview" keeps its words', () => {
    expect(playCtas(cardCtas(E.preview), play(E.preview)!).lead).toMatchObject({ kind: 'play', label: 'Listen to preview' });
  });

  it('a video with no Listen leads with Watch, its page as the fallback', () => {
    const p = playCtas(cardCtas(R.freeVideo), play(R.freeVideo)!);
    expect(p.lead).toMatchObject({ kind: 'play', label: 'Watch', fallback: { url: 'https://media.example/videos/tide.html' } });
  });
});

describe('the A2UI view with in-chat playback', () => {
  const canPlay = () => true;

  it('without it, the surface is exactly what it was', () => {
    const rows = [E.free, E.paid].map(mediaRow);
    expect(emitMediaSurface('h', rows)).toEqual(emitMediaSurface('h', rows, 'results', undefined));
    expect(JSON.stringify(emitMediaSurface('h', rows))).not.toMatch(/nxis\.play|mediaId/);
  });

  it('with it, a play button sends nxis.play with its item; Subscribe to listen still opens', () => {
    const free = mediaRow(E.free);
    const rows = [{ ...free, ctas: playCtas(free.ctas, play(E.free)!) }, mediaRow(E.paid)];
    const [m] = emitMediaSurface('h', rows, 'results', canPlay);
    const comps = m.createSurface!.components as Obj[];
    expect(comps.find((c) => c.id === 'ep_btn')!.action.event.name).toBe('nxis.play');
    const data = m.createSurface!.dataModel as Obj;
    const leads = data.groups[0].rows.map((r: Obj) => r.lead[0]);
    expect(leads[0]).toMatchObject({ label: '▶ Listen', mediaId: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#audio`, url: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#player` });
    expect(leads[1]).toMatchObject({ label: 'Subscribe to listen', mediaId: '' });
    expect(JSON.stringify(data)).not.toMatch(/05\.mp3/);

    // Pressed: the playing item reads "❚❚ Pause", and back.
    const read = (k: string) => data[k];
    const on = pressMessages('results', read, leads[0].mediaId, true);
    expect(on).toEqual([{ version: 'v1.0', updateDataModel: { surfaceId: 'results', path: '/groups/0/rows/0/lead/0/label', value: '❚❚ Pause' } },
      { version: 'v1.0', updateDataModel: { surfaceId: 'results', path: '/all/groups/0/rows/0/lead/0/label', value: '❚❚ Pause' } }]);
    expect(pressMessages('results', read, leads[0].mediaId, false)).toEqual([]);
  });

  it('a play button that may not play is its page', () => {
    const free = mediaRow(E.free);
    const [m] = emitMediaSurface('h', [{ ...free, ctas: playCtas(free.ctas, play(E.free)!) }], 'results', () => false);
    expect((m.createSurface!.dataModel as Obj).groups[0].rows[0].lead[0]).toMatchObject({ label: '▶ Listen', mediaId: '', url: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#player` });
  });

  it('a series: "Listen to the latest" carries its episode', () => {
    const card = seriesCard(S['lantern-hours'])!;
    const s = { ...card, ctas: playLatestCtas(card.ctas!, 'urn:latest') };
    const data = emitSeriesSurface(s, 'results', canPlay)[0].createSurface!.dataModel as Obj;
    expect(data.lead).toEqual([{ label: '▶ Listen to the latest', rest: '▶ Listen to the latest', mediaId: 'urn:latest', url: `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#player`, name: 'Glue, and when not to use it', actionType: 'ListenAction', actionId: `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#listen` }]);
  });
});
