/**
 * Arranges missing values into the steps a renderer asks for them in.
 *
 * A single missing value is one question; several become a stepper.
 *
 * @module
 */

import type { Slot } from './slots.js';

/** One screen of the plan. */
export interface PlanStep {
  /** Position in {@link ClarificationPlan.steps}, from zero. */
  index: number;
  /** Slots asked together. One by default; grouped when they belong together. */
  slots: Slot[];
  title: string;
}

/** The questions to ask before a tool call can proceed. */
export interface ClarificationPlan {
  steps: PlanStep[];
  /** True when the renderer should draw stepper chrome (Back, Step n of m). */
  stepped: boolean;
}

/**
 * Field names conventionally asked together, so they share a step.
 *
 * Matched by exact field name. Kept short by design: the more fields are
 * grouped, the less the step count communicates.
 */
const AFFINITY: string[][] = [
  ['full_name', 'name', 'email', 'phone'],
  ['city', 'state', 'zip', 'postal_code'],
];

/** Index of the {@link AFFINITY} group a field belongs to, or -1. */
function affinityGroup(name: string): number {
  return AFFINITY.findIndex(group => group.includes(name));
}

/**
 * Arrange missing slots into steps.
 *
 * @param missing - The slots still needing values, in the order to ask for them.
 * @param groupRelated - Whether to place related fields (see {@link AFFINITY})
 * on one step. Pass `false` to ask for every field separately.
 * @returns A plan whose `stepped` flag is true when it has more than one step.
 */
export function buildPlan(missing: Slot[], groupRelated = true): ClarificationPlan {
  if (!missing.length) return { steps: [], stepped: false };

  const steps: PlanStep[] = [];

  if (groupRelated) {
    const used = new Set<Slot>();
    for (const slot of missing) {
      if (used.has(slot)) continue;
      const group = affinityGroup(slot.name);
      const together = group === -1
        ? [slot]
        : missing.filter(s => !used.has(s) && affinityGroup(s.name) === group);
      together.forEach(s => used.add(s));
      steps.push({ index: steps.length, slots: together, title: stepTitle(together) });
    }
  } else {
    for (const slot of missing) {
      steps.push({ index: steps.length, slots: [slot], title: stepTitle([slot]) });
    }
  }

  // Renumber after grouping so index always matches position.
  steps.forEach((s, i) => (s.index = i));
  return { steps, stepped: steps.length > 1 };
}

/** A human label for a slot: its description, or its name made readable. */
function label(slot: Slot): string {
  return (
    slot.schema.description ||
    slot.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
      .replace(/^\w/, c => c.toUpperCase())
  );
}

/** The heading for a step, joining grouped slots with an ampersand. */
function stepTitle(slots: Slot[]): string {
  if (slots.length === 1) return label(slots[0]);
  return slots.map(label).join(' & ');
}
