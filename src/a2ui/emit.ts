/**
 * Turns a parsed WebMCP action into an A2UI message stream.
 *
 * The model never authors A2UI: it picks a tool and fills parameters, and this
 * deterministic code writes every envelope. Asking a small model to produce
 * nested JSON with JSON Pointers and catalog constraints would be the least
 * reliable part of an in-browser A2UI setup, and this avoids it.
 *
 * Transport is a function call, since the agent and renderer share a JavaScript
 * context, which satisfies A2UI's ordered-delivery requirement for free.
 *
 * @module
 */

import type { NxisAction, NxisPropertyValueSpecification } from '../webmcp-contract.js';

const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

/** One component in the adjacency list. */
interface Component {
  id: string;
  component: string;
  [prop: string]: unknown;
}

/** One A2UI protocol message, authored against the v1.0 spec. */
export interface A2uiMessage {
  version: 'v1.0';
  [key: string]: unknown;
}

/**
 * A leading option that carries no label and reads as a prompt ("Select…",
 * "Choose a service…") is the HTML `<option>` placeholder convention, not a
 * real choice. A2UI has no placeholder slot on ChoicePicker, so it becomes the
 * label and is dropped from `options`, since otherwise the agent can submit
 * "Choose a service…" as a literal answer.
 */
function splitPlaceholder(
  options: NonNullable<NxisPropertyValueSpecification['nxis:valueOption']>
): { placeholder?: string; rest: typeof options } {
  const [first, ...rest] = options;
  const looksLikePrompt = first && !first.name && /[…:]\s*$/.test(first.value);
  return looksLikePrompt
    ? { placeholder: first.value, rest }
    : { rest: options };
}

/** Map one PropertyValueSpecification to a component, or null if it is data-only. */
function fieldComponent(pvs: NxisPropertyValueSpecification): Component | null {
  const id = `field_${pvs.valueName}`;
  const path = { path: `/form/${pvs.valueName}` };
  const label = pvs.description ?? pvs.valueName;

  // A prefilled field with no description is context the form carries, not
  // something to ask a human about. It stays in the data model and is submitted;
  // it just gets no component. `business` is exactly this.
  if (!pvs.description && pvs.defaultValue !== undefined) return null;

  if (pvs['nxis:valueOption']?.length) {
    const { placeholder, rest } = splitPlaceholder(pvs['nxis:valueOption']);
    return {
      id,
      component: 'ChoicePicker',
      label: placeholder ? `${label} — ${placeholder}` : label,
      variant: 'mutuallyExclusive',
      options: rest.map((o: { name?: string; value: string }) => ({ label: o.name ?? o.value, value: o.value })),
      value: path,
    };
  }

  // valueMaxLength is absent on this action, so long-text is inferred from the
  // field name. Crude, but wrong only in that a textarea renders as one line.
  const longText = /description|message|notes|details/.test(pvs.valueName);
  return {
    id,
    component: 'TextField',
    label,
    variant: longText ? 'longText' : 'shortText',
    value: path,
  };
}

/**
 * Build the full message stream for an action.
 *
 * @param action  - parsed action from nxis.js `readActions()`
 * @param prefill - values already known (the device-local profile), keyed by valueName
 */
export function emitActionSurface(
  action: NxisAction,
  prefill: Record<string, unknown> = {}
): A2uiMessage[] {
  const fields = action.input ?? [];

  // Data model first: every field, whether or not it gets a component.
  const dataModel: Record<string, unknown> = {};
  for (const pvs of fields) {
    dataModel[pvs.valueName] =
      prefill[pvs.valueName] ?? pvs.defaultValue ?? '';
  }

  const fieldComponents: Component[] = fields
    .map(fieldComponent)
    .filter((c: Component | null): c is Component => c !== null);

  const components: Component[] = [
    // Inline components are cards. See stepper.ts.
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column', children: [
      'heading', ...fieldComponents.map((c: Component) => c.id), 'submit',
    ] },
    { id: 'heading', component: 'Text', text: action.description ?? action.name, variant: 'body' },
    ...fieldComponents,
    { id: 'submit_label', component: 'Text', text: 'Submit' },
    {
      id: 'submit',
      component: 'Button',
      child: 'submit_label',
      variant: 'primary',
      // The event name carries the action @id, so the handler knows which
      // WebMCP tool to invoke without a second lookup.
      action: { event: { name: 'nxis.submit', context: { actionId: action['@id'] } } },
    },
  ];

  const surfaceId = `action_${action.name}`;

  return [
    {
      version: 'v1.0',
      createSurface: { surfaceId, catalogId: CATALOG, components, dataModel: { form: dataModel } },
    },
  ];
}

/**
 * Values the agent infers mid-conversation arrive as data-model patches rather
 * than a rebuilt surface, so the form updates under the user without losing
 * focus or anything they have already typed.
 */
export function emitPrefill(surfaceId: string, valueName: string, value: unknown): A2uiMessage {
  return {
    version: 'v1.0',
    updateDataModel: { surfaceId, path: `/form/${valueName}`, value },
  };
}
