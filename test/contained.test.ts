// @vitest-environment happy-dom
/**
 * `contained`: the window and its launcher drawn inside the host's box, as a preview of what a visitor sees.
 *
 * The same DOM as window mode, positioned against the host instead of the viewport; the launcher opens it, the
 * close button closes it back, `auto-open` starts it open; expand fills the box. It fetches nothing, loads only a
 * provider the host gave it, and keeps nothing in storage. The real layout (boxes measured in Chromium, and a
 * screenshot against window mode) is `npm run check:contained`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';

let narrow = false;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  narrow = false;
  fetchSpy = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(window, 'fetch').mockImplementation(fetchSpy as any);
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) => ({ matches: narrow && q.includes('520px'), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const stub = () => ({
  name: 'Preview',
  local: false,
  ready: true,
  loading: false,
  load: vi.fn(async () => {}),
  complete: vi.fn(async () => ({ text: 'Hello from the preview.' })),
});

/** Mounted the way the dashboard does: properties first, then into a sized box. */
function mount(attrs: Record<string, string> = { contained: '' }, provider: any = stub()): any {
  const box = document.createElement('div');
  box.style.cssText = 'position: relative; width: 480px; height: 700px;';
  const el = document.createElement('nxis-agent') as any;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (provider) el.modelProvider = provider;
  box.append(el);
  document.body.append(box);
  return el;
}
const $ = (el: any, sel: string): HTMLElement => el.shadowRoot.querySelector(sel);
const css = (el: any): string => el.shadowRoot.querySelector('style').textContent;
/** The conversations' storage key (CONV_KEY in agent.ts). */
const CONV_KEY = 'nxis-listings-agent-conversations';
/** The turn finished: an assistant line follows the visitor's (a bare page has no tools, and says so). */
const answered = (el: any) => el.shadowRoot.querySelectorAll('.thread .msg').length >= 2 && !el._turnActive;
const shown = (el: any) => $(el, '.overlay').classList.contains('show');

describe('contained', () => {
  it('is a boolean attribute and property, off by default', () => {
    expect(mount({}).contained).toBe(false);
    const el = mount();
    expect(el.contained).toBe(true);
    el.contained = false;
    expect(el.hasAttribute('contained')).toBe(false);
    expect($(el, '.overlay').classList.contains('contained')).toBe(false);
    el.contained = true;
    expect(el.hasAttribute('contained')).toBe(true);
    expect($(el, '.overlay').classList.contains('contained')).toBe(true);
  });

  it('draws the same launcher and window as window mode, with the same header buttons and footer', () => {
    const page = mount({});
    // With messages on, so the composer is the visitor's too; with them off, see 'the input' below.
    const preview = mount({ contained: '', 'allow-input': '' });
    expect(preview.mode).toBe('window');
    const ov = $(preview, '.overlay');
    expect(ov.classList.contains('window')).toBe(true);
    expect(ov.classList.contains('contained')).toBe(true);
    // The same tree: only the overlay's `contained` class differs.
    const strip = (el: any) => el.shadowRoot.innerHTML.replace(' contained', '').replace(/data-id="[^"]*"/g, '');
    expect(strip(preview)).toBe(strip(page));
    expect($(preview, '.launcher')).toBeTruthy();
    expect($(preview, '.main-head .close')).toBeTruthy();
    expect($(preview, '.main-head .modebtn').hidden).toBe(false);
    expect($(preview, '.foot .powered')).toBeTruthy();
  });

  it('positions the launcher and window against the host, at the window\'s insets and size, capped to the box', () => {
    const el = mount();
    const style = css(el);
    // The host is the containing block, its own stacking context (so the z-indexes stay inside it), and clips at its edge.
    expect(style).toContain(':host([contained]) { display: block; position: relative; z-index: 0; height: 100%; overflow: hidden; }');
    expect(style).toContain(':host([contained]) .launcher, .overlay.contained { position: absolute; }');
    // The window's insets, frame and shadow are window mode's own rule; only the cap is the box's.
    expect(style).toMatch(/\.overlay\.window \{\s*inset: auto; right: 20px; bottom: 20px;[^}]*box-shadow: 0 24px 60px rgba\(15,23,42,\.22\);/);
    expect(style).toContain('.overlay.contained.window { width: min(var(--window-w, 400px), calc(100% - 32px)); height: min(var(--window-h, 620px), calc(100% - 32px)); }');
    // A narrow viewport's full-bleed rule is about the viewport, so it skips the box.
    expect(style).toContain('.overlay.window:not(.contained) { inset: 0; width: auto;');
    // The launcher's own insets are the page's.
    expect(style).toMatch(/\.launcher \{\s*position: fixed; right: 20px; bottom: 20px;/);
  });

  it('opens from the launcher and closes back to it, focus following', () => {
    const el = mount();
    expect(shown(el)).toBe(false);
    $(el, '.launcher').click();
    expect(shown(el)).toBe(true);
    // The input is off, so focus goes to the header's first control.
    expect(el.shadowRoot.activeElement).toBe($(el, '.main-head .menu'));
    $(el, '.main-head .close').click();
    expect(shown(el)).toBe(false);
    expect(el.shadowRoot.activeElement).toBe($(el, '.launcher'));
    $(el, '.launcher').click();
    expect(shown(el)).toBe(true);
  });

  it('starts open with auto-open, without taking focus from the page', () => {
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    const el = mount({ contained: '', 'auto-open': '' });
    expect(shown(el)).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it('expands to fill the box and shrinks back, without remembering the choice', () => {
    const el = mount({ contained: '', 'auto-open': '' });
    const ov = $(el, '.overlay');
    $(el, '.main-head .modebtn').click();
    expect(el.mode).toBe('fullscreen');
    expect(ov.classList.contains('window')).toBe(false);
    expect(ov.classList.contains('contained')).toBe(true);
    expect(shown(el)).toBe(true);
    expect($(el, '.main-head .modebtn').getAttribute('aria-label')).toBe('Shrink to a window');
    // The conversations stay a drawer, as in a window, rather than a column at the viewport's width.
    expect(css(el)).toContain('.overlay.window .side, .overlay.inline .side, .overlay.contained .side {');
    $(el, '.main-head .modebtn').click();
    expect(el.mode).toBe('window');
    expect(ov.classList.contains('window')).toBe(true);
    expect(localStorage.getItem('nxis-agent:mode')).toBeNull();
  });

  it('ignores the mode attribute, the stored choice and a narrow viewport', () => {
    localStorage.setItem('nxis-agent:mode', 'fullscreen');
    narrow = true;
    expect(mount({ contained: '', mode: 'inline' }).mode).toBe('window');
    const el = mount({ contained: '', mode: 'fullscreen' });
    expect(el.mode).toBe('window');
    expect($(el, '.main-head .modebtn').hidden).toBe(false);
    expect($(el, '.launcher')).toBeTruthy();
  });
});

const input = (el: any) => $(el, '.composer textarea') as HTMLTextAreaElement;
const go = (el: any) => $(el, '.composer .go') as HTMLButtonElement;
const chips = (el: any) => [...el.shadowRoot.querySelectorAll('.thread .chip')] as HTMLButtonElement[];

describe('the input, in a preview', () => {
  it('is off by default: the input and send disabled, the placeholder saying so, and nothing sent', async () => {
    const provider = stub();
    const el = mount({ contained: '', 'auto-open': '' }, provider);
    expect(el.allowInput).toBe(false);
    expect(input(el).disabled).toBe(true);
    expect(input(el).placeholder).toBe('Preview only: messages are off');
    expect(go(el).disabled).toBe(true);
    expect(css(el)).toContain('.composer .go:disabled { opacity: .45; cursor: not-allowed; }');
    // Even if text gets there, and send is pressed or Enter typed, nothing is sent.
    input(el).value = 'Hello?';
    go(el).click();
    input(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(el.shadowRoot.querySelectorAll('.thread .msg').length).toBe(0);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('draws the suggestion chips as a visitor sees them, inert', async () => {
    const provider = stub();
    const el = mount({ contained: '', 'auto-open': '' }, provider);
    const page = mount({ 'auto-open': '', discover: 'false' });
    expect(chips(el).map((c) => c.textContent)).toEqual(chips(page).map((c) => c.textContent));
    expect(chips(el).length).toBeGreaterThan(0);
    for (const c of chips(el)) {
      expect(c.className).toBe('chip');
      expect(c.getAttribute('aria-disabled')).toBe('true');
      expect(c.tabIndex).toBe(-1);
      c.click();
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(el.shadowRoot.querySelectorAll('.thread .msg').length).toBe(0);
    expect(provider.complete).not.toHaveBeenCalled();
    // Nor does a press fill the disabled input.
    expect(input(el).value).toBe('');
    // Their hover keeps the resting look, rather than inviting a press.
    expect(css(el)).toContain('.chip[aria-disabled]:hover { border-color: var(--border-strong); color: var(--ink-2); background: var(--bg); }');
  });

  it('leaves the header, the launcher and opening and closing working', () => {
    const el = mount({ contained: '', 'auto-open': '' });
    $(el, '.main-head .menu').click();
    expect($(el, '.overlay').classList.contains('nav')).toBe(true);
    $(el, '.scrim').click();
    $(el, '.main-head .modebtn').click();
    expect(el.mode).toBe('fullscreen');
    $(el, '.main-head .modebtn').click();
    $(el, '.main-head .close').click();
    expect(shown(el)).toBe(false);
    $(el, '.launcher').click();
    expect(shown(el)).toBe(true);
  });

  it('comes back with allow-input, as the attribute or the property', async () => {
    const provider = stub();
    const el = mount({ contained: '', 'auto-open': '' }, provider);
    el.allowInput = true;
    expect(el.hasAttribute('allow-input')).toBe(true);
    expect(input(el).disabled).toBe(false);
    expect(input(el).placeholder).toBe('Message the agent…');
    expect(go(el).disabled).toBe(false);
    expect(chips(el)[0].hasAttribute('aria-disabled')).toBe(false);
    chips(el)[0].click();
    await vi.waitFor(() => expect(answered(el)).toBe(true));
    el.allowInput = false;
    expect(input(el).disabled).toBe(true);

    const attr = mount({ contained: '', 'allow-input': '' });
    expect(attr.allowInput).toBe(true);
    expect(input(attr).disabled).toBe(false);
  });
});

describe('contained fetches nothing', () => {
  it('makes no request on connect, open, expand, close, or a turn with a stub provider', async () => {
    const provider = stub();
    const el = mount({ contained: '', 'auto-open': '', 'allow-input': '' }, provider);
    expect(el.preload).toBe('none');
    $(el, '.main-head .modebtn').click();
    $(el, '.main-head .modebtn').click();
    $(el, '.main-head .close').click();
    $(el, '.launcher').click();
    const input = $(el, '.composer textarea') as HTMLTextAreaElement;
    input.value = 'Hello?';
    $(el, '.composer .go').click();
    await vi.waitFor(() => expect(answered(el)).toBe(true));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('implies discover="false", site-actions="false" and preload="none" whatever the attributes say', async () => {
    const el = mount({ contained: '', discover: 'true', 'site-actions': 'true', preload: 'eager', 'auto-open': '' });
    expect(el.preload).toBe('none');
    el.preload = 'eager';
    expect(el.preload).toBe('none');
    await el._connectTools();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never starts the on-device model without a provider from the host', () => {
    const el = mount({ contained: '' }, null);
    const load = vi.spyOn(el.provider, 'load');
    const preload = vi.spyOn(el.provider, 'preload');
    $(el, '.launcher').click();
    expect(shown(el)).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(preload).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads the provider the host supplied on open', () => {
    const provider = stub();
    mount({ contained: '', 'auto-open': '' }, provider);
    expect(provider.load).toHaveBeenCalled();
  });

  it("neither reads nor writes the page's saved conversations, even with messages on", async () => {
    localStorage.setItem(CONV_KEY, JSON.stringify([{ id: 'c1', title: 'Old', messages: [{ role: 'user', content: 'from a visitor' }], items: [] }]));
    const keysBefore = Object.keys(localStorage).sort();
    const before = localStorage.getItem(CONV_KEY);
    const el = mount({ contained: '', 'auto-open': '', 'allow-input': '' });
    expect(el.shadowRoot.querySelector('.history').textContent).not.toContain('Old');
    const input = $(el, '.composer textarea') as HTMLTextAreaElement;
    input.value = 'Hello?';
    $(el, '.composer .go').click();
    await vi.waitFor(() => expect(answered(el)).toBe(true));
    expect(localStorage.getItem(CONV_KEY)).toBe(before);
    expect(Object.keys(localStorage).sort()).toEqual(keysBefore);
  });
});

describe('the other modes are unchanged', () => {
  // The first element in this file to open outside contained: discovery connects once per registry, so later
  // ones would reuse this connection and fetch nothing.
  it('window: fixed to the viewport, no contained class, the toggle remembered, discovery run on open', async () => {
    const el = mount({});
    const ov = $(el, '.overlay');
    expect(el.mode).toBe('window');
    expect(ov.classList.contains('window')).toBe(true);
    expect(ov.classList.contains('contained')).toBe(false);
    expect(css(el)).toMatch(/\.overlay \{ position: fixed; inset: 0; z-index: 9999;/);
    el.open();
    $(el, '.main-head .modebtn').click();
    expect(localStorage.getItem('nxis-agent:mode')).toBe('fullscreen');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled(), { timeout: 8000 });
  }, 10_000);

  it('window: the toggle is still hidden below 520px, and the preload attribute still applies', () => {
    narrow = true;
    const el = mount({ preload: 'eager' });
    expect($(el, '.main-head .modebtn').hidden).toBe(true);
    expect(el.preload).toBe('eager');
  });

  it('fullscreen and inline keep their shapes', () => {
    const full = mount({ mode: 'fullscreen' });
    expect(full.mode).toBe('fullscreen');
    expect($(full, '.overlay').classList.contains('window')).toBe(false);
    expect($(full, '.overlay').classList.contains('contained')).toBe(false);
    const inline = mount({ mode: 'inline' });
    expect(inline.mode).toBe('inline');
    expect($(inline, '.overlay').classList.contains('inline')).toBe(true);
    expect(shown(inline)).toBe(true);
    expect($(inline, '.main-head .modebtn').hidden).toBe(true);
  });

  it('the input and chips stay on in window, fullscreen and inline, allow-input or not', () => {
    for (const attrs of [{}, { mode: 'fullscreen' }, { mode: 'inline' }, { 'allow-input': '' }]) {
      const el = mount({ ...attrs, 'auto-open': '', discover: 'false' });
      expect(input(el).disabled).toBe(false);
      expect(input(el).placeholder).toBe('Message the agent…');
      expect(go(el).disabled).toBe(false);
      expect(chips(el).every((c) => !c.hasAttribute('aria-disabled') && !c.hasAttribute('tabindex'))).toBe(true);
    }
  });

  it('window: conversations are still saved', async () => {
    const el = mount({ 'auto-open': '', discover: 'false' });
    const input = $(el, '.composer textarea') as HTMLTextAreaElement;
    input.value = 'Hello?';
    $(el, '.composer .go').click();
    await vi.waitFor(() => expect(localStorage.getItem(CONV_KEY)).toContain('Hello?'));
  });
});

describe('open(), close(), isOpen and nxis-agent-toggle', () => {
  /** Mounts with a listener already on, so an open on connect is heard too. */
  function watched(attrs: Record<string, string>): { el: any; seen: boolean[] } {
    const seen: boolean[] = [];
    const el = document.createElement('nxis-agent') as any;
    for (const [k, v] of Object.entries({ discover: 'false', ...attrs })) el.setAttribute(k, v);
    el.modelProvider = stub();
    el.addEventListener('nxis-agent-toggle', (e: CustomEvent) => {
      expect(e.bubbles).toBe(true);
      expect(e.composed).toBe(true);
      seen.push(e.detail.open);
    });
    const box = document.createElement('div');
    box.append(el);
    document.body.append(box);
    return { el, seen };
  }

  for (const attrs of [{ contained: '' }, {}, { mode: 'fullscreen' }]) {
    const name = JSON.stringify(attrs);
    it(`fires once per change from every path, and isOpen follows (${name})`, () => {
      const { el, seen } = watched(attrs);
      expect(el.isOpen).toBe(false);
      expect(seen).toEqual([]);
      $(el, '.launcher').click();
      expect(seen).toEqual([true]);
      expect(el.isOpen).toBe(true);
      $(el, '.main-head .close').click();
      expect(seen).toEqual([true, false]);
      expect(el.isOpen).toBe(false);
      el.open();
      expect(seen).toEqual([true, false, true]);
      expect(el.isOpen).toBe(true);
      el.open();
      expect(seen).toEqual([true, false, true]);
      el.close();
      expect(seen).toEqual([true, false, true, false]);
      expect(el.isOpen).toBe(false);
      el.close();
      expect(seen).toEqual([true, false, true, false]);
      // Expanding and shrinking changes the shape, not whether it is open.
      el.open();
      $(el, '.main-head .modebtn').click();
      $(el, '.main-head .modebtn').click();
      expect(seen).toEqual([true, false, true, false, true]);
      // Escape stops a turn and closes the drawer; it never closes the window.
      $(el, '.overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(el.isOpen).toBe(true);
      expect(seen).toEqual([true, false, true, false, true]);
    });

    it(`fires once for auto-open (${name})`, () => {
      const { el, seen } = watched({ ...attrs, 'auto-open': '' });
      expect(seen).toEqual([true]);
      expect(el.isOpen).toBe(true);
    });
  }

  it('close() is the close button: the same state, and focus from inside the agent to the launcher', () => {
    const el = mount({ contained: '', 'allow-input': '' });
    el.open();
    expect(el.shadowRoot.activeElement).toBe(input(el));
    el.close();
    expect(shown(el)).toBe(false);
    expect(el.shadowRoot.activeElement).toBe($(el, '.launcher'));
  });

  it("close() leaves focus elsewhere on the page where it is", () => {
    const el = mount({ contained: '', 'auto-open': '' });
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    el.close();
    expect(document.activeElement).toBe(outside);
  });

  it('inline: open on connect fires once, and close() and open() work there too', () => {
    const { el, seen } = watched({ mode: 'inline' });
    expect(seen).toEqual([true]);
    expect(el.isOpen).toBe(true);
    el.close();
    expect(el.isOpen).toBe(false);
    el.open();
    expect(seen).toEqual([true, false, true]);
  });
});
