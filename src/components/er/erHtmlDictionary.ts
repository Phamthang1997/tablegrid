// A database's schema as ONE self-contained HTML page: a searchable data dictionary to send to a
// colleague or drop on an internal wiki. The sibling of erDocExport.ts (Markdown), built from the
// same inputs.
//
// Three decisions shape it:
//  - Self-contained and offline. The CSS and the script are inlined and nothing is fetched, so the
//    file opens from an email attachment, a file share or a wiki upload exactly as it was written.
//    That is also why there is no diagram: Mermaid would have to be loaded from a CDN.
//  - Rendered here, not by the page's script. Every table is static, escaped HTML; the script only
//    filters and highlights. Without JavaScript (some wikis strip it) the page is still complete,
//    printable, and Ctrl+F still finds everything.
//  - Everything from the database is ESCAPED. A column comment is text anyone with DDL rights
//    wrote, and this page is meant to be opened by other people — a comment reading `<script>`
//    must not become one. The script reads only `data-s` attributes, which are escaped too.
//
// Pure, like erDocExport: no `t` (labels come in translated), no DOM, no IPC.

import type { ERRelationship, ERTable } from './erTypes';
import { headingSlug, type ErDocIndex, type ErDocLabels } from './erDocExport';
// The page's own stylesheet, inlined into the file it writes (see the header of the .css file).
import PAGE_CSS from './erHtmlDictionary.page.css?raw';

/** The words the Markdown document uses, plus the page's own controls. */
export interface ErHtmlLabels extends ErDocLabels {
  /** Placeholder of the search box. */
  search: string;
  /** Shown when nothing matches the search. */
  noMatches: string;
  /** "n of total tables" under the search box. */
  shown: (n: number, total: number) => string;
  /** The three kind filters. */
  all: string;
  tables: string;
  views: string;
  /** Heading of a table's column list. */
  columns: string;
  /** Tooltip of the light/dark switch. */
  theme: string;
}

/** Text for an HTML text node or a quoted attribute. */
export function escapeHtml(text: string | number | null | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** What the search matches against, lower-cased once here instead of on every keystroke. */
function searchText(...parts: (string | undefined | null)[]): string {
  return escapeHtml(parts.filter(Boolean).join(' ').toLowerCase());
}

export function exportToHtmlDictionary(
  tables: ERTable[],
  relationships: ERRelationship[],
  labels: ErHtmlLabels,
  /** Indexes per table name, as for the Markdown document. */
  indexes?: Record<string, ErDocIndex[]>,
  /** The page's `lang`, so screen readers and hyphenation follow the language it is written in. */
  lang = 'en',
): string {
  const L = labels;
  const byName = new Map(tables.map((tb) => [tb.name, tb]));
  const rels = relationships.filter((r) => byName.has(r.sourceTable) && byName.has(r.targetTable));
  const constraints = new Set(rels.map((r) => `${r.sourceTable}\u0000${r.targetTable}\u0000${r.name ?? r.sourceColumn}`));

  const slugs = new Map<string, number>();
  const anchor = new Map(tables.map((tb) => [tb.name, `t-${headingSlug(tb.name, slugs) || 'table'}`]));
  const link = (name: string, text: string) =>
    byName.has(name) ? `<a href="#${escapeHtml(anchor.get(name))}">${escapeHtml(text)}</a>` : escapeHtml(text);

  const nav: string[] = [];
  const sections: string[] = [];

  for (const tb of tables) {
    const id = anchor.get(tb.name)!;
    const kind = tb.kind === 'view' ? 'view' : 'table';
    nav.push(
      `<li data-for="${escapeHtml(id)}"><a href="#${escapeHtml(id)}">` +
        `<span class="k k-${kind}"></span><span class="n">${escapeHtml(tb.name)}</span>` +
        `<span class="c">${tb.columns.length}</span></a></li>`,
    );

    const rows = tb.columns.map((col) => {
      const key = [col.isPrimaryKey && '<span class="pill pk">PK</span>', col.isForeignKey && '<span class="pill fk">FK</span>']
        .filter(Boolean)
        .join(' ');
      const ref = col.refTable ? `${link(col.refTable, col.refTable)}.${escapeHtml(col.refColumn ?? '')}` : '';
      const nullable = col.nullable == null ? '' : col.nullable ? L.yes : L.no;
      const s = searchText(col.name, col.type, col.comment, col.refTable);
      return (
        `<tr data-s="${s}"><td class="mono">${escapeHtml(col.name)}</td>` +
        `<td class="mono t">${escapeHtml(col.type)}</td><td>${escapeHtml(nullable)}</td>` +
        `<td>${key}</td><td class="mono">${ref}</td><td>${escapeHtml(col.comment)}</td></tr>`
      );
    });

    const parts: string[] = [];
    parts.push(
      `<section id="${escapeHtml(id)}" data-kind="${kind}" data-s="${searchText(tb.name, tb.schema, tb.comment)}">`,
      `<h2><span class="k k-${kind}"></span>${escapeHtml(tb.name)}` +
        (tb.kind === 'view' ? ` <span class="tag">${escapeHtml(L.view)}</span>` : '') +
        `<a class="self" href="#${escapeHtml(id)}" aria-label="#">#</a></h2>`,
    );
    const meta: string[] = [];
    if (tb.schema) meta.push(`<span class="mono">${escapeHtml(tb.schema)}</span>`);
    if (tb.rowCount != null) meta.push(`${escapeHtml(L.rows)}: ~${escapeHtml(tb.rowCount.toLocaleString('en-US'))}`);
    meta.push(`${escapeHtml(L.columns)}: ${tb.columns.length}`);
    parts.push(`<div class="meta">${meta.join(' · ')}</div>`);
    if (tb.comment) parts.push(`<p class="note">${escapeHtml(tb.comment)}</p>`);

    parts.push(
      '<div class="scroll"><table><thead><tr>' +
        [L.column, L.type, L.nullable, L.key, L.references, L.comment].map((h) => `<th>${escapeHtml(h)}</th>`).join('') +
        `</tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
    );

    const idx = indexes?.[tb.name];
    if (idx) {
      const items = idx.map(
        (ix) =>
          `<li><span class="mono">${escapeHtml(ix.name)}</span> (` +
          ix.columns
            .split(',')
            .map((c) => `<span class="mono">${escapeHtml(c.trim())}</span>`)
            .join(', ') +
          `)${ix.unique ? ` <span class="pill uq">${escapeHtml(L.unique)}</span>` : ''}</li>`,
      );
      parts.push(
        `<h3>${escapeHtml(L.indexes)}</h3>` + (items.length ? `<ul>${items.join('')}</ul>` : `<p class="none">${escapeHtml(L.none)}</p>`),
      );
    }

    const seen = new Set<string>();
    const refs: string[] = [];
    for (const r of rels) {
      if (r.targetTable !== tb.name) continue;
      const k = `${r.sourceTable}\u0000${r.name ?? r.sourceColumn}`;
      if (seen.has(k)) continue;
      seen.add(k);
      refs.push(
        `<li>${link(r.sourceTable, r.sourceTable)}.<span class="mono">${escapeHtml(r.sourceColumn)}</span>` +
          (r.name ? ` <span class="dim">(${escapeHtml(r.name)})</span>` : '') +
          '</li>',
      );
    }
    parts.push(
      `<h3>${escapeHtml(L.referencedBy)}</h3>` + (refs.length ? `<ul>${refs.join('')}</ul>` : `<p class="none">${escapeHtml(L.none)}</p>`),
    );
    parts.push('</section>');
    sections.push(parts.join('\n'));
  }

  const hasViews = tables.some((tb) => tb.kind === 'view');
  const filters = hasViews
    ? `<div class="kinds" role="group">` +
      `<button type="button" data-kind="" class="on">${escapeHtml(L.all)}</button>` +
      `<button type="button" data-kind="table">${escapeHtml(L.tables)}</button>` +
      `<button type="button" data-kind="view">${escapeHtml(L.views)}</button></div>`
    : '';

  // The count line's two words are filled by the script from this template, so the page never
  // builds a sentence of its own in one language.
  const shownTemplate = L.shown(-1, -2);

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="TableGrid">
<title>${escapeHtml(L.title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<aside>
  <div class="head">
    <input id="q" type="search" placeholder="${escapeHtml(L.search)}" autocomplete="off" spellcheck="false">
    ${filters}
    <div id="count" class="dim" data-template="${escapeHtml(shownTemplate)}">${escapeHtml(L.shown(tables.length, tables.length))}</div>
  </div>
  <ul id="nav">${nav.join('')}</ul>
</aside>
<main>
  <header>
    <div>
      <h1>${escapeHtml(L.title)}</h1>
      <p class="dim">${escapeHtml(L.generated(tables.length, constraints.size))}</p>
    </div>
    <button type="button" id="theme" title="${escapeHtml(L.theme)}" aria-label="${escapeHtml(L.theme)}">&#9680;</button>
  </header>
  <p id="empty" class="none" hidden>${escapeHtml(L.noMatches)}</p>
  ${sections.join('\n')}
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}


// Plain ES5-ish script: the page has to work in whatever browser opens an attachment. It reads the
// escaped `data-s` attributes only; nothing it writes is taken from the data as HTML.
const PAGE_SCRIPT = `
(function(){
  var q=document.getElementById('q'),count=document.getElementById('count'),empty=document.getElementById('empty');
  var sections=[].slice.call(document.querySelectorAll('main section'));
  var navItems={};[].forEach.call(document.querySelectorAll('#nav li'),function(li){navItems[li.getAttribute('data-for')]=li;});
  var kind='';var tpl=count.getAttribute('data-template');
  function apply(){
    var terms=q.value.toLowerCase().split(/\\s+/).filter(Boolean),shown=0;
    sections.forEach(function(sec){
      var okKind=!kind||sec.getAttribute('data-kind')===kind;
      var own=sec.getAttribute('data-s'),rows=[].slice.call(sec.querySelectorAll('tbody tr')),any=false,tableHit=true;
      for(var i=0;i<terms.length;i++){if(own.indexOf(terms[i])<0){tableHit=false;break;}}
      rows.forEach(function(tr){
        var s=tr.getAttribute('data-s'),hit=terms.length>0;
        for(var j=0;j<terms.length;j++){if(s.indexOf(terms[j])<0&&own.indexOf(terms[j])<0){hit=false;break;}}
        if(hit&&!tableHit)any=true;
        tr.className=terms.length&&!tableHit?(hit?'hit':'miss'):'';
      });
      var show=okKind&&(!terms.length||tableHit||any);
      sec.hidden=!show;var li=navItems[sec.id];if(li)li.hidden=!show;
      if(show)shown++;
    });
    count.textContent=tpl.replace('-1',shown).replace('-2',sections.length);
    empty.hidden=shown>0;
  }
  q.addEventListener('input',apply);
  q.addEventListener('keydown',function(e){if(e.key==='Escape'){q.value='';apply();}});
  document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement!==q){e.preventDefault();q.focus();}});
  [].forEach.call(document.querySelectorAll('.kinds button'),function(b){
    b.addEventListener('click',function(){kind=b.getAttribute('data-kind');
      [].forEach.call(document.querySelectorAll('.kinds button'),function(x){x.className=x===b?'on':'';});apply();});
  });
  // Follows the OS theme; the button flips it for this viewing only (a file opened from disk has an
  // origin shared with every other local file, so it keeps nothing).
  var root=document.documentElement;
  document.getElementById('theme').addEventListener('click',function(){
    var dark=root.getAttribute('data-theme')?root.getAttribute('data-theme')==='dark':matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme',dark?'light':'dark');
  });
})();
`;
