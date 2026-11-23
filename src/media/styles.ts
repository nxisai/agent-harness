/**
 * The docked player's styles, on the widget's own tokens (`--surface`, `--ink`, `--blue`, …), injected into the
 * element's shadow root when the player first loads. Every control is at least 40px square.
 *
 * @module
 */
export const MEDIA_DOCK_CSS = `
.md-dock { container-type: inline-size; border-top: 1px solid var(--border); background: var(--surface); color: var(--ink); font: 13px/1.4 var(--sans); }
.md-dock[hidden], .md-dock [hidden] { display: none !important; }
.md-frame { background: #000; display: flex; justify-content: center; }
.md-frame video { display: block; width: 100%; max-height: 40vh; aspect-ratio: var(--md-aspect, 16 / 9); object-fit: contain; background: #000; }
.md-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 6px 12px; }
.md-art { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex: none; background: var(--border); }
.md-who { display: flex; flex-direction: column; min-width: 0; flex: 1 1 120px; }
.md-who strong { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.md-who span { font-size: 12px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.md-btn { min-width: 40px; min-height: 40px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--radius-sm, 10px); background: none; color: var(--ink); font: 600 12.5px var(--sans); display: inline-grid; place-items: center; cursor: pointer; text-decoration: none; flex: none; }
.md-btn:hover { background: var(--bg); border-color: var(--border); }
.md-btn:focus-visible, .md-seek:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.md-btn svg { width: 18px; height: 18px; }
.md-pp { background: var(--blue); color: #fff; border-radius: 50%; }
.md-pp:hover { background: var(--blue-strong); border-color: transparent; }
.md-pp[aria-pressed="true"] .md-i-play, .md-pp:not([aria-pressed="true"]) .md-i-pause { display: none; }
.md-track { display: flex; align-items: center; gap: 8px; flex: 1 1 160px; min-width: 0; }
.md-seek { flex: 1; min-width: 60px; min-height: 40px; margin: 0; accent-color: var(--blue); background: transparent; }
.md-time { font-family: var(--mono); font-size: 11px; color: var(--ink-2); white-space: nowrap; }
.md-tx-body { margin: 0; padding: 0 12px 10px; max-height: 30vh; overflow: auto; color: var(--ink-2); white-space: pre-wrap; }
.md-status { margin: 0; padding: 0 12px 8px; color: var(--ink-2); }
.md-status:empty { display: none; }
.md-status.err { color: var(--red, #b91c1c); }
.md-status a { color: var(--blue-strong); font-weight: 600; }
/* Narrow (the window view, a phone): two lines, the scrubber, time and speed under the title and buttons. */
@container (max-width: 560px) {
  .md-track { order: 9; flex-basis: 100%; }
  .md-who { flex-basis: 0; }
}
.md-mini { position: fixed; z-index: 2147483000; width: 40px; height: 40px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; display: grid; place-items: center; color: #fff;
  background: radial-gradient(closest-side, var(--blue) 82%, transparent 84%), conic-gradient(#fff var(--md-p, 0%), rgba(255,255,255,.35) 0); box-shadow: 0 4px 14px rgba(15,23,42,.25); }
.md-mini svg { width: 16px; height: 16px; }
.md-mini:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { .md-dock *, .md-mini { transition: none !important; animation: none !important; } }
`;
