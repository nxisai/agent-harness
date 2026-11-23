/**
 * Media elements that behave enough like a browser's for the player's tests: happy-dom's never fire `play`, and
 * report no type as playable. Installed on the prototype; every `play()` and `load()` is recorded with the files the
 * element had, so a test can say what was (and wasn't) ever requested.
 */
export interface FakeMedia {
  /** Every file an element was asked to play or load, in order. */
  requested: string[];
  plays: number;
  restore(): void;
}

const PLAYABLE = /^(audio\/(mpeg|mp4|ogg|webm)|video\/(mp4|webm))$/;

export function installFakeMedia(opts: { hls?: boolean; playResult?: () => Promise<void> } = {}): FakeMedia {
  const P = HTMLMediaElement.prototype as any;
  const saved = {
    play: P.play, pause: P.pause, load: P.load, canPlayType: P.canPlayType,
    paused: Object.getOwnPropertyDescriptor(P, 'paused'),
  };
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  const fake: FakeMedia = { requested: [], plays: 0, restore() {} };
  const files = (el: HTMLMediaElement): string[] => [el.getAttribute('src') ?? '', ...[...el.querySelectorAll('source')].map((s) => s.getAttribute('src') ?? '')].filter(Boolean);
  Object.defineProperty(P, 'paused', { configurable: true, get(this: HTMLMediaElement) { return paused.get(this) ?? true; } });
  P.canPlayType = (t: string) => (PLAYABLE.test(t) || (opts.hls && /mpegurl/i.test(t)) ? 'maybe' : '');
  P.load = function (this: HTMLMediaElement) { fake.requested.push(...files(this).map((f) => `load:${f}`)); };
  P.play = function (this: HTMLMediaElement) {
    fake.plays++;
    fake.requested.push(...files(this));
    if (paused.get(this) === false) return Promise.resolve();
    paused.set(this, false);
    this.dispatchEvent(new Event('play'));
    queueMicrotask(() => this.dispatchEvent(new Event('playing')));
    return opts.playResult ? opts.playResult() : Promise.resolve();
  };
  P.pause = function (this: HTMLMediaElement) {
    if (paused.get(this) === false) {
      paused.set(this, true);
      this.dispatchEvent(new Event('pause'));
    }
  };
  fake.restore = () => {
    P.play = saved.play; P.pause = saved.pause; P.load = saved.load; P.canPlayType = saved.canPlayType;
    if (saved.paused) Object.defineProperty(P, 'paused', saved.paused);
    else delete P.paused;
  };
  return fake;
}
