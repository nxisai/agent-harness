/**
 * Downgrades A2UI v1.0 messages to v0.9.
 *
 * The emitters target v1.0, which is the documented spec and the one with
 * published JSON Schemas, but available renderers support v0.9 and earlier, so
 * messages are downgraded before rendering.
 *
 * Two mechanical differences:
 *
 *  1. `version` is the string "v0.9", not "v1.0".
 *  2. v0.9's `createSurface` carries only surfaceId/catalogId: it rejects
 *     inline `components` and `dataModel` as additional properties. They have
 *     to follow as separate `updateComponents` / `updateDataModel` messages for
 *     the same surfaceId. So one v1.0 message becomes up to three.
 *
 * No longer needed once a v1.0 renderer is available.
 *
 * @module
 */

import type { A2uiMessage } from './emit.js';
import { NXIS_PRIMARY } from './theme.js';

type Msg = Record<string, any>;

/**
 * The catalog is versioned alongside the protocol, and the renderer looks it up
 * by exact id, so a v1.0 id against a v0.9 catalog registry throws
 * "Catalog not found" rather than falling back.
 */
const CATALOG_V1 = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const CATALOG_V09 = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

const downgradeCatalog = (id: string | undefined): string | undefined =>
  id === CATALOG_V1 ? CATALOG_V09 : id;

/**
 * v1.0 interpolates with `${expr}` inside a string. v0.9 has no interpolation
 * at all: a dynamic value is a DataBinding object, `{ path }`. A `${title}`
 * left as-is is not an error: it renders as the literal characters, which is
 * how it first showed up on the verification page.
 *
 * Only a string that is *entirely* one expression can convert. "Hi ${name}"
 * has no v0.9 equivalent, so it is left alone and will render literally; the
 * emitters avoid mixed interpolation for that reason.
 */
const INTERPOLATION = /^\$\{([^}]+)\}$/;

function bindStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = INTERPOLATION.exec(value);
    return m ? { path: m[1] } : value;
  }
  if (Array.isArray(value)) return value.map(bindStrings);
  if (value && typeof value === 'object') {
    const out: Msg = {};
    for (const [k, v] of Object.entries(value as Msg)) {
      // Identity and structure keys are never data-bound.
      out[k] = k === 'id' || k === 'component' || k === 'componentId' ? v : bindStrings(v);
    }
    return out;
  }
  return value;
}

/**
 * Downgrade v1.0 messages to v0.9.
 *
 * @param messages - The messages as authored by the emitters.
 * @returns The equivalent v0.9 messages, which may be more numerous because a
 * v1.0 surface creation splits into separate component and data updates.
 */
export function toV09(messages: A2uiMessage[]): Msg[] {
  const out: Msg[] = [];

  for (const msg of messages as unknown as Msg[]) {
    if (msg.createSurface) {
      const { surfaceId, catalogId, components, dataModel } = msg.createSurface;

      // `theme` exists in v0.9 and was dropped in v1.0, so it is set here
      // rather than in the emitters, which must stay v1.0-valid. The CSS
      // custom properties do the real styling; this carries the accent for any
      // renderer that never sees our stylesheet.
      out.push({
        version: 'v0.9',
        createSurface: {
          surfaceId,
          catalogId: downgradeCatalog(catalogId),
          theme: { primaryColor: NXIS_PRIMARY },
        },
      });

      if (components) {
        out.push({ version: 'v0.9', updateComponents: { surfaceId, components: bindStrings(components) } });
      }
      // v0.9 patches one path at a time, so a whole-model seed becomes one
      // message per top-level key rather than a single root write. The payload
      // key is `value` and the object is additionalProperties:false, so a
      // wrong name here is rejected outright rather than ignored.
      if (dataModel) {
        for (const [key, value] of Object.entries(dataModel)) {
          out.push({ version: 'v0.9', updateDataModel: { surfaceId, path: `/${key}`, value } });
        }
      }
      continue;
    }

    if (msg.updateDataModel) {
      const { surfaceId, path, value } = msg.updateDataModel;
      out.push({ version: 'v0.9', updateDataModel: { surfaceId, path, value } });
      continue;
    }

    out.push({ ...msg, version: 'v0.9' });
  }

  return out;
}
