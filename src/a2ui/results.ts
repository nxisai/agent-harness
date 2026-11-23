/**
 * Typed-retrieval results as one A2UI surface, whatever they are: a lone series as its card, a lone picture as its
 * figure, episodes as rows, events as rows (a lone one as its card), anything else as result cards.
 *
 * Apart from `cards.ts` so that the packaged element, which draws each kind itself, never loads the event model with
 * the cards it draws: events load on demand there (`ui/event-cards.ts`).
 *
 * @module
 */
import type { A2uiMessage } from './emit.js';
import { cardCtas } from '../harness/cta.js';
import { figureOf } from '../harness/playable.js';
import { archetype } from '../harness/entity.js';
import { mediaRow, seriesCard } from '../harness/media.js';
import { arrangeEvents, eventCard } from '../harness/happening.js';
import { emitCardsSurface, emitFigureSurface, emitMediaSurface, emitSeriesSurface, toCardData } from './cards.js';
import { emitEventSurface, emitEventsSurface } from './events.js';

const str = (v: unknown): string => (v == null ? '' : String(Array.isArray(v) ? v[0] : v));
const humanize = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
   .replace(/^\w/, c => c.toUpperCase());

/**
 * Build the A2UI messages for a set of results.
 *
 * @returns The messages to render, as one surface.
 */
export function emitResultsSurface(
  toolName: string,
  entities: Record<string, unknown>[],
  surfaceId = 'results'
): A2uiMessage[] {
  const shown = entities.slice(0, 12);
  const heading = shown.length
    ? `${humanize(toolName)} — ${shown.length} result${shown.length === 1 ? '' : 's'}`
    : `${humanize(toolName)} — no results`;
  // A lone series that lists its parts draws as its card; a lone picture as its figure; episodes as rows. Anything
  // else, or a mix, as before.
  const series = shown.length === 1 ? seriesCard(shown[0]) : undefined;
  if (series) return emitSeriesSurface(series, surfaceId);
  const figure = shown.length === 1 ? figureOf(shown[0]) : undefined;
  if (figure) return emitFigureSurface(str(shown[0].name ?? shown[0].caption ?? 'Image'), figure, cardCtas(shown[0]), surfaceId);
  if (shown.length && shown.every((e) => archetype(e) === 'media')) return emitMediaSurface(heading, shown.map(mediaRow), surfaceId);
  // Events: a lone one as its card, several as rows, upcoming soonest first and past ones last.
  if (shown.length && shown.every((e) => archetype(e) === 'happening')) {
    const events = shown.map((e) => eventCard(e));
    if (events.length === 1) return emitEventSurface(events[0], surfaceId);
    return emitEventsSurface(heading, arrangeEvents(events, (c) => c).map((i) => events[i]), surfaceId);
  }
  const results = shown.map(toCardData);
  return emitCardsSurface(heading, results, surfaceId);
}

