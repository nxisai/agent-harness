/** Puts the registry's own `define` back once `@a2ui/lit` has defined its elements (see `define-once.ts`). */
import { ownDefine, registry } from './define-once.js';

if (ownDefine) registry.define = ownDefine;
