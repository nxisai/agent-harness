/**
 * In-chat playback: the docked player for `<nxis-agent media="play">`.
 *
 * `@nxisai/agent-harness/media`. The chat never imports this statically: it loads it with a dynamic `import()` on
 * the first Play tap (or as a Play button is pointed at or focused), so a page that never plays anything never
 * downloads it. No HLS library is bundled: an HLS stream plays only where the browser plays it natively, and
 * opens its page elsewhere.
 *
 * @module
 */
export { MediaController, STALL_MS } from './controller.js';
export type { MediaHost, MediaState, MediaEventType } from './controller.js';
export { renderDock, clockOf } from './dock.js';
export type { DockEls } from './dock.js';
export { MEDIA_DOCK_CSS } from './styles.js';
export { loadSources, addTracks, blockHost } from './sources.js';
