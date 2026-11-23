/**
 * Lets a second copy of the harness load on a page that already has one (two versions, or the CDN build beside a
 * bundled one) without throwing. `@a2ui/lit` defines its elements as its modules evaluate, with no check for a name
 * already taken, and a second definition throws. From this module to `define-restore.ts`, which `host.ts` imports
 * on either side of `@a2ui/lit`, a name already defined is skipped and the first copy's element stays. The registry's
 * own `define` is put back straight after, so nothing outside that evaluation sees the change.
 *
 * @module
 */
export const registry = globalThis.customElements;

/** The registry's own `define`, for `define-restore.ts`. */
export const ownDefine = registry?.define;

if (ownDefine) registry.define = (name, ctor, options) => registry.get(name) || ownDefine.call(registry, name, ctor, options);
