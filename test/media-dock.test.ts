// @vitest-environment happy-dom
/**
 * The docked player: its states, one item at a time, falling back when it can't
 * play, surviving the conversation's redraws, and letting go when it is done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaController, STALL_MS, type MediaHost } from '../src/media/index';
import { blockedHosts, type MediaModel } from '../src/harness/playable';
import { installFakeMedia, type FakeMedia } from './helpers/fake-media';

const audio: MediaModel = {
  id: 'urn:ep2', kind: 'audio', access: 'free', title: 'The drawer that sticks', show: 'Lantern Hours', seconds: 10,
  sources: [{ src: 'https://podcast.example/audio/lantern-hours/02.mp3', type: 'audio/mpeg' }],
  poster: 'https://podcast.example/covers/lantern-hours.svg', transcript: 'Before you sand anything, find where it rubs.',
  page: 'https://podcast.example/shows/lantern-hours/02-the-drawer-that-sticks.html',
};
const video: MediaModel = {
  id: 'urn:tide', kind: 'video', access: 'free', title: 'The tide comes in', aspect: '1280 / 720',
  sources: [{ src: 'https://media.example/videos/tide.mp4', type: 'video/mp4' }],
  poster: 'https://media.example/videos/tide-poster.jpg', captions: [{ src: 'https://media.example/videos/tide.en.vtt', lang: 'en', label: 'English' }],
  page: 'https://media.example/videos/tide.html',
};

let fake: FakeMedia;
let shell: HTMLElement;
let root: ShadowRoot;
let host: MediaHost & { states: { id: string | null; playing: boolean }[]; blocked: string[]; first: string[] };

beforeEach(() => {
  fake = installFakeMedia();
  sessionStorage.clear();
  shell = document.createElement('div');
  document.body.append(shell);
  root = shell.attachShadow({ mode: 'open' });
  root.innerHTML = '<button class="launcher">L</button><main><div class="thread"><p>hello</p></div><div class="statusline"></div><div class="composer"></div></main>';
  const states: { id: string | null; playing: boolean }[] = [];
  const blocked: string[] = [];
  const first: string[] = [];
  host = {
    root, before: root.querySelector('.statusline')!, launcher: root.querySelector<HTMLElement>('.launcher')!, events: shell,
    onState: (s) => states.push({ id: s.id, playing: s.playing }),
    onBlocked: (m, why) => blocked.push(`${m.id}:${why}`),
    onFirstPlay: (m) => first.push(m.id),
    states, blocked, first,
  };
});
afterEach(() => {
  fake.restore();
  shell.remove();
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the dock', () => {
  it('is a "Now playing" region between the conversation and the status line, hidden while idle', () => {
    const c = new MediaController(host);
    const dock = root.querySelector('section.md-dock')!;
    expect(dock.getAttribute('role')).toBe('region');
    expect(dock.getAttribute('aria-label')).toBe('Now playing');
    expect(dock.hasAttribute('hidden')).toBe(true);
    expect(dock.previousElementSibling!.className).toBe('thread');
    expect(dock.nextElementSibling!.className).toBe('statusline');
    expect(root.querySelectorAll('style[data-md]')).toHaveLength(1);
    // The element waits, fetching nothing.
    expect(c.el.preload).toBe('none');
    expect(fake.requested).toEqual([]);
  });

  it('plays audio: art, title and show, pressed pause, a scrubber that says where it is, speed, transcript, page', async () => {
    const c = new MediaController(host);
    expect(c.play(audio)).toBe(true);
    await flush();
    const d = c.dock;
    expect(d.root.hidden).toBe(false);
    expect(d.frame.hidden).toBe(true);
    expect([d.title.textContent, d.show.textContent]).toEqual(['The drawer that sticks', 'Lantern Hours']);
    expect(d.art.getAttribute('src')).toBe(audio.poster);
    expect(d.pp.getAttribute('aria-pressed')).toBe('true');
    expect(d.pp.getAttribute('aria-label')).toBe('Pause');
    expect(d.seek.getAttribute('aria-valuetext')).toBe('0:00 of 0:10');
    expect(d.page.getAttribute('href')).toBe(audio.page);
    expect(d.page.getAttribute('aria-label')).toBe('Episode page');
    expect(fake.requested).toContain(audio.sources[0].src);
    // Speed: 1×, 1.25×, 1.5×, 2×, around again.
    const rates = [1.25, 1.5, 2, 1].map(() => {
      d.rate.click();
      return d.rate.textContent;
    });
    expect(rates).toEqual(['1.25×', '1.5×', '2×', '1×']);
    // Transcript, as a disclosure.
    expect(d.txBody.hidden).toBe(true);
    d.tx.click();
    expect([d.txBody.hidden, d.tx.getAttribute('aria-expanded'), d.txBody.textContent]).toEqual([false, 'true', audio.transcript]);
    // Reported once per item per page load.
    expect(host.first).toEqual(['urn:ep2']);
    c.toggle(audio);
    c.toggle(audio);
    await flush();
    expect(host.first).toEqual(['urn:ep2']);
  });

  it('plays video in a frame above the bar: poster, playsinline, captions, its proportions', () => {
    const c = new MediaController(host);
    c.play(video);
    expect(c.dock.frame.hidden).toBe(false);
    expect(c.el.getAttribute('poster')).toBe(video.poster);
    expect(c.el.hasAttribute('playsinline')).toBe(true);
    const track = c.el.querySelector('track')!;
    expect([track.getAttribute('kind'), track.getAttribute('src'), track.getAttribute('srclang'), track.hasAttribute('default')]).toEqual(['captions', video.captions![0].src, 'en', true]);
    expect(c.dock.frame.style.getPropertyValue('--md-aspect')).toBe('1280 / 720');
    expect(c.dock.page.getAttribute('aria-label')).toBe('Video page');
  });

  it('adopts the item the first tap already started, adding a video’s captions without a reload', () => {
    const el = document.createElement('video');
    el.src = video.sources[0].src;
    const started = el.play();
    const c = new MediaController(host, el);
    c.adopt(video, started);
    expect(c.el).toBe(el);
    expect(el.querySelector('track')).not.toBeNull();
    expect(fake.requested.filter((r) => r.startsWith('load:'))).toEqual([]);
    expect(c.dock.pp.getAttribute('aria-pressed')).toBe('true');
  });

  it('a tap on the playing item pauses it; on another, plays that one instead, and nothing advances', () => {
    const c = new MediaController(host);
    c.play(audio);
    c.toggle(audio);
    expect(c.el.paused).toBe(true);
    c.toggle(audio);
    expect(c.el.paused).toBe(false);
    c.toggle(video);
    expect(c.current!.id).toBe('urn:tide');
    c.el.dispatchEvent(new Event('ended'));
    expect(c.current!.id).toBe('urn:tide');
    expect(host.states.at(-1)).toEqual({ id: 'urn:tide', playing: true });
  });

  it('false, and nothing loaded, when the browser can play none of its files (HLS where it isn’t native)', () => {
    const c = new MediaController(host);
    const hls: MediaModel = { ...video, id: 'urn:hls', sources: [{ src: 'https://media.example/v.m3u8', type: 'application/vnd.apple.mpegurl' }] };
    expect(c.play(hls)).toBe(false);
    expect(c.dock.root.hidden).toBe(true);
    expect(fake.plays).toBe(0);
  });
});

describe('one at a time', () => {
  it('ours starting pauses the page’s own player; the page’s starting pauses ours', () => {
    const page = document.createElement('audio');
    page.id = 'player';
    document.body.append(page);
    void page.play();
    const c = new MediaController(host);
    c.play(audio);
    expect(page.paused).toBe(true);
    void page.play();
    expect(c.el.paused).toBe(true);
    page.remove();
  });
});

describe('when it can’t play here', () => {
  it('a Content-Security-Policy violation blocks the host for the session and says so, with the page', () => {
    const c = new MediaController(host);
    c.play(audio);
    const v = new Event('securitypolicyviolation') as any;
    Object.assign(v, { effectiveDirective: 'media-src', blockedURI: audio.sources[0].src });
    document.dispatchEvent(v);
    expect(host.blocked).toEqual(['urn:ep2:csp']);
    expect(blockedHosts()).toEqual(['podcast.example']);
    expect(c.dock.status.textContent).toBe("Can't play here. Open the episode page");
    expect(c.dock.status.querySelector('a')!.getAttribute('href')).toBe(audio.page);
    expect(c.dock.status.getAttribute('aria-live')).toBe('polite');
    expect(c.el.paused).toBe(true);
  });

  it('an error from its last source', () => {
    const c = new MediaController(host);
    c.play(audio);
    c.el.querySelector('source')!.dispatchEvent(new Event('error'));
    expect(host.blocked).toEqual(['urn:ep2:error']);
  });

  it('no first frame 15 s after Play', () => {
    vi.useFakeTimers();
    fake.restore();
    fake = installFakeMedia();
    const c = new MediaController(host);
    // Never reaches 'playing'.
    c.el.addEventListener('playing', (e) => e.stopImmediatePropagation(), { capture: true });
    const P = HTMLMediaElement.prototype as any;
    const play = P.play;
    P.play = function (this: HTMLMediaElement) { const r = play.call(this); return r; };
    c.play(audio);
    vi.advanceTimersByTime(STALL_MS - 1);
    expect(host.blocked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(host.blocked).toEqual(['urn:ep2:stall']);
  });

  it('a browser that wants a tap is not the host’s fault', async () => {
    fake.restore();
    fake = installFakeMedia({ playResult: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) });
    const c = new MediaController(host);
    c.play(audio);
    await flush();
    expect(host.blocked).toEqual([]);
  });
});

describe('around the conversation', () => {
  it('a redraw of the thread leaves the dock and its playback alone', () => {
    const c = new MediaController(host);
    c.play(audio);
    const thread = root.querySelector('.thread')!;
    thread.innerHTML = '';
    thread.innerHTML = '<p>another conversation</p>';
    expect(c.dock.root.isConnected).toBe(true);
    expect(c.el.isConnected).toBe(true);
    expect(c.el.paused).toBe(false);
  });

  it('the panel closed: audio goes on, with a button beside the launcher; video pauses', () => {
    const c = new MediaController(host);
    host.launcher!.getClientRects = () => [{ top: 0, left: 0, width: 56, height: 56 }] as unknown as DOMRectList;
    c.play(audio);
    c.panel(false);
    expect(c.el.paused).toBe(false);
    const mini = root.querySelector<HTMLButtonElement>('.md-mini')!;
    expect(mini.getAttribute('aria-label')).toBe('Pause The drawer that sticks');
    mini.click();
    expect(c.el.paused).toBe(true);
    c.panel(true);
    expect(root.querySelector('.md-mini')).toBeNull();
    c.play(video);
    c.panel(false);
    expect(c.el.paused).toBe(true);
  });

  it('nxis-media events for the site’s own analytics', () => {
    const seen: string[] = [];
    shell.addEventListener('nxis-media', (e) => seen.push((e as CustomEvent).detail.type));
    const c = new MediaController(host);
    c.play(audio);
    c.pause();
    c.el.dispatchEvent(new Event('ended'));
    expect(seen).toEqual(['play', 'pause', 'ended']);
  });

  it('close stops and lets the file go; dispose takes the dock away', () => {
    const c = new MediaController(host);
    c.play(audio);
    c.dock.close.click();
    expect([c.el.paused, c.el.querySelectorAll('source').length, c.dock.root.hidden, c.current]).toEqual([true, 0, true, null]);
    expect(host.states.at(-1)).toEqual({ id: null, playing: false });
    c.play(audio);
    c.dispose();
    expect(c.dock.root.isConnected).toBe(false);
    expect(c.el.paused).toBe(true);
  });
});

describe('keyboard', () => {
  it('Space or K plays and pauses, ←/→ 5 s, J/L 10 s', () => {
    const c = new MediaController(host);
    c.play(audio);
    Object.defineProperty(c.el, 'duration', { value: 100, configurable: true });
    const key = (k: string, target: Element = c.dock.title) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('k');
    expect(c.el.paused).toBe(true);
    key(' ');
    expect(c.el.paused).toBe(false);
    key('ArrowRight');
    key('l');
    expect(c.el.currentTime).toBe(15);
    key('ArrowLeft');
    key('j');
    expect(c.el.currentTime).toBe(0);
    // Space on a button is the button's own.
    const before = c.el.paused;
    key(' ', c.dock.rate);
    expect(c.el.paused).toBe(before);
  });

  it('every control is native and labelled', () => {
    const c = new MediaController(host);
    c.play(audio);
    const d = c.dock;
    for (const b of [d.pp, d.rate, d.tx, d.close]) expect(b.tagName).toBe('BUTTON');
    expect(d.seek.type).toBe('range');
    expect(d.seek.getAttribute('aria-label')).toBe('Position');
    expect(d.close.getAttribute('aria-label')).toBe('Close the player');
  });
});
