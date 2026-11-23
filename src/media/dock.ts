/**
 * The "Now playing" bar: a region between the conversation and the composer, hidden while nothing plays.
 *
 * Native controls only: buttons, a range input for the position (its `aria-valuetext` says "0:03 of 0:10"), a
 * link to the item's page. A video's frame sits above the bar. Every string is set as text.
 *
 * @module
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A 24px glyph, filled, or drawn as a line. */
function glyph(d: string, cls = '', line = false): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', line ? 'none' : 'currentColor');
  if (line) for (const [k, v] of [['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) svg.setAttribute(k, v);
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

export const PLAY_D = 'M7 4v16l13-8z';
export const PAUSE_D = 'M6 4h4v16H6zM14 4h4v16h-4z';
const TEXT_D = 'M4 6h16M4 12h16M4 18h10';
const OPEN_D = 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5';
const CLOSE_D = 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

/** The dock's parts, for the controller to fill and listen to. */
export interface DockEls {
  root: HTMLElement;
  frame: HTMLElement;
  art: HTMLImageElement;
  title: HTMLElement;
  show: HTMLElement;
  pp: HTMLButtonElement;
  seek: HTMLInputElement;
  time: HTMLElement;
  rate: HTMLButtonElement;
  tx: HTMLButtonElement;
  txBody: HTMLElement;
  page: HTMLAnchorElement;
  close: HTMLButtonElement;
  status: HTMLElement;
}

let seq = 0;

/** Build the dock, hidden. The controller places it and moves the media element into its frame. */
export function renderDock(): DockEls {
  const id = `md-tx-${++seq}`;
  const art = el('img', { class: 'md-art', alt: '', decoding: 'async', referrerpolicy: 'strict-origin-when-cross-origin' });
  const title = el('strong');
  const show = el('span');
  const pp = el('button', { type: 'button', class: 'md-btn md-pp', 'aria-pressed': 'false', 'aria-label': 'Play' }, glyph(PLAY_D, 'md-i-play'), glyph(PAUSE_D, 'md-i-pause'));
  const seek = el('input', { type: 'range', class: 'md-seek', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Position' });
  const time = el('span', { class: 'md-time', 'aria-hidden': 'true' }, '0:00');
  const rate = el('button', { type: 'button', class: 'md-btn md-rate', 'aria-label': 'Playback speed: 1×' }, '1×');
  const tx = el('button', { type: 'button', class: 'md-btn md-tx', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': 'Transcript', title: 'Transcript' }, glyph(TEXT_D, '', true));
  const txBody = el('p', { class: 'md-tx-body', id, hidden: '' });
  const page = el('a', { class: 'md-btn md-page', 'aria-label': 'Episode page', title: 'Episode page' }, glyph(OPEN_D, '', true));
  const close = el('button', { type: 'button', class: 'md-btn md-close', 'aria-label': 'Close the player' }, glyph(CLOSE_D));
  const status = el('p', { class: 'md-status', role: 'status', 'aria-live': 'polite' });
  const frame = el('div', { class: 'md-frame', hidden: '' });
  const root = el(
    'section',
    { class: 'md-dock', role: 'region', 'aria-label': 'Now playing', hidden: '' },
    frame,
    el('div', { class: 'md-bar' }, art, el('div', { class: 'md-who' }, title, show), pp, el('div', { class: 'md-track' }, seek, time, rate), tx, page, close),
    txBody,
    status,
  );
  return { root, frame, art, title, show, pp, seek, time, rate, tx, txBody, page, close, status };
}

/** Seconds as a clock: 3 → "0:03", 3725 → "1:02:05". */
export function clockOf(s: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(s) ? s : 0));
  const pad = (n: number) => String(n).padStart(2, '0');
  return t >= 3600 ? `${Math.floor(t / 3600)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}` : `${Math.floor(t / 60)}:${pad(t % 60)}`;
}

export { glyph };
