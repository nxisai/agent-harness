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
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/lit/v0_9';
import '@a2ui/lit/v0_9';
import './define-restore.js';

import type { A2uiMessage } from './emit.js';
import { toV09 } from './to-v09.js';

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
 */
export function mountSurface(
  container: HTMLElement,
  messages: A2uiMessage[],
  onAction?: (event: any) => void,
): MountedSurface | null {
  const processor = new MessageProcessor(
    [basicCatalog as any],
    (event: any) => onAction?.(event),
  );

  processor.processMessages(toV09(messages) as any);

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
    send: (msgs: A2uiMessage[]) => processor.processMessages(toV09(msgs) as any),
    dispose: () => {
      element.remove();
      (processor as any).dispose?.();
    },
  };
}
