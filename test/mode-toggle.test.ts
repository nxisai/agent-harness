// @vitest-environment happy-dom
/**
 * Window is the default, and a button in the header switches between window and full screen.
 *
 * The host's explicit `mode` wins on load; otherwise the viewer's last choice, kept in `localStorage` under
 * `nxis-agent:mode`, does. The toggle is hidden in inline mode, below 520px and with `no-mode-toggle`, fires
 * `nxis-mode-change`, keeps focus on itself, and changes nothing but the overlay's shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';

const KEY = 'nxis-agent:mode';

let narrow = false;
beforeEach(() => {
  localStorage.clear();
  narrow = false;
  vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) => ({ matches: narrow && q.includes('520px'), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function mount(attrs: Record<string, string> = {}): any {
  const el = document.createElement('nxis-agent') as any;
  el.setAttribute('preload', 'none');
  el.setAttribute('discover', 'false');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}
const overlay = (el: any): HTMLElement => el.shadowRoot.querySelector('.overlay');
const toggle = (el: any): HTMLButtonElement => el.shadowRoot.querySelector('.main-head .modebtn');

describe('the default mode', () => {
  it('is window when no mode attribute is set', () => {
    const el = mount();
    expect(el.mode).toBe('window');
    expect(overlay(el).classList.contains('window')).toBe(true);
  });

  it('is window for an unknown value, and through the setter', () => {
    const el = mount({ mode: 'sideways' });
    expect(el.mode).toBe('window');
    el.mode = 'nonsense';
    expect(el.getAttribute('mode')).toBe('window');
  });

  it('keeps mode="fullscreen" and mode="inline" as they were', () => {
    const full = mount({ mode: 'fullscreen' });
    expect(full.mode).toBe('fullscreen');
    expect(overlay(full).classList.contains('window')).toBe(false);
    const inline = mount({ mode: 'inline' });
    expect(inline.mode).toBe('inline');
    expect(overlay(inline).classList.contains('inline')).toBe(true);
    expect(overlay(inline).classList.contains('show')).toBe(true);
  });
});

describe('the toggle', () => {
  it('is a real button in the header that names what it will do', () => {
    const el = mount();
    const b = toggle(el);
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.hidden).toBe(false);
    expect(b.getAttribute('aria-label')).toBe('Expand to full screen');
    expect(b.querySelector('svg')).toBeTruthy();
  });

  it('switches both ways, fires nxis-mode-change each time, and remembers the choice', () => {
    const el = mount();
    el.open();
    const seen: string[] = [];
    document.addEventListener('nxis-mode-change', (e) => seen.push((e as CustomEvent).detail.mode));

    toggle(el).click();
    expect(el.mode).toBe('fullscreen');
    expect(overlay(el).classList.contains('window')).toBe(false);
    expect(overlay(el).classList.contains('show')).toBe(true);
    expect(toggle(el).getAttribute('aria-label')).toBe('Shrink to a window');
    expect(localStorage.getItem(KEY)).toBe('fullscreen');

    toggle(el).click();
    expect(el.mode).toBe('window');
    expect(overlay(el).classList.contains('window')).toBe(true);
    expect(toggle(el).getAttribute('aria-label')).toBe('Expand to full screen');
    expect(localStorage.getItem(KEY)).toBe('window');

    expect(seen).toEqual(['fullscreen', 'window']);
  });

  it('keeps focus on itself and leaves the conversation alone', () => {
    const el = mount();
    el.open();
    el._appendMsg('user', 'Hello there');
    const thread = el.shadowRoot.querySelector('.thread') as HTMLElement;
    const before = thread.innerHTML;
    toggle(el).focus();
    toggle(el).click();
    expect(el.shadowRoot.activeElement).toBe(toggle(el));
    expect(thread.innerHTML).toBe(before);
    expect(el.shadowRoot.querySelector('.thread')).toBe(thread);
  });

  it('is operable from the keyboard: focusable, in the tab order, and a native button', () => {
    const el = mount();
    const b = toggle(el);
    expect(b.disabled).toBe(false);
    // Nothing takes it out of the tab order, and it has a visible focus ring.
    expect(b.hasAttribute('tabindex')).toBe(false);
    expect(el.shadowRoot.querySelector('style').textContent).toMatch(/\.modebtn:focus-visible[^{]*\{\s*outline: 2px solid/);
    b.focus();
    expect(el.shadowRoot.activeElement).toBe(b);
    // Enter and Space press a native <button> as a click; no key handler of its own to double it.
    b.click();
    expect(el.mode).toBe('fullscreen');
  });
});

describe('the stored choice', () => {
  it('applies on load when the host sets no mode', () => {
    localStorage.setItem(KEY, 'fullscreen');
    expect(mount().mode).toBe('fullscreen');
  });

  it('loses to the host’s explicit mode', () => {
    localStorage.setItem(KEY, 'fullscreen');
    expect(mount({ mode: 'window' }).mode).toBe('window');
    localStorage.setItem(KEY, 'window');
    expect(mount({ mode: 'fullscreen' }).mode).toBe('fullscreen');
    expect(mount({ mode: 'inline' }).mode).toBe('inline');
  });

  it('ignores anything that is not window or full screen', () => {
    localStorage.setItem(KEY, 'inline');
    expect(mount().mode).toBe('window');
  });

  it('renders and switches when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const el = mount();
    expect(el.mode).toBe('window');
    const seen: string[] = [];
    el.addEventListener('nxis-mode-change', (e: Event) => seen.push((e as CustomEvent).detail.mode));
    expect(() => toggle(el).click()).not.toThrow();
    expect(el.mode).toBe('fullscreen');
    expect(seen).toEqual(['fullscreen']);
  });
});

describe('where the toggle is hidden', () => {
  it('in inline mode', () => {
    expect(toggle(mount({ mode: 'inline' })).hidden).toBe(true);
  });

  it('below 520px, where a window already covers the page', () => {
    narrow = true;
    expect(toggle(mount()).hidden).toBe(true);
    expect(toggle(mount({ mode: 'fullscreen' })).hidden).toBe(true);
  });

  it('with no-mode-toggle', () => {
    expect(toggle(mount({ 'no-mode-toggle': '' })).hidden).toBe(true);
    expect(toggle(mount({ mode: 'fullscreen', 'no-mode-toggle': '' })).hidden).toBe(true);
  });

  it('shows for a host that sets mode="fullscreen"', () => {
    const b = toggle(mount({ mode: 'fullscreen' }));
    expect(b.hidden).toBe(false);
    expect(b.getAttribute('aria-label')).toBe('Shrink to a window');
  });
});
