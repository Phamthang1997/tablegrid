// The small Markdown a notebook's note cells understand, parsed into a tree the component renders
// as React elements.
//
// Not a Markdown library, on purpose: the app has none, a notebook note is a heading, a sentence
// and a list far more often than anything else, and a tree rendered by React can never contain
// markup the user did not write — there is no HTML string anywhere, so nothing needs sanitising.
// Raw HTML in a note is shown as text.
//
// Supported: # headings, paragraphs, - / * / 1. lists, > quotes, ``` fences, ---, and inline
// `code`, **bold**, *italic* / _italic_, [text](url). A link is kept only for http(s) and mailto;
// anything else (javascript:, file:, a relative path) renders as its text.

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b'; c: MdInline[] }
  | { t: 'i'; c: MdInline[] }
  | { t: 'a'; href: string; c: MdInline[] };

export type MdBlock =
  | { t: 'h'; level: 1 | 2 | 3 | 4 | 5 | 6; c: MdInline[] }
  | { t: 'p'; c: MdInline[] }
  | { t: 'code'; v: string; lang: string }
  | { t: 'ul'; items: MdInline[][] }
  | { t: 'ol'; start: number; items: MdInline[][] }
  | { t: 'quote'; c: MdInline[] }
  | { t: 'hr' };

/** A link target worth following; anything else renders as plain text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length && /[\\`*_[\]()#>-]/.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((c === '*' || c === '_') && text[i + 1] === c) {
      const end = text.indexOf(c + c, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'b', c: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      // `_` inside a word (snake_case) is not emphasis — the common case in a SQL notebook.
      const wordBefore = c === '_' && /\w/.test(text[i - 1] ?? '');
      const end = text.indexOf(c, i + 1);
      if (!wordBefore && end > i + 1 && !(c === '_' && /\w/.test(text[end + 1] ?? ''))) {
        flush();
        out.push({ t: 'i', c: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = text.indexOf('](', i + 1);
      const end = close > 0 ? text.indexOf(')', close + 2) : -1;
      if (close > 0 && end > 0) {
        const label = parseInline(text.slice(i + 1, close));
        const href = safeHref(text.slice(close + 2, end));
        flush();
        if (href) out.push({ t: 'a', href, c: label });
        else out.push(...label);
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push({ t: 'p', c: parseInline(para.join(' ')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      out.push({ t: 'code', v: body.join('\n'), lang: fence[1] });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      out.push({ t: 'h', level: h[1].length as 1, c: parseInline(h[2]) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push({ t: 'hr' });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      out.push({ t: 'quote', c: parseInline(body.join(' ')) });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d{1,9})[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const items: MdInline[][] = [];
      const itemRe = ordered ? /^\s*\d{1,9}[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length) {
        const m = itemRe.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      i--;
      out.push(ordered ? { t: 'ol', start: Number(ol![1]), items } : { t: 'ul', items });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return out;
}
