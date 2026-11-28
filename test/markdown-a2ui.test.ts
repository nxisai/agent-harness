// @vitest-environment jsdom
/**
 * A2UI Text inside the element draws markdown through the renderer the element provides by Lit context: no
 * "no markdown renderer is configured" warning, bold as bold, raw HTML as text.
 */
import './helpers/lit-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deep, until } from './helpers/lit-dom';
import { mountSurface, stepsKit } from '../src/a2ui/host';
import { stepsCatalog } from '../src/a2ui/steps-catalog';
import { STEPS_CATALOG } from '../src/a2ui/steps';
import '../src/ui/agent';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('A2UI Text in the element', () => {
  it('draws its markdown, safely, with no warning', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    const box = document.createElement('div');
    (el.shadowRoot as ShadowRoot).append(box);
    mountSurface(
      box,
      [{ version: 'v1.0', createSurface: { surfaceId: 's', catalogId: STEPS_CATALOG, components: [{ id: 'root', component: 'Text', text: 'A **bold** step <img src=x onerror=alert(1)>' }], dataModel: {} } } as any],
      undefined,
      stepsCatalog(stepsKit),
    );
    await until(() => deep(box, 'strong'));
    expect(deep(box, 'strong')?.textContent).toBe('bold');
    expect(deep(box, 'img')).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/no markdown renderer/);
  });
});
