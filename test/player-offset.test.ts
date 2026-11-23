// @vitest-environment happy-dom
/**
 * A cited clip plays from its start: a remote answer's `media` card with `focus.startOffset` starts the docked player
 * that far into the file, and its links out to YouTube and Vimeo carry the time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';
import { MediaController, type MediaHost } from '../src/media/index';
import { fromOffset, playableOf, type MediaModel } from '../src/harness/playable';
import { citeView } from '../src/ui/remote-answer';
import type { CardRecord, HandoffAnswer } from '../src/handoff/index';
import { installFakeMedia, type FakeMedia } from './helpers/fake-media';

const video: MediaModel = {
  id: 'https://help.example/videos/x200#video',
  kind: 'video',
  access: 'free',
  title: 'Replacing the X200 filter',
  sources: [{ src: 'https://help.example/videos/x200.mp4', type: 'video/mp4' }],
  page: 'https://help.example/videos/x200',
};

let fake: FakeMedia;
beforeEach(() => {
  fake = installFakeMedia();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  fake.restore();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** As a browser that let a `currentTime` set before the metadata go: back at 0, then the metadata arrives. */
const metadata = (el: HTMLMediaElement, ignoredEarlySeek = true) => {
  if (ignoredEarlySeek) el.currentTime = 0;
  Object.defineProperty(el, 'readyState', { value: 1, configurable: true });
  el.dispatchEvent(new Event('loadedmetadata'));
};

describe('fromOffset', () => {
  it('makes a clip an item of its own, starting at its offset', () => {
    expect(fromOffset(video, 134)).toEqual({ ...video, id: `${video.id}#t=134`, start: 134 });
    expect(fromOffset(video, 0)).toBe(video);
    expect(fromOffset(video, undefined)).toBe(video);
    expect(fromOffset(undefined, 134)).toBeUndefined();
  });
});

describe('the docked player', () => {
  const host = (): MediaHost => {
    const shell = document.createElement('div');
    document.body.append(shell);
    const root = shell.attachShadow({ mode: 'open' });
    root.innerHTML = '<main><div class="thread"></div><div class="statusline"></div></main>';
    return { root, before: root.querySelector('.statusline')! };
  };

  it("starts a clip at its offset, and again once the metadata is in, for a browser that didn't the first time", () => {
    const c = new MediaController(host());
    expect(c.play(fromOffset(video, 134)!)).toBe(true);
    expect(c.el.currentTime).toBe(134);
    metadata(c.el);
    expect(c.el.currentTime).toBe(134);
    // Once started, it is the visitor's: a later metadata event (a new source) doesn't move it.
    c.el.currentTime = 200;
    metadata(c.el, false);
    expect(c.el.currentTime).toBe(200);
  });

  it('resumes a paused clip where it was, and plays the whole video from the start', () => {
    const c = new MediaController(host());
    const clip = fromOffset(video, 134)!;
    c.play(clip);
    metadata(c.el);
    c.el.currentTime = 150;
    c.toggle(clip);
    expect(c.el.paused).toBe(true);
    c.toggle(clip);
    expect(c.el.currentTime).toBe(150);
    // The whole video is another item: it starts where the file does.
    c.el.currentTime = 0;
    c.play(video);
    metadata(c.el, false);
    expect(c.el.currentTime).toBe(0);
  });

  it('starts an adopted first tap at the offset too', () => {
    const el = document.createElement('video');
    el.src = video.sources[0].src;
    const c = new MediaController(host(), el);
    c.adopt(fromOffset(video, 75)!, el.play());
    metadata(c.el);
    expect(c.el.currentTime).toBe(75);
  });
});

describe('a remote answer', () => {
  const card: CardRecord = {
    '@id': 'https://help.example/videos/x200#video',
    '@type': 'VideoObject',
    name: 'Replacing the X200 filter',
    url: 'https://help.example/videos/x200',
    contentUrl: 'https://help.example/videos/x200.mp4',
    focus: { path: 'hasPart[1]', label: 'Removing the cover', startOffset: 134 },
  };

  it('Watch plays the file from the clip, in the chat', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('media', 'play');
    // A cited card carries no access marking.
    el.setAttribute('media-play', 'unmarked');
    document.body.append(el);
    const here = new URL(location.href).origin;
    const local = JSON.parse(JSON.stringify(card).replaceAll('https://help.example', here)) as CardRecord;
    const answer: HandoffAnswer = { answerId: 'a-1', cards: [local], cites: [{ claim: 0, id: local['@id'] }] };
    el._appendHandoffItem(el._activeId, { kind: 'remote', from: 'Help', fromKind: 'agent', text: 'At 2:14.', answer });
    // The video's card is drawn with the answer's Sources, a chunk of its own.
    const watch = await vi.waitFor(() => {
      const b = el.shadowRoot.querySelector('.remote .ra-play') as HTMLButtonElement | null;
      if (!b) throw new Error('not drawn yet');
      return b;
    });
    expect(watch.dataset.mediaId).toBe(`${local['@id']}#t=134`);
    watch.click();
    // The first tap plays on the chat's own element, already at the clip.
    expect(el._mediaEl.getAttribute('src')).toBe(`${here}/videos/x200.mp4`);
    expect(el._mediaEl.currentTime).toBe(134);
    await vi.waitFor(() => expect(el._media).toBeTruthy());
    metadata(el._mediaEl);
    expect(el._mediaEl.currentTime).toBe(134);
    expect(watch.getAttribute('aria-pressed')).toBe('true');
  });

  it('a card with no offset plays from the start', () => {
    const { focus: _, ...whole } = card;
    expect(fromOffset(playableOf(whole), whole.focus?.startOffset)?.start).toBeUndefined();
  });
});

describe('links out', () => {
  const clip = (url: string, focusUrl?: string): CardRecord => ({
    '@id': 'https://help.example/videos/x200#video',
    '@type': 'VideoObject',
    name: 'Replacing the X200 filter',
    url,
    focus: { path: 'hasPart[1]', label: 'Removing the cover', startOffset: 134, ...(focusUrl ? { url: focusUrl } : {}) },
  });
  const watch = (c: CardRecord) => {
    const lead = citeView(c, { origins: [] }).ctas?.lead;
    return lead?.kind === 'open' ? lead.url : undefined;
  };

  it("carry the clip's time to YouTube and Vimeo, from the video's link or the clip's own", () => {
    expect(watch(clip('https://www.youtube.com/watch?v=abc123'))).toBe('https://www.youtube.com/watch?v=abc123&t=134s');
    expect(watch(clip('https://youtu.be/abc123'))).toBe('https://youtu.be/abc123?t=134s');
    expect(watch(clip('https://vimeo.com/42'))).toBe('https://vimeo.com/42#t=134s');
    // A clip's own link without its time gets it; one with it keeps it.
    expect(watch(clip('https://www.youtube.com/watch?v=abc123', 'https://www.youtube.com/watch?v=abc123'))).toBe('https://www.youtube.com/watch?v=abc123&t=134s');
    expect(watch(clip('https://vimeo.com/42', 'https://vimeo.com/42#t=134s'))).toBe('https://vimeo.com/42#t=134s');
    expect(watch(clip('https://vimeo.com/42', 'https://player.vimeo.com/video/42'))).toBe('https://player.vimeo.com/video/42#t=134s');
  });
});
