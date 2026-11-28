// @vitest-environment happy-dom
/**
 * A site's accent (its brand color, as the site's script passes it) styles the step cards as it does the rest: the
 * primary buttons, the chosen chip and the handoff bar, with its pressed shade and its wash derived when only the
 * accent is given. In a real test run only the accent was set, so a chosen chip had an orange border on a blue wash
 * with blue words, and the review's labels read as code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepsCatalog } from '../src/a2ui/steps-catalog';
import { stepsKit } from '../src/a2ui/host';
import '../src/ui/agent';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const agent = (): any => {
  vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
  const el = document.createElement('nxis-agent') as any;
  el.setAttribute('preload', 'none');
  el.setAttribute('discover', 'false');
  document.body.append(el);
  return el;
};

describe('a site accent', () => {
  it('an accent alone brings its pressed shade and its wash', () => {
    const el = agent();
    el.theme = { accent: '#b45309' };
    expect(el.style.getPropertyValue('--blue')).toBe('#b45309');
    expect(el.style.getPropertyValue('--blue-strong')).toBe('color-mix(in srgb, #b45309 70%, var(--ink))');
    expect(el.style.getPropertyValue('--blue-tint')).toBe('color-mix(in srgb, #b45309 9%, var(--bg))');
    expect(el.style.getPropertyValue('--color-blue-tint')).toBe('color-mix(in srgb, #b45309 9%, var(--bg))');
    // Given ones win; none at all leaves the defaults.
    el.theme = { accent: '#b45309', accentTint: '#fff7ed' };
    expect(el.style.getPropertyValue('--blue-tint')).toBe('#fff7ed');
    el.theme = {};
    expect(el.style.getPropertyValue('--blue')).toBe('');
    expect(el.style.getPropertyValue('--blue-strong')).toBe('');
  });

  it('the step cards draw in the accent tokens, a primary button fills its row, and review labels are plain words', () => {
    stepsCatalog(stepsKit);
    const css = (customElements.get('nxis-step-confirmcard') as any).elementStyles.map((s: CSSStyleSheet | { cssText: string }) => (s as any).cssText).join('');
    expect(css).toMatch(/\.btn\.p\{background:var\(--blue/);
    expect(css).toMatch(/\.chip\[aria-pressed=true\]\{border-color:var\(--blue[^}]*background:var\(--blue-tint[^}]*color:var\(--blue-strong/);
    expect(css).toMatch(/\.acts \.btn\.p\{flex:1 1 0;min-width:0\}/);
    // The review's heading is plain words too.
    expect(css).toMatch(/\.hd\{font-weight:600;font-size:13px/);
    expect(css).toMatch(/dt\{font-size:13px;color:var\(--ink-2/);
    expect(css).not.toMatch(/dt\{[^}]*text-transform:uppercase/);
    // A StepHeader's job wraps rather than being cut short.
    expect(css).not.toMatch(/\.sh \.top span\{[^}]*white-space:nowrap/);
  });
});
