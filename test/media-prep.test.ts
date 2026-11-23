/**
 * Story 0 of in-chat media: what kind of media a record is, its picture, records in
 * expanded JSON-LD and references by `@id`, and the page_open report a Listen, Subscribe or "Their page" tap makes.
 */
import { describe, expect, it, vi } from 'vitest';
import F from './fixtures/podcast-records.json';
import { archetype, compact, deref, entityLabel, idIndex, kindOfFormat, kindOfUrl, mediaKind, prop, typesOf } from '../src/harness/entity';
import { pageOpenReport, reportPageOpen, setPageOpenReporter, MEDIA_PLAY_OUTCOME } from '../src/harness/tools/report';
import { RENDERER_SPEC } from '../src/harness/renderer-spec';
import { imageOf } from '../src/harness/playable';

type Obj = Record<string, any>;
const E = F.episodes as Record<string, Obj>;
const SITE = 'https://podcast.example';

/** A Storage in memory, for the session a report waits in. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe('reading records however they are spelled', () => {
  const expandedEpisode = {
    '@id': 'https://x.example/e#episode',
    '@type': ['http://schema.org/PodcastEpisode'],
    'http://schema.org/name': [{ '@value': 'The drawer that sticks' }],
    'http://schema.org/episodeNumber': [{ '@value': 2 }],
    'http://schema.org/audio': [{ '@id': 'https://x.example/e#audio' }],
    'http://schema.org/associatedMedia': [
      {
        '@id': 'https://x.example/e#audio',
        '@type': ['http://schema.org/AudioObject'],
        'http://schema.org/contentUrl': [{ '@value': 'https://x.example/02.mp3' }],
      },
    ],
  };

  it('prop() reads https and http IRIs, schema: prefixes and [{"@value"}] lists', () => {
    expect(prop(expandedEpisode, 'name')).toBe('The drawer that sticks');
    expect(prop(expandedEpisode, 'episodeNumber')).toBe(2);
    expect(prop({ 'schema:name': 'A' }, 'name')).toBe('A');
    expect(prop({ 'https://schema.org/name': 'B' }, 'name')).toBe('B');
    expect(prop({ name: { '@value': 'C' } }, 'name')).toBe('C');
    // A reference stays a reference.
    expect(prop(expandedEpisode, 'audio')).toEqual({ '@id': 'https://x.example/e#audio' });
    expect(typesOf(expandedEpisode)).toEqual(['PodcastEpisode']);
  });

  it('compact() turns an expanded record into the shape the cards read', () => {
    const c = compact(expandedEpisode);
    expect(c['@type']).toEqual(['PodcastEpisode']);
    expect(c.name).toBe('The drawer that sticks');
    expect(c.associatedMedia).toMatchObject({ '@type': ['AudioObject'], contentUrl: 'https://x.example/02.mp3' });
    expect(archetype(c)).toBe('media');
    expect(entityLabel(c)).toBe('The drawer that sticks');
    // A compact record reads the same as before.
    expect(compact(E.free)).toEqual(E.free);
  });

  it('an @id reference resolves to the node the record defines: the podcast episode’s audio', () => {
    const index = idIndex(E.free);
    const audio = deref(E.free.audio, index) as Obj;
    expect(audio['@type']).toBe('AudioObject');
    expect(audio.contentUrl).toBe(`${SITE}/audio/lantern-hours/02.mp3`);
    // In expanded form too.
    expect((deref(prop(expandedEpisode, 'audio'), idIndex(expandedEpisode)) as Obj)['@type']).toEqual(['http://schema.org/AudioObject']);
    // A reference to a node nobody defines stays as it is.
    expect(deref({ '@id': 'urn:none' }, index)).toEqual({ '@id': 'urn:none' });
  });

  it('a @graph is indexed whole: a node references another by @id', () => {
    const graph = { '@graph': [{ '@id': 'urn:v', '@type': 'VideoObject', contentUrl: 'https://x.example/v.mp4' }, { '@id': 'urn:ep', '@type': 'TVEpisode', video: { '@id': 'urn:v' } }] };
    const index = idIndex(graph);
    expect((deref(graph['@graph'][1].video, index) as Obj).contentUrl).toBe('https://x.example/v.mp4');
  });
});

describe('mediaKind()', () => {
  it('from @type', () => {
    expect(mediaKind({ '@type': 'ImageObject' })).toBe('image');
    expect(mediaKind({ '@type': 'VideoObject' })).toBe('video');
    expect(mediaKind({ '@type': 'https://schema.org/Movie' })).toBe('video');
    expect(mediaKind(E.free)).toBe('audio');
    expect(mediaKind({ '@type': 'Plumber', name: 'Hatzel' })).toBeUndefined();
  });

  it('then encodingFormat, then the URL’s extension, then the media it carries', () => {
    expect(mediaKind({ '@type': 'MediaObject', encodingFormat: 'video/mp4' })).toBe('video');
    expect(mediaKind({ '@type': 'MediaObject', encodingFormat: 'application/vnd.apple.mpegurl' })).toBe('video');
    expect(mediaKind({ '@type': 'MediaObject', contentUrl: 'https://x.example/a/cover.JPG?w=2' })).toBe('image');
    expect(mediaKind({ '@type': 'CreativeWork', associatedMedia: { contentUrl: 'https://x.example/a.m4a' } })).toBe('audio');
    expect(mediaKind({ '@type': 'CreativeWork', video: { '@id': 'urn:v' } })).toBe('video');
    expect(kindOfFormat('image/webp')).toBe('image');
    expect(kindOfFormat('text/html')).toBeUndefined();
    expect(kindOfUrl('https://x.example/clip.webm#t=3')).toBe('video');
    expect(kindOfUrl('https://x.example/page')).toBeUndefined();
  });
});

describe('imageOf()', () => {
  it('an image’s own file, else its image or thumbnail; https only', () => {
    expect(imageOf({ '@type': 'ImageObject', contentUrl: 'https://x.example/p.jpg' })).toBe('https://x.example/p.jpg');
    expect(imageOf(E.free)).toBe(`${SITE}/covers/lantern-hours.svg`);
    expect(imageOf({ image: { '@type': 'ImageObject', url: 'https://x.example/i.png' } })).toBe('https://x.example/i.png');
    expect(imageOf({ image: 'http://x.example/i.png' })).toBeUndefined();
    expect(imageOf({ image: 'https://x.example/{id}.png' })).toBeUndefined();
    expect(imageOf({ '@type': 'VideoObject', name: 'v' })).toBeUndefined();
  });
});

describe('page_open reports', () => {
  it('carry the action’s type, @id and the site’s token, as the NxisAI app’s do', () => {
    expect(MEDIA_PLAY_OUTCOME).toBe('page_open');
    expect(pageOpenReport({ actionType: 'ListenAction', actionId: `${SITE}/e#listen`, reportToken: 'tok.listen' })).toEqual({
      outcome: 'page_open', action_type: 'ListenAction', action_id: `${SITE}/e#listen`, report_token: 'tok.listen', source: 'on_page_agent',
    });
    // "Their page" comes from no action: the outcome alone.
    expect(pageOpenReport({})).toEqual({ outcome: 'page_open', source: 'on_page_agent' });
    // A token goes only with the action it was signed for; a type must be an action's.
    expect(pageOpenReport({ reportToken: 'tok', actionType: 'drop table' })).toEqual({ outcome: 'page_open', source: 'on_page_agent' });
  });

  it('wait for the site’s server, and a tap that leaves the page is sent from the next one', () => {
    const storage = memoryStorage();
    setPageOpenReporter(null);
    reportPageOpen({ actionType: 'SubscribeAction', actionId: 'urn:s' }, { storage });
    reportPageOpen({ actionType: 'ListenAction', actionId: 'urn:l', reportToken: 't' }, { leaving: true, storage });
    expect(JSON.parse(storage.getItem('nxis:page-opens')!)).toHaveLength(1);
    const sent = vi.fn();
    setPageOpenReporter(sent, storage);
    expect(sent.mock.calls.map((c) => c[0].action_type)).toEqual(['ListenAction', 'SubscribeAction']);
    expect(storage.getItem('nxis:page-opens')).toBeNull();
    reportPageOpen({ actionType: 'ListenAction' }, { storage });
    expect(sent).toHaveBeenCalledTimes(3);
    setPageOpenReporter(null);
  });
});

describe('the renderer spec', () => {
  it('words Watch as Listen is worded, and lists no embed hosts yet', () => {
    expect(RENDERER_SPEC.actions.WatchAction).toMatchObject({
      label: 'Watch', latestLabel: 'Watch the latest', previewLabel: 'Watch preview', paidLabel: 'Subscribe to watch', registrationLabel: 'Sign up to watch',
    });
    expect(RENDERER_SPEC.media.embedHosts).toEqual([]);
  });
});
