// @vitest-environment happy-dom
/**
 * The thread is a column flex box that scrolls. What is in it never shrinks to fit: an answer with a Sources list
 * (`overflow: hidden`, so no content-sized minimum) shrank to a 20px sliver of a 600px reply in a real test run.
 * happy-dom does no layout, so this reads the rules; the real boxes are measured in Chromium when the cards are
 * rendered for review.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/ui/agent';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const css = (el: any): string => [...el.shadowRoot.querySelectorAll('style')].map((s: HTMLStyleElement) => s.textContent).join('\n');

describe('the thread', () => {
  it('scrolls, and never shrinks what is in it', () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
    const el = document.createElement('nxis-agent') as any;
    el.setAttribute('preload', 'none');
    el.setAttribute('discover', 'false');
    document.body.append(el);
    const all = css(el);
    expect(all).toMatch(/\.thread \{[^}]*overflow-y: auto[^}]*flex-direction: column/);
    expect(all).toMatch(/\.thread > \* \{\s*flex-shrink: 0;\s*\}/);
    // Nothing gives a thread child a shrink back.
    expect(all).not.toMatch(/\.msg[^{]*\{[^}]*flex-shrink: 1/);
    expect(all).not.toMatch(/\.msg[^{]*\{[^}]*flex: 1 1/);
  });
});
