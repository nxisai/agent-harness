/**
 * Reading a journey as a card, and keeping journeys apart.
 *
 * A conversation holds many requests. Each journey carries its own id, the
 * id survives a page change, and the card's one-line summary says how the
 * journey ended — which is all a folded card has room for.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginJourney,
  currentJourney,
  journeySteps,
  recordStep,
  restoreJourney,
  type AgentStep,
} from '../src/harness/steps';
import { viewJourney } from '../src/ui/journey';
import { withoutSiteSuffix } from '../src/harness/tools/action-tools';

beforeEach(() => beginJourney());

describe('journey ids', () => {
  it('gives each request its own journey', () => {
    const first = beginJourney();
    recordStep({ id: 'choose', label: 'Quote form', status: 'done' });
    const second = beginJourney();
    recordStep({ id: 'choose', label: 'Contact form', status: 'done' });
    expect(first).not.toBe(second);
    expect(journeySteps().every((s) => s.journey === second)).toBe(true);
  });

  it('stamps a step recorded before any journey began', () => {
    restoreJourney([]);
    recordStep({ id: 'choose', label: 'Quote form', status: 'done' });
    expect(journeySteps()[0].journey).toBe(currentJourney());
    expect(currentJourney()).toBeTruthy();
  });

  it('continues the same journey after a page change', () => {
    const id = beginJourney();
    recordStep({ id: 'navigate', label: 'Opening Royal Oak Remodeling', status: 'active' });
    const carried = journeySteps();

    beginJourney(); // the page dies
    restoreJourney(carried);
    recordStep({ id: 'arrive', label: 'Found the form', status: 'done' });

    expect(currentJourney()).toBe(id);
    expect(journeySteps().map((s) => s.journey)).toEqual([id, id]);
  });
});

describe('reading a journey as a card', () => {
  const step = (s: Partial<AgentStep> & Pick<AgentStep, 'id'>): AgentStep => ({
    label: s.id,
    status: 'done',
    journey: 'j1',
    ...s,
  });

  it('is titled by what was used, and lists the rest', () => {
    const view = viewJourney([
      step({ id: 'choose', label: 'Quote form' }),
      step({ id: 'confirm', label: 'You confirmed' }),
      step({ id: 'navigate', label: 'Opening Royal Oak Remodeling', status: 'active' }),
    ])!;
    expect(view.title).toBe('Quote form');
    expect(view.steps.map((s) => s.id)).toEqual(['confirm', 'navigate']);
    expect(view.outcome).toBe('running');
    expect(view.summary).toBe('Opening Royal Oak Remodeling');
  });

  it('says how it ended once it is done', () => {
    const view = viewJourney([
      step({ id: 'choose', label: 'Quote form' }),
      step({ id: 'fill', label: 'Filled the form' }),
      step({ id: 'submit', label: 'Submitted' }),
    ])!;
    expect(view.outcome).toBe('done');
    expect(view.summary).toBe('Quote form · submitted');
    expect(view.active).toBeUndefined();
  });

  it('ends at the handoff, though the conversation carries on with the target', () => {
    const view = viewJourney([
      step({ id: 'choose', label: 'Talk to a person' }),
      step({ id: 'confirm', label: 'You confirmed' }),
      step({ id: 'fill', label: 'Handed the conversation over' }),
      step({ id: 'submit', label: 'Handed to Copperline Booking' }),
    ])!;
    expect(view.outcome).toBe('done');
    expect(view.summary).toBe('Talk to a person · handed to Copperline Booking');
  });

  it('says where it stopped when something failed', () => {
    const view = viewJourney([
      step({ id: 'choose', label: 'Quote form' }),
      step({ id: 'arrive', label: 'Could not find the form here', status: 'failed' }),
    ])!;
    expect(view.outcome).toBe('failed');
    expect(view.summary).toBe('Quote form · could not find the form here');
  });

  it('reads a cancelled journey as stopped, not still waiting', () => {
    const view = viewJourney([
      step({ id: 'choose', label: 'Quote form' }),
      step({ id: 'confirm', label: 'Waiting for you to confirm', status: 'active' }),
      step({ id: 'submit', label: 'Cancelled', status: 'failed' }),
    ])!;
    expect(view.outcome).toBe('failed');
    expect(view.summary).toBe('Quote form · cancelled');
  });

  it('points at the latest active step when an earlier one reopens', () => {
    // After a page change the live form can ask for more: collect is active
    // again, after navigate and arrive.
    const view = viewJourney([
      step({ id: 'choose', label: 'Quote form' }),
      step({ id: 'navigate', label: 'Opened the page' }),
      step({ id: 'arrive', label: 'Found the form' }),
      step({ id: 'collect', label: 'This form needs more', status: 'active' }),
    ])!;
    expect(view.active?.id).toBe('collect');
  });

  it('has nothing to show for an empty journey', () => {
    expect(viewJourney([])).toBeNull();
  });
});

describe('what the visitor calls a tool', () => {
  it('drops the suffix that only a registry needs', () => {
    expect(withoutSiteSuffix('quote_form_anywhere')).toBe('quote_form');
    expect(withoutSiteSuffix('nxis_query')).toBe('nxis_query');
  });
});
