/**
 * A result card's action comes from the record's own potentialAction, by the map the Typed Retrieval
 * skill and the NxisAI app's widgets share: same label, same prompt, on every surface.
 */
import { describe, expect, it } from 'vitest';
import { actionCta } from '../src/harness/cta';
import { emitCardsSurface, toCardData } from '../src/a2ui/cards';
import { toV09 } from '../src/a2ui/to-v09';

const mcmanus = {
  '@type': 'Electrician',
  name: 'McManus Electric',
  telephone: '(248) 555-1971',
  // As the listings demo serves it: full IRIs, a self-page form.
  potentialAction: {
    '@type': 'https://schema.org/QuoteAction',
    'https://schema.org/target': { 'https://nxis.ai/ns#targetKind': 'selfPage' },
  },
};

describe('actionCta', () => {
  it('maps each funnel action to its label and prompt', () => {
    const at = (t: string) => actionCta({ name: 'Acme', potentialAction: { '@type': t } });
    expect(at('QuoteAction')).toEqual({ label: 'Get a quote', message: 'Get a quote from Acme' });
    expect(at('AskAction')).toEqual({ label: 'Contact', message: 'Contact Acme' });
    expect(at('ReserveAction')).toEqual({ label: 'Reserve', message: 'Reserve at Acme' });
    expect(at('ScheduleAction')).toEqual({ label: 'Book an appointment', message: 'Book an appointment at Acme' });
    expect(at('ApplyAction')).toEqual({ label: 'Apply', message: 'Apply to Acme' });
  });

  it('reads full-IRI types, and on the site itself a self-page form still sends the prompt', () => {
    // The on-page agent is what runs that form, so the button starts it rather than opening a page.
    expect(actionCta(mcmanus)).toEqual({ label: 'Get a quote', message: 'Get a quote from McManus Electric' });
  });

  it('offers nothing for commerce, read, unmapped or reference-only actions, or none at all', () => {
    for (const a of [{ '@type': 'BuyAction' }, { '@type': 'ViewAction' }, { '@type': 'InteractAction' }, { '@id': 'urn:nxis:action:1' }]) {
      expect(actionCta({ name: 'Acme', potentialAction: a })).toBeUndefined();
    }
    expect(actionCta({ name: 'Acme' })).toBeUndefined();
  });

  it('takes one action, the first in the map order, and the name it is given', () => {
    const both = { name: 'Copperline', potentialAction: [{ '@type': 'ReserveAction' }, { '@type': 'QuoteAction' }] };
    expect(actionCta(both)).toEqual({ label: 'Get a quote', message: 'Get a quote from Copperline' });
    expect(actionCta(both, 'Copperline Home Services')?.message).toBe('Get a quote from Copperline Home Services');
  });
});

describe('A2UI result cards', () => {
  it('carry the action as at most one button', () => {
    expect(toCardData(mcmanus).actions).toEqual([{ label: 'Get a quote', message: 'Get a quote from McManus Electric' }]);
    expect(toCardData({ name: 'No action here' }).actions).toEqual([]);
  });

  it("dispatch nxis.ask with the card's message, bound from the data after the v0.9 downgrade", () => {
    const v09 = toV09(emitCardsSurface('Results', [toCardData(mcmanus)]));
    const components = v09.find((m) => m.updateComponents)!.updateComponents.components as any[];
    const button = components.find((c) => c.id === 'action_tpl');
    expect(button.component).toBe('Button');
    expect(button.action.event).toEqual({ name: 'nxis.ask', context: { message: { path: 'message' } } });
    expect(components.find((c) => c.id === 'card_actions').children).toEqual({ path: 'actions', componentId: 'action_tpl' });
    const results = v09.find((m) => m.updateDataModel?.path === '/results')!.updateDataModel.value as any[];
    expect(results[0].actions[0].message).toBe('Get a quote from McManus Electric');
  });
});
