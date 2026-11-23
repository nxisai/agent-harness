/**
 * The action card's data: how a tool's slots become the fields it shows, what
 * it sends, and what stops it from sending. The drawing needs a DOM and is
 * checked in a browser; everything it draws from is checked here.
 */
import { describe, expect, it } from 'vitest';
import { actionValues, fieldLabel, fieldsFromSlots, initials, missingFields } from '../src/ui/action-card';
import { resolveSlots } from '../src/harness/slots';
import type { JsonSchema } from '../src/types';

const QUOTE: JsonSchema = {
  type: 'object',
  properties: {
    business: { type: 'string' },
    full_name: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' },
    service: { type: 'string' },
    timeline: { type: 'string', enum: ['emergency', 'this-week', 'flexible'] },
    project_description: { type: 'string' },
    subscribe: { type: 'boolean' },
    budget: { type: 'number' },
  },
  required: ['business', 'full_name', 'email', 'service'],
};

const quote = (modelArgs: Record<string, unknown>) => {
  const r = resolveSlots(QUOTE, { modelArgs });
  return { r, fields: fieldsFromSlots(r.all, r.values, { needed: new Set(r.missing.map((s) => s.name)), hidden: new Set(['business']) }) };
};

describe('fields from slots', () => {
  it('puts what the agent has under known, what is missing under needed, and the target out of sight', () => {
    const { fields } = quote({ business: 'Hatzel & Sons Plumbing', service: 'Water heater', project_description: 'Leaking tank' });
    const group = Object.fromEntries(fields.map((f) => [f.name, f.group]));
    expect(group).toMatchObject({ business: 'hidden', service: 'known', project_description: 'known', full_name: 'needed', email: 'needed', phone: 'needed' });
  });

  it('picks a control from the schema and the name', () => {
    const { fields } = quote({});
    const kind = Object.fromEntries(fields.map((f) => [f.name, f.kind]));
    expect(kind).toMatchObject({ email: 'email', phone: 'tel', timeline: 'choice', project_description: 'long', subscribe: 'check', budget: 'number', full_name: 'text' });
    expect(fields.find((f) => f.name === 'timeline')!.options!.map((o) => o.label)).toEqual(['Emergency', 'This week', 'Flexible']);
  });

  it('labels fields in words, or as the caller says', () => {
    expect(fieldLabel('full_name')).toBe('Full name');
    expect(fieldLabel('projectDescription')).toBe('Project description');
    const r = resolveSlots(QUOTE, {});
    expect(fieldsFromSlots(r.all, {}, { labels: { email: 'Where should they reply?' } }).find((f) => f.name === 'email')!.label).toBe('Where should they reply?');
  });
});

describe('what the card sends', () => {
  it('sends typed values and leaves empty optional fields out', () => {
    const { fields } = quote({ business: 'Hatzel & Sons Plumbing', service: 'Water heater', budget: 400, subscribe: true });
    const values = actionValues({ fields });
    expect(values).toEqual({ business: 'Hatzel & Sons Plumbing', service: 'Water heater', budget: 400, subscribe: true });
  });

  it('keeps the hidden target in what it sends', () => {
    const { fields } = quote({ business: 'Hatzel & Sons Plumbing' });
    expect(actionValues({ fields }).business).toBe('Hatzel & Sons Plumbing');
  });
});

describe('what stops it', () => {
  it('names the required fields still empty', () => {
    const { fields } = quote({ business: 'Hatzel & Sons Plumbing', service: 'Water heater' });
    expect(missingFields({ fields }).map((f) => f.name)).toEqual(['full_name', 'email']);
  });

  it('will not send an email address that is not one', () => {
    const { fields } = quote({ business: 'H', service: 's', full_name: 'Dana', email: 'dana@' });
    expect(missingFields({ fields }).map((f) => f.name)).toEqual(['email']);
    fields.find((f) => f.name === 'email')!.value = 'dana@example.com';
    expect(missingFields({ fields })).toEqual([]);
  });

  it('never blocks on a hidden field', () => {
    const r = resolveSlots(QUOTE, { modelArgs: { service: 's', full_name: 'Dana', email: 'd@x.example' } });
    const fields = fieldsFromSlots(r.all, r.values, { hidden: new Set(['business']) });
    expect(missingFields({ fields })).toEqual([]);
  });
});

it('draws two letters for a name', () => {
  expect(initials('Hatzel & Sons Plumbing')).toBe('HS');
  expect(initials('the directory team')).toBe('TD');
  expect(initials('')).toBe('?');
});
