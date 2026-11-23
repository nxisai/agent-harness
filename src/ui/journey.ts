/**
 * How a journey reads, for a surface that shows one.
 *
 * Kept apart from the element so the reading — what the card is called,
 * whether it is still running, what one line says once it is done — can be
 * tested without a browser, and reused by a surface the host builds itself.
 *
 * @module
 */
import type { AgentStep } from '../harness/steps.js';

/** A journey, reduced to what a card needs. */
export interface JourneyView {
  /** The journey's id. */
  id: string;
  /** What it is: the name of the thing the agent used. */
  title: string;
  /** The steps worth a line each. The choice of tool is the title instead. */
  steps: AgentStep[];
  /** Still going, finished, or stopped short. */
  outcome: 'running' | 'done' | 'failed';
  /** The step in progress, while there is one. */
  active?: AgentStep;
  /** One line for the folded card, or for a status bar while running. */
  summary: string;
}

/**
 * Read a journey's steps as a card.
 *
 * @param steps - The journey's steps, oldest first.
 * @returns The card's reading, or null for a journey with nothing in it.
 */
export function viewJourney(steps: AgentStep[]): JourneyView | null {
  if (!steps.length) return null;
  const id = steps.find((s) => s.journey)?.journey ?? '';
  const choose = steps.find((s) => s.id === 'choose');
  const title = choose?.label || 'Working on it';
  const listed = steps.filter((s) => s.id !== 'choose');

  const failed = listed.find((s) => s.status === 'failed');
  const submitted = listed.find((s) => s.id === 'submit' && s.status === 'done');
  const outcome: JourneyView['outcome'] = failed ? 'failed' : submitted ? 'done' : 'running';
  // The latest active step, not the first: collect can reopen after navigate.
  const active = [...listed].reverse().find((s) => s.status === 'active');

  const summary =
    outcome === 'done'
      ? `${title} · ${lower(submitted!.label)}`
      : outcome === 'failed'
        ? `${title} · ${lower(failed!.label)}`
        : (active?.label ?? title);

  return { id, title, steps: listed, outcome, active, summary };
}

const lower = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
