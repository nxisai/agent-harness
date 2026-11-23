/**
 * What the agent is doing, as a short list a surface can show.
 *
 * A chat thread says what was said; it does not say that the page is about to
 * change, or that a form is being filled right now. A copilot surface beside
 * the page needs the second thing, and so does anyone watching a call travel
 * to another page and finish there.
 *
 * The journey outlives the page. A call confirmed on one page is submitted on
 * another, so the steps taken before the navigation are persisted with the
 * call and restored on arrival — otherwise the surface that exists to explain
 * the journey would show only its last step.
 *
 * @module
 */

/**
 * The steps a turn can take, in the order they happen.
 *
 * A closed set, so a surface can give each one its own words and ordering
 * rather than printing whatever it is handed. Surfaces should still ignore an
 * id they do not know: this list may grow.
 */
export type AgentStepId =
  /** A tool was chosen for the request. */
  | 'choose'
  /** Values are being collected from the user. */
  | 'collect'
  /** Everything is known; a human is being asked to press submit. */
  | 'confirm'
  /** Leaving for the page that can run the action. */
  | 'navigate'
  /** That page is open. */
  | 'arrive'
  /** The form is being filled and submitted. */
  | 'fill'
  /** The turn finished. */
  | 'submit';

/** How far a step got. */
export type AgentStepStatus = 'active' | 'done' | 'failed';

/** One step of what the agent is doing. */
export interface AgentStep {
  /** Which step this is. Recording the same id again updates it in place. */
  id: AgentStepId;
  /**
   * Which journey the step belongs to — one per request that acts.
   *
   * A conversation holds many requests, and a surface that keeps what was
   * done needs to know which of them a step belongs to. Filled in when the
   * step is recorded; carried across a page change with the rest.
   */
  journey?: string;
  /** What is happening, in the user's words: `Filling the quote form`. */
  label: string;
  /** How far it got. */
  status: AgentStepStatus;
  /** A quieter second line: `name, email, service`. */
  detail?: string;
}

type Listener = (step: AgentStep, all: AgentStep[]) => void;

let journey: AgentStep[] = [];
let journeyId: string | null = null;
const listeners = new Set<Listener>();

const newJourneyId = (): string =>
  'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/**
 * Start a new journey, discarding the last one.
 *
 * Called when a turn begins, so a surface does not show the previous
 * request's steps beside this one's.
 *
 * @returns The new journey's id, which every step recorded until the next
 * call carries.
 */
export function beginJourney(): string {
  journey = [];
  journeyId = newJourneyId();
  notify(undefined);
  return journeyId;
}

/** The journey steps are being recorded into, or null before the first. */
export function currentJourney(): string | null {
  return journeyId;
}

/**
 * Record a step, or update one already recorded.
 *
 * @param step - The step. An id already present is replaced where it stands,
 * so `active` becoming `done` does not append a second line. The step is
 * stamped with the current journey.
 */
export function recordStep(step: AgentStep): void {
  journeyId ??= newJourneyId();
  const stamped = { ...step, journey: journeyId };
  const at = journey.findIndex((s) => s.id === step.id);
  if (at >= 0) journey[at] = { ...journey[at], ...stamped };
  else journey.push(stamped);
  notify(stamped);
}

/** The steps so far, oldest first. */
export function journeySteps(): AgentStep[] {
  return journey.map((s) => ({ ...s }));
}

/**
 * Replace the journey with one that was carried here.
 *
 * Used on arrival, where the steps that led to the page change happened
 * before this page existed.
 */
export function restoreJourney(steps: AgentStep[] | undefined): void {
  journey = (steps ?? []).map((s) => ({ ...s }));
  // The same journey, continued: steps recorded from here belong with the
  // ones taken on the page before, not to a new request.
  journeyId = journey.find((s) => s.journey)?.journey ?? newJourneyId();
  journey = journey.map((s) => ({ ...s, journey: journeyId! }));
  notify(undefined);
}

/**
 * Watch the journey.
 *
 * A renderer receives steps through {@link HarnessRenderer.step} and needs
 * none of this; a surface drawn outside the harness — a side panel the host
 * owns — subscribes here instead.
 *
 * @param listener - Called with the step that changed, and the whole list.
 * @returns Stop listening.
 */
export function onJourneyChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(step: AgentStep | undefined): void {
  const all = journeySteps();
  // A restore or a reset has no single step to point at; the list is the news.
  const changed = step ?? all[all.length - 1] ?? { id: 'choose' as const, label: '', status: 'done' as const };
  for (const listener of listeners) {
    try {
      listener(changed, all);
    } catch (err) {
      // One surface throwing must not stop the next from being told.
      console.warn('[nxis] a step listener threw:', err);
    }
  }
}
