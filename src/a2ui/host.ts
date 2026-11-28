/**
 * Mounts A2UI messages into a container element.
 *
 * Wraps the emit, downgrade, process and mount sequence every A2UI surface
 * needs, so callers deal in messages and a container rather than in message
 * processor lifecycles.
 *
 * Works inside a shadow root, since `<a2ui-surface>` is a custom element and
 * upgrades wherever it is appended.
 *
 * @module
 */

// First and last, around @a2ui/lit: a second copy of the harness on the page skips its elements instead of throwing.
import './define-once.js';
import { MessageProcessor, Catalog, BASIC_FUNCTIONS } from '@a2ui/web_core/v0_9';
import { basicCatalog, A2uiLitElement, A2uiController } from '@a2ui/lit/v0_9';
import '@a2ui/lit/v0_9';
import './define-restore.js';
import { html, nothing, unsafeCSS } from 'lit';
import { z } from 'zod';

import type { A2uiMessage } from './emit.js';
import { toV09 } from './to-v09.js';

/** No theme on the surfaces drawn here: the element's tokens (its accent) style them, and an inline primary color would win. */
const NO_THEME = { primaryColor: null };
import type { StepsKit } from './steps-catalog.js';

/**
 * What the steps catalog (a target's step surfaces, `steps-catalog.ts`) is built from. Handed to its lazy chunk
 * rather than imported there, so the renderer, Lit and zod stay in one chunk with the rest of the page-load code.
 */
export const stepsKit: StepsKit = { A2uiLitElement, A2uiController, Catalog, basicCatalog, functions: BASIC_FUNCTIONS as any[], z, html, unsafeCSS, nothing };

/** A live A2UI surface, and the handle used to tear it down. */
export interface MountedSurface {
  /** The processor, for reading the live data model or sending further messages. */
  processor: any;
  /** The mounted custom element. */
  element: HTMLElement;
  /** Current value of one top-level data-model key on this surface. */
  read(key: string): unknown;
  /** Push a v1.0 message (e.g. a prefill patch) into the live surface. */
  send(messages: A2uiMessage[]): void;
  dispose(): void;
}

/**
 * Render `messages` into `container`.
 *
 * @param onAction - Called when the renderer dispatches a button action. The
 * event carries whatever `action.event.context` the emitter attached.
 * @param catalog - What the surface is drawn with: the basic catalog, or the steps catalog.
 */
export function mountSurface(
  container: HTMLElement,
  messages: A2uiMessage[],
  onAction?: (event: any) => void,
  catalog: unknown = basicCatalog,
): MountedSurface | null {
  const processor = new MessageProcessor(
    [catalog as any],
    (event: any) => onAction?.(event),
  );

  processor.processMessages(toV09(messages, NO_THEME) as any);

  // One surface per mount; the first is the one just created.
  const first = processor.model.surfacesMap.entries().next();
  if (first.done) return null;
  const [, surface] = first.value as [string, unknown];

  const element = document.createElement('a2ui-surface') as any;
  element.surface = surface;
  container.appendChild(element);

  return {
    processor,
    element,
    // DataModel exposes get(path); reading the surface's own model avoids
    // depending on the sendDataModel flag that getClientDataModel requires.
    read: (key: string) => (surface as any)?.dataModel?.get(`/${key}`),
    send: (msgs: A2uiMessage[]) => processor.processMessages(toV09(msgs, NO_THEME) as any),
    dispose: () => {
      element.remove();
      (processor as any).dispose?.();
    },
  };
}
