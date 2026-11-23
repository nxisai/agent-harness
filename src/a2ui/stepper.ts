/**
 * The two prompt surfaces: asking for missing values, and confirming a write.
 *
 * The stepper never recreates its surface. Steps arrive as component updates
 * against a live surface whose data model already holds every answer, so moving
 * between steps changes the components without touching the data, and nothing
 * already entered is lost.
 *
 * @module
 */

import type { JsonSchema } from '../types.js';
import type { A2uiMessage } from './emit.js';
import type { ClarificationPlan, PlanStep } from '../harness/plan.js';
import type { Slot } from '../harness/slots.js';

const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

interface Component { id: string; component: string; [prop: string]: unknown }

const humanize = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
   .replace(/^\w/, c => c.toUpperCase());

function labelFor(slot: Slot): string {
  return slot.schema.description || humanize(slot.name);
}

function enumOptions(values: unknown[]): { label: string; value: string }[] {
  return values
    .map(v => String(v))
    // A leading placeholder option is a markup convention rather than a
    // choice, and offering it would allow it to be submitted as an answer.
    .filter(v => !/[…:]\s*$/.test(v))
    .map(v => ({ label: humanize(v), value: v }));
}

/** One input bound to /form/<name>. */
function inputFor(slot: Slot): Component {
  const id = `f_${slot.name}`;
  const value = { path: `/form/${slot.name}` };
  const label = labelFor(slot);
  const spec: JsonSchema = slot.schema;

  const values = spec.enum ?? spec.items?.enum;
  if (Array.isArray(values) && values.length) {
    return { id, component: 'ChoicePicker', label, variant: 'mutuallyExclusive',
             options: enumOptions(values), value };
  }
  if (spec.type === 'boolean') return { id, component: 'CheckBox', label, value };

  const variant =
    spec.type === 'number' || spec.type === 'integer' ? 'number'
    : /description|message|notes|details/.test(slot.name) ? 'longText'
    : 'shortText';
  return { id, component: 'TextField', label, variant, value };
}

function stepComponents(
  step: PlanStep,
  plan: ClarificationPlan,
  toolName: string,
): Component[] {
  const fields = step.slots.map(inputFor);
  const isLast = step.index === plan.steps.length - 1;
  const isFirst = step.index === 0;

  const actionIds = [
    ...(plan.stepped && !isFirst ? ['back'] : []),
    'cancel',
    isLast ? 'submit' : 'next',
  ];

  // Same header shape as the review and submitted cards: an uppercase eyebrow
  // then the detail. Uppercased in the string itself because no CSS of
  // ours reaches inside these components.
  //
  // The headline is NOT Manrope. --a2ui-font-family-title applies only to
  // markdown headings, and Text falls back to rendering the raw string unless
  // a MarkdownRenderer is provided through Lit context, so "### Foo" renders as
  // literal hashes. Reaching the display face here needs @a2ui/markdown-it
  // wired into the surface, not a formatting trick.
  const heading: Component[] = [
    { id: 'eyebrow', component: 'Text',
      text: plan.stepped
        ? `STEP ${step.index + 1} OF ${plan.steps.length}`
        : 'ONE MORE DETAIL',
      variant: 'caption' },
    { id: 'headline', component: 'Text', text: step.title, variant: 'body' },
  ];

  return [
    // Every inline component is a card: the surface is a thing placed in the
    // conversation, and the card edge is what separates it from the message
    // bubbles either side. Card takes one child, so the content column sits
    // inside it rather than being the root itself.
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column',
      children: [...heading.map(h => h.id), ...fields.map(f => f.id), 'actions'] },
    ...heading,
    ...fields,
    { id: 'actions', component: 'Row', children: actionIds, justify: 'end' },

    { id: 'back_label', component: 'Text', text: 'Back' },
    { id: 'back', component: 'Button', child: 'back_label',
      action: { event: { name: 'nxis.back', context: { tool: toolName, step: step.index } } } },

    { id: 'cancel_label', component: 'Text', text: 'Cancel' },
    { id: 'cancel', component: 'Button', child: 'cancel_label',
      action: { event: { name: 'nxis.cancel', context: { tool: toolName } } } },

    { id: 'next_label', component: 'Text', text: 'Next' },
    { id: 'next', component: 'Button', child: 'next_label', variant: 'primary',
      action: { event: { name: 'nxis.next', context: { tool: toolName, step: step.index } } } },

    { id: 'submit_label', component: 'Text', text: 'Submit' },
    { id: 'submit', component: 'Button', child: 'submit_label', variant: 'primary',
      action: { event: { name: 'nxis.submit', context: { tool: toolName } } } },
  ];
}

/** Create the surface, showing the first step. */
export function emitAsk(
  toolName: string,
  plan: ClarificationPlan,
  known: Record<string, unknown>,
  surfaceId = 'ask',
): A2uiMessage[] {
  // Seed every gap so its input has a value to bind to, and carry the known
  // values along: they are submitted with the answers even though no step
  // ever displays them.
  const form: Record<string, unknown> = { ...known };
  for (const step of plan.steps) {
    for (const slot of step.slots) {
      if (form[slot.name] === undefined) {
        form[slot.name] = slot.schema.type === 'boolean' ? false : '';
      }
    }
  }

  return [{
    version: 'v1.0',
    createSurface: {
      surfaceId, catalogId: CATALOG,
      components: stepComponents(plan.steps[0], plan, toolName),
      dataModel: { form, step: 0 },
    },
  }];
}

/** Move to another step: components only, so answers already typed survive. */
export function emitStep(
  surfaceId: string,
  toolName: string,
  plan: ClarificationPlan,
  index: number,
): A2uiMessage[] {
  return [
    { version: 'v1.0',
      updateComponents: { surfaceId, components: stepComponents(plan.steps[index], plan, toolName) } },
    { version: 'v1.0', updateDataModel: { surfaceId, path: '/step', value: index } },
  ];
}

/**
 * The write confirmation: what is about to be sent, read-only.
 *
 * Not a form: nothing is missing, so there is nothing to fill in,
 * showing inputs would imply otherwise and invite editing that was not asked
 * for. Edit is available, as a button, for when it genuinely was.
 */
export function emitConfirm(
  toolName: string,
  slots: Slot[],
  surfaceId = 'confirm',
  submitLabel = 'Submit',
): A2uiMessage[] {
  const rows = slots.map(s => ({ label: labelFor(s), value: String(s.value ?? '') }));

  const components: Component[] = [
    // The review is a card for the same reason the inputs are: it is one
    // reviewable object, and its edge is what says "this is what will be sent"
    // rather than "this is more conversation".
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column', children: ['eyebrow', 'headline', 'rows', 'actions'] },
    { id: 'eyebrow', component: 'Text', text: 'READY TO SEND', variant: 'caption' },
    { id: 'headline', component: 'Text', text: humanize(toolName), variant: 'body' },

    { id: 'rows', component: 'List',
      children: { path: '/rows', componentId: 'row_tpl' }, direction: 'vertical' },
    { id: 'row_tpl', component: 'Row', children: ['row_label', 'row_value'] },
    { id: 'row_label', component: 'Text', text: '${label}', variant: 'caption' },
    { id: 'row_value', component: 'Text', text: '${value}' },

    { id: 'actions', component: 'Row', children: ['edit', 'cancel', 'send'], justify: 'end' },
    { id: 'edit_label', component: 'Text', text: 'Edit' },
    { id: 'edit', component: 'Button', child: 'edit_label',
      action: { event: { name: 'nxis.edit', context: { tool: toolName } } } },
    { id: 'cancel_label', component: 'Text', text: 'Cancel' },
    { id: 'cancel', component: 'Button', child: 'cancel_label',
      action: { event: { name: 'nxis.cancel', context: { tool: toolName } } } },
    { id: 'send_label', component: 'Text', text: submitLabel },
    { id: 'send', component: 'Button', child: 'send_label', variant: 'primary',
      action: { event: { name: 'nxis.submit', context: { tool: toolName } } } },
  ];

  return [{
    version: 'v1.0',
    createSurface: { surfaceId, catalogId: CATALOG, components, dataModel: { rows } },
  }];
}
