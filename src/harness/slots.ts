/**
 * Merges every known source of a tool's arguments and reports what is missing.
 *
 * Sources merge by precedence, most authoritative last:
 *
 * ```
 * schema defaults  <  page context  <  saved profile  <  model args
 * ```
 *
 * Model arguments win because they encode what the user has just asked for, so
 * an explicit value in the request overrides a stored preference.
 *
 * @module
 */

import type { JsonSchema } from '../types.js';

/** One argument of a tool call, with its value and where that value came from. */
export interface Slot {
  /** Property key in the flat, model-facing schema. */
  name: string;
  /** The property's JSON Schema, used for labels, types and enums. */
  schema: JsonSchema;
  /** Whether the tool's schema lists this property as required. */
  required: boolean;
  /** Which source supplied {@link Slot.value}; `'none'` when nothing did. */
  source: 'model' | 'profile' | 'context' | 'default' | 'none';
  /** The resolved value, or `undefined` when `source` is `'none'`. */
  value: unknown;
}

/** The outcome of merging every source for one tool call. */
export interface Resolution {
  /** Every known value, ready to submit when `missing` is empty. */
  values: Record<string, unknown>;
  /** Required slots nobody supplied: the values to ask for. */
  missing: Slot[];
  /**
   * Optional slots left empty. Never asked about on their own; a write
   * confirmation may still surface them as editable extras.
   */
  optional: Slot[];
  /** Every slot in the schema, resolved or not. */
  all: Slot[];
}

/** The candidate values to merge, in order of increasing precedence. */
export interface ResolveSources {
  /** Arguments the model supplied in its tool call. */
  modelArgs?: Record<string, unknown>;
  /** Values saved from earlier turns, such as a name or an email address. */
  profile?: Record<string, unknown>;
  /** Values the host page knows, such as the current record. */
  context?: Record<string, unknown>;
  /** Values a human has typed into a live form. Ranks with `modelArgs`. */
  entered?: Record<string, unknown>;
}

/** Present and meaningful: not null, not undefined, not whitespace. */
const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

/**
 * Resolve every property in a schema against the supplied sources.
 *
 * @param schema - The tool's flat input schema.
 * @param sources - Candidate values, merged by the precedence in the module
 * description.
 * @returns The merged values, plus the required and optional slots still empty.
 */
export function resolveSlots(schema: JsonSchema, sources: ResolveSources): Resolution {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const all: Slot[] = Object.entries(props).map(([name, spec]) => {
    const propSchema = spec ?? {};

    // Highest precedence first; the first hit wins and records its origin.
    const candidates: [Slot['source'], unknown][] = [
      ['model', sources.entered?.[name]],
      ['model', sources.modelArgs?.[name]],
      ['profile', sources.profile?.[name]],
      ['context', sources.context?.[name]],
      ['default', propSchema.default],
    ];

    for (const [source, value] of candidates) {
      if (isSet(value)) {
        return { name, schema: propSchema, required: required.has(name), source, value };
      }
    }
    return { name, schema: propSchema, required: required.has(name), source: 'none', value: undefined };
  });

  const values: Record<string, unknown> = {};
  for (const slot of all) if (isSet(slot.value)) values[slot.name] = slot.value;

  return {
    values,
    missing: all.filter(s => s.required && s.source === 'none'),
    optional: all.filter(s => !s.required && s.source === 'none'),
    all,
  };
}

/**
 * The slots to display on a write confirmation: those with a value.
 *
 * Empty optional slots are omitted, since a confirmation shows what is about
 * to be sent rather than what could have been.
 *
 * @param resolution - A resolution with no remaining gaps.
 * @returns Every slot whose value came from a source.
 */
export function summarySlots(resolution: Resolution): Slot[] {
  return resolution.all.filter(s => s.source !== 'none');
}
