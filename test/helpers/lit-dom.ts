/**
 * What the A2UI renderer needs of jsdom: `document.adoptedStyleSheets`, which the basic catalog adds its styles to.
 * The step surfaces' tests run under jsdom, not happy-dom, because happy-dom draws Lit's static templates (the
 * renderer's `<${tag}>`) as nothing.
 */
if (typeof document !== 'undefined' && !(document as any).adoptedStyleSheets) {
  Object.defineProperty(document, 'adoptedStyleSheets', { value: [], writable: true, configurable: true });
}

/** The first element matching `sel` under `root`, through every shadow root. */
export function deep<T extends Element = HTMLElement>(root: Element | ShadowRoot | Document, sel: string): T | null {
  return deepAll<T>(root, sel)[0] ?? null;
}

/**
 * Every element matching `sel` under `root`, through every shadow root, in document order. A selector that starts
 * with a step component's tag (`nxis-step-daystrip button.opt`) is looked for inside that component's shadow root.
 */
export function deepAll<T extends Element = HTMLElement>(root: Element | ShadowRoot | Document, sel: string): T[] {
  const m = /^(nxis-step-[a-z]+)\s+(.+)$/.exec(sel);
  if (m) return deepAll(root, m[1]).flatMap((host) => (host.shadowRoot ? deepAll<T>(host.shadowRoot, m[2]) : []));
  const out: T[] = [];
  const walk = (n: Element | ShadowRoot | Document) => {
    if ((n as Element).shadowRoot) walk((n as Element).shadowRoot!);
    for (const el of n.querySelectorAll('*')) {
      if (el.matches(sel)) out.push(el as T);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (ok: () => unknown, tries = 200) => {
  for (let i = 0; i < tries && !ok(); i++) await sleep(5);
};
