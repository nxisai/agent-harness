/**
 * A2UI surface emitters.
 *
 * Turn a tool's schema, a clarification plan, or typed-retrieval results into
 * A2UI messages, for rendering through an A2UI renderer rather than the
 * packaged element.
 *
 * Messages are authored against the v1.0 spec and downgraded by {@link toV09}
 * before rendering, since published renderers support v0.9 and earlier.
 *
 * @module
 */
export { emitActionSurface, emitPrefill } from './emit.js';
export type { A2uiMessage } from './emit.js';
export { emitToolForm } from './form.js';
export { emitAsk, emitStep, emitConfirm } from './stepper.js';
export { emitCardsSurface, emitAppendResult, toCardData, emitMediaSurface, emitSeriesSurface, emitFigureSurface, showAllMessages, pressMessages } from './cards.js';
export { emitResultsSurface } from './results.js';
export { emitEventsSurface, emitEventSurface, type EventButtonData } from './events.js';
export type { ResultCardData, CardRow, CardTag, MediaButtonData, MediaRowData, MediaGroupData, CanPlay } from './cards.js';
export { mountSurface } from './host.js';
export { STEPS_CATALOG, STEP_COMPONENTS, BASIC_ALLOWED, PAGE_EVENTS, LIMITS as SURFACE_LIMITS, readSurfaceMessages, surfaceIdOf, fold as foldSurface } from './steps.js';
export type { SurfaceAction, SurfaceEntry, ConfirmRow } from './steps.js';
export type { MountedSurface } from './host.js';
export { toV09 } from './to-v09.js';
export { A2UI_THEME_CSS, NXIS_PRIMARY } from './theme.js';
