/**
 * Builds an A2UI form from a tool's JSON Schema.
 *
 * The general counterpart to `emit.ts`, which starts from a WebMCP action
 * extracted from page JSON-LD. This one starts from the schema that remote MCP
 * tools expose and that {@link toolSchema} normalises to, producing the same
 * output surface from a different input.
 *
 * @module
 */

import type { JsonSchema } from '../types.js';
import type { A2uiMessage } from './emit.js';

const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

interface Component { id: string; component: string; [prop: string]: unknown }

const humanize = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
   .replace(/^\w/, c => c.toUpperCase());

/** Enum values may be bare scalars or {const,title}-style objects. */
function enumOptions(values: unknown[]): { label: string; value: string }[] {
  return values.map(v => {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const value = String(o.const ?? o.value ?? '');
      return { label: String(o.title ?? o.name ?? value), value };
    }
    return { label: humanize(String(v)), value: String(v) };
  });
}

function fieldComponent(key: string, spec: JsonSchema, required: boolean): Component {
  const id = `f_${key}`;
  const path = { path: `/form/${key}` };
  // The required marker is part of the label, since the basic catalog has no
  // requiredness of its own. Validation stays with the caller regardless.
  const label = `${spec.description || humanize(key)}${required ? ' *' : ''}`;

  const enumValues = spec.enum ?? spec.items?.enum;
  if (Array.isArray(enumValues) && enumValues.length) {
    return {
      id, component: 'ChoicePicker', label,
      variant: spec.type === 'array' ? 'multipleSelection' : 'mutuallyExclusive',
      options: enumOptions(enumValues),
      value: path,
    };
  }

  if (spec.type === 'boolean') return { id, component: 'CheckBox', label, value: path };

  const variant =
    spec.type === 'number' || spec.type === 'integer' ? 'number'
    : spec.format === 'password' ? 'obscured'
    : /description|message|notes|details|body/.test(key) ? 'longText'
    : 'shortText';

  return { id, component: 'TextField', label, variant, value: path };
}

/**
 * Build the form surface for a tool.
 *
 * Submit and Cancel dispatch action events carrying the tool name, so one
 * handler can serve every form without tracking which surface is live.
 */
export function emitToolForm(
  toolName: string,
  description: string,
  schema: JsonSchema,
  values: Record<string, unknown> = {},
  surfaceId = 'toolform',
): A2uiMessage[] {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const fields = Object.entries(props).map(([key, spec]) =>
    fieldComponent(key, spec ?? {}, required.has(key)));

  // Seed by type: a CheckBox bound to '' is not merely empty, it is the wrong
  // type for the component and does not round-trip through the data model.
  const dataModel: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(props)) {
    const fallback = spec?.type === 'boolean' ? false
      : spec?.type === 'number' || spec?.type === 'integer' ? null
      : '';
    dataModel[key] = values[key] ?? fallback;
  }

  const components: Component[] = [
    // Inline components are cards. See stepper.ts.
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column',
      children: ['eyebrow', 'title', ...(description ? ['desc'] : []), ...fields.map(f => f.id), 'actions'] },
    { id: 'eyebrow', component: 'Text', text: 'DETAILS NEEDED', variant: 'caption' },
    // Body, not a heading: markdown headings would pick up
    // --a2ui-font-family-title, but only with a MarkdownRenderer in context.
    // Without one the raw "###" is printed. See stepper.ts.
    { id: 'title', component: 'Text', text: humanize(toolName), variant: 'body' },
    ...(description ? [{ id: 'desc', component: 'Text', text: description, variant: 'caption' }] : []),
    ...fields,
    { id: 'actions', component: 'Row', children: ['cancel', 'submit'], justify: 'end' },
    { id: 'cancel_label', component: 'Text', text: 'Cancel' },
    { id: 'cancel', component: 'Button', child: 'cancel_label',
      action: { event: { name: 'nxis.cancel', context: { tool: toolName } } } },
    { id: 'submit_label', component: 'Text', text: 'Submit' },
    { id: 'submit', component: 'Button', child: 'submit_label', variant: 'primary',
      action: { event: { name: 'nxis.submit', context: { tool: toolName } } } },
  ];

  return [{
    version: 'v1.0',
    createSurface: { surfaceId, catalogId: CATALOG, components, dataModel: { form: dataModel } },
  }];
}
