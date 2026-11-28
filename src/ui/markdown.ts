/**
 * A safe markdown subset for replies: paragraphs, bold and italic, bulleted and numbered lists, inline code, headings
 * and links. Drawn in the page assistant's bubbles, a remote agent's replies, and A2UI `Text` (as the renderer's
 * markdown renderer, given through its Lit context).
 *
 * No raw HTML, ever: the text is read as markdown and only our own elements are built, every string set as text. A
 * link is drawn only as the caller's {@link MdOptions.link} makes it (an anchor when the page allows its address,
 * else the words as written), so the page's link rules and the guardrails' navigation check still apply.
 *
 * The element loads this with a dynamic `import()` the first time a reply has anything markdown would change, so a
 * page whose replies are plain sentences pays nothing for it. It imports nothing at run time.
 *
 * @module
 */

/** How links and headings are drawn. */
export interface MdOptions {
  /** A link's node: an anchor when the page allows `href`, else null, and the source is drawn as written. */
  link?: (label: string, href: string) => Node | null;
  /** `#` lines as headings (A2UI Text); in a bubble, a heading is a bold line. */
  headings?: boolean;
}

/** Styles for a bubble drawn as markdown, on the widget's tokens. */
export const MD_CSS = `
.msg.md { white-space: normal; }
.msg.md p, .msg.md ul, .msg.md ol { margin: 0 0 8px; }
.msg.md > :last-child, .msg.md li > :last-child { margin-bottom: 0; }
.msg.md ul, .msg.md ol { padding-left: 20px; }
.msg.md li { margin: 2px 0; }
.msg.md strong { font-weight: 600; }
.msg.md code { font-family: var(--mono, ui-monospace, monospace); font-size: .92em; padding: 1px 4px; border-radius: 4px; background: color-mix(in srgb, currentColor 8%, transparent); }
.msg.md pre code { padding: 0; background: none; }
`;

type Block = { kind: 'p' | 'h'; lines: string[]; level?: number } | { kind: 'ul' | 'ol'; items: string[]; start: number };

const ITEM = /^\s{0,6}([-*+•]|(\d{1,3})[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** The text's blocks: paragraphs, headings and lists. A list item's following indented lines are part of it. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  let open = null as Block | null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || RULE.test(line)) {
      open = null;
      continue;
    }
    const h = HEADING.exec(line);
    const item = ITEM.exec(line);
    if (h) {
      out.push({ kind: 'h', lines: [h[2]], level: h[1].length });
      open = null;
    } else if (item) {
      const kind = item[2] ? 'ol' : 'ul';
      if (open?.kind !== kind) out.push((open = { kind, items: [], start: item[2] ? Number(item[2]) : 1 }));
      (open as Extract<Block, { items: string[] }>).items.push(item[3]);
    } else if (open && (open.kind === 'ul' || open.kind === 'ol') && /^\s/.test(raw)) {
      open.items[open.items.length - 1] += `\n${line.trim()}`;
    } else {
      const quote = line.replace(/^\s{0,3}>\s?/, '');
      if (open?.kind === 'p') open.lines.push(quote);
      else out.push((open = { kind: 'p', lines: [quote] }));
    }
  }
  return out;
}

/** Code, bold, italic, a markdown link, a bare address. Underscores only between words' edges (`snake_case` stays). */
const INLINE = /(`+)([^`\n]+?)\1|\*\*(?=\S)([^\n]+?)\*\*|__(?=\S)([^\n]+?)__|\*(?=[^\s*])([^*\n]*?[^\s*])?\*|_(?=[^\s_])([^_\n]*?[^\s_])?_|\[([^\]\n]{1,300})\]\(([^()\s]{1,2048})\)|https?:\/\/[^\s<>"'`]+/g;

/** One line's inline markdown, appended to `into`. */
function inline(doc: Document, into: Node, text: string, opts: MdOptions): void {
  let last = 0;
  const words = (s: string) => s && into.appendChild(doc.createTextNode(s));
  const wrap = (tag: string, inner: string) => {
    const e = into.appendChild(doc.createElement(tag));
    inline(doc, e, inner, opts);
  };
  const all = [...text.matchAll(INLINE)];
  for (const m of all) {
    const at = m.index ?? 0;
    if (at < last) continue;
    let whole = m[0];
    const before = text[at - 1] ?? '';
    const after = text[at + whole.length] ?? '';
    // `_x_` inside a word (snake_case) is no italic.
    if (whole[0] === '_' && whole[1] !== '_' && (/\w/.test(before) || /\w/.test(after))) continue;
    words(text.slice(last, at));
    if (m[1]) into.appendChild(doc.createElement('code')).textContent = m[2];
    else if (m[3] !== undefined || m[4] !== undefined) wrap('strong', m[3] ?? m[4]);
    else if (whole[0] === '*' || whole[0] === '_') wrap('em', m[5] ?? m[6] ?? whole.slice(1, -1));
    else {
      let label = m[7];
      let href = m[8];
      if (!href) {
        // A bare address ends before the punctuation after it.
        whole = whole.replace(/[.,;:!?'")\]]+$/, '');
        label = href = whole;
      }
      const node = opts.link?.(label, href);
      if (node) into.appendChild(node);
      else words(whole);
    }
    last = at + whole.length;
  }
  words(text.slice(last));
}

/** Lines as inline content with a line break between them. */
function lines(doc: Document, into: Node, text: string, opts: MdOptions): void {
  text.split('\n').forEach((line, i) => {
    if (i) into.appendChild(doc.createElement('br')).after(doc.createTextNode('\n'));
    inline(doc, into, line, opts);
  });
}

/**
 * `text` as nodes. One plain paragraph is its inline content alone, so a short reply or a button's label stays inline.
 * Blocks are separated by a newline text node, so the text a bubble reads (`textContent`) keeps its lines.
 */
export function mdNodes(doc: Document, text: string, opts: MdOptions = {}): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const all = blocks(text);
  if (all.length === 1 && all[0].kind === 'p') {
    lines(doc, frag, all[0].lines.join('\n'), opts);
    return frag;
  }
  all.forEach((b, i) => {
    if (i) frag.append(doc.createTextNode('\n'));
    if (b.kind === 'ul' || b.kind === 'ol') {
      const list = frag.appendChild(doc.createElement(b.kind));
      if (b.kind === 'ol' && b.start !== 1) list.setAttribute('start', String(b.start));
      b.items.forEach((item, k) => {
        if (k) list.append(doc.createTextNode('\n'));
        lines(doc, list.appendChild(doc.createElement('li')), item, opts);
      });
    } else if (b.kind === 'h') {
      const e = opts.headings ? doc.createElement(`h${Math.min(5, b.level ?? 1)}`) : doc.createElement('p').appendChild(doc.createElement('strong'));
      inline(doc, e, b.lines[0], opts);
      frag.append(opts.headings ? e : e.parentNode!);
    } else {
      lines(doc, frag.appendChild(doc.createElement('p')), (b as { lines: string[] }).lines.join('\n'), opts);
    }
  });
  return frag;
}

/** `text` as HTML for A2UI's markdown renderer: built from our own elements, so every string in it is escaped. */
export function mdHtml(text: string, opts: MdOptions = {}): string {
  const box = document.createElement('div');
  box.append(mdNodes(document, text, { headings: true, ...opts }));
  return box.innerHTML;
}

/** Append `text` to a bubble as markdown, with the bubble's markdown styles in its root once. */
export function mdFill(el: HTMLElement, text: string, opts: MdOptions = {}): void {
  const doc = el.ownerDocument;
  const root = el.getRootNode();
  const styles = root instanceof ShadowRoot ? root : doc.head;
  if (!styles.querySelector('style[data-md]')) {
    const style = doc.createElement('style');
    style.dataset.md = '';
    style.textContent = MD_CSS;
    styles.append(style);
  }
  el.classList.add('md');
  el.append(mdNodes(doc, text.replace(/^\n+|\n+$/g, ''), opts));
}
