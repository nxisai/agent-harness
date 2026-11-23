// @vitest-environment happy-dom
/**
 * `<nxis-agent>` is the element; `<nxis-agent-fullscreen>`, its old name, is a deprecated alias.
 *
 * The alias is the same element, exported under its old class name too. It opened full screen when that was the
 * only default, so it still does with no `mode` attribute and no stored toggle choice; either of those wins, as on
 * `<nxis-agent>`. The first alias on a page warns once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NxisAgent, NxisAgentFullscreen } from '../src/ui/index';

const KEY = 'nxis-agent:mode';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function mount(tag: 'nxis-agent' | 'nxis-agent-fullscreen', attrs: Record<string, string> = {}): any {
  const el = document.createElement(tag) as any;
  el.setAttribute('preload', 'none');
  el.setAttribute('discover', 'false');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}
const overlay = (el: any): HTMLElement => el.shadowRoot.querySelector('.overlay');
const deprecations = () => warn.mock.calls.filter((c) => String(c[0]).includes('nxis-agent-fullscreen> is deprecated'));

describe('<nxis-agent>', () => {
  it('is registered, exported as NxisAgent, and opens as a window by default', () => {
    expect(customElements.get('nxis-agent')).toBe(NxisAgent);
    const el = mount('nxis-agent');
    expect(el).toBeInstanceOf(NxisAgent);
    expect(el.mode).toBe('window');
    expect(overlay(el).classList.contains('window')).toBe(true);
  });

  it('takes the layout from mode', () => {
    expect(mount('nxis-agent', { mode: 'fullscreen' }).mode).toBe('fullscreen');
    expect(mount('nxis-agent', { mode: 'inline' }).mode).toBe('inline');
  });

  it('does not warn', () => {
    mount('nxis-agent');
    expect(deprecations()).toHaveLength(0);
  });
});

describe('<nxis-agent-fullscreen>, the deprecated alias', () => {
  // First in this block: nothing above made an alias, and the warning is once per page, not once per test.
  it('warns once per page, however many there are', () => {
    mount('nxis-agent-fullscreen');
    mount('nxis-agent-fullscreen');
    document.body.append(document.createElement('nxis-agent-fullscreen'));
    expect(deprecations()).toHaveLength(1);
    expect(String(deprecations()[0][0])).toContain('<nxis-agent>');
  });

  it('is registered, exported under its old class name, and is an NxisAgent', () => {
    expect(customElements.get('nxis-agent-fullscreen')).toBe(NxisAgentFullscreen);
    const el = mount('nxis-agent-fullscreen');
    expect(el).toBeInstanceOf(NxisAgentFullscreen);
    expect(el).toBeInstanceOf(NxisAgent);
  });

  it('keeps full screen as its default', () => {
    const el = mount('nxis-agent-fullscreen');
    expect(el.mode).toBe('fullscreen');
    expect(overlay(el).classList.contains('window')).toBe(false);
    expect(el.hasAttribute('mode')).toBe(false);
  });

  it('lets a mode attribute win', () => {
    expect(mount('nxis-agent-fullscreen', { mode: 'window' }).mode).toBe('window');
    expect(mount('nxis-agent-fullscreen', { mode: 'inline' }).mode).toBe('inline');
  });

  it('lets the viewer’s stored choice win, window included', () => {
    localStorage.setItem(KEY, 'window');
    expect(mount('nxis-agent-fullscreen').mode).toBe('window');
    localStorage.setItem(KEY, 'fullscreen');
    expect(mount('nxis-agent-fullscreen').mode).toBe('fullscreen');
  });

  it('toggles like the element it aliases', () => {
    const el = mount('nxis-agent-fullscreen');
    el.open();
    el.shadowRoot.querySelector('.main-head .modebtn').click();
    expect(el.mode).toBe('window');
    expect(localStorage.getItem(KEY)).toBe('window');
  });
});
