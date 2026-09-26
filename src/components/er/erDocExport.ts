// A database's schema as a Markdown document — one section per table, each with its own small
// Mermaid ER diagram of the table and its direct neighbours. Meant to be pasted into a wiki, a
// README or a PR, where GitHub/GitLab/Notion render the diagrams.
//
// Pure, like the rest of erExportHelper: it takes what the ER view already holds (columns, keys,
// comments, row estimates, relationships) and no backend call. Indexes are therefore not in it —
// the ER catalog does not carry them.
//
// One diagram PER TABLE rather than one for the whole schema, because Mermaid refuses to render
// past its default limits (see MERMAID_MAX_TEXT/EDGES), and a 300-table diagram is unreadable
// anyway; the neighbourhood is what a reader of one section wants to see.

import type { ERRelationship, ERTable } from './erTypes';
import { exportToMermaid } from './erExportHelper';

/** Every word the document writes, already translated by the caller (this module has no `t`). */
export interface ErDocLabels {
  /** The document title, database name included. */
  title: string;
  /** The line under the title. */
  generated: (tables: number, relations: number) => string;
  contents: string;
  view: string;
  rows: string;
  column: string;
  type: string;
  nullable: string;
  key: string;
  references: string;
  comment: string;
  yes: string;
  no: string;
  referencedBy: string;
  none: string;
  /** Under a neighbourhood diagram cut down to `NEIGHBOURS_MAX` tables; n = how many were left out. */
  diagramTrimmed: (n: number) => string;
}

/** Tables beside the one a section is about, at most, in its diagram. */
export const NEIGHBOURS_MAX = 12;

/** A Markdown table cell: `|` would end the cell, and a newline the row. */
function cell(text: string | undefined | null): string {
  return (text ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * GitHub's heading anchor: lower-case, spaces to `-`, punctuation dropped (letters of any script,
 * digits, `-` and `_` kept), and `-1`, `-2`… for a repeat — so the contents links resolve there.
 */
export function headingSlug(text: string, used: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

export function exportToMarkdownDoc(
  tables: ERTable[],
  relationships: ERRelationship[],
  labels: ErDocLabels,
): string {
  const L = labels;
  const byName = new Map(tables.map((tb) => [tb.name, tb]));
  // Only relationships between documented tables, like the diagrams.
  const rels = relationships.filter((r) => byName.has(r.sourceTable) && byName.has(r.targetTable));
  const constraints = new Set(rels.map((r) => `${r.sourceTable}\u0000${r.targetTable}\u0000${r.name ?? r.sourceColumn}`));

  const slugs = new Map<string, number>();
  headingSlug(L.title, slugs);
  headingSlug(L.contents, slugs);
  const anchor = new Map(tables.map((tb) => [tb.name, headingSlug(tb.name, slugs)]));

  const out: string[] = [];
  out.push(`# ${L.title}`, '');
  out.push(`_${L.generated(tables.length, constraints.size)}_`, '');

  out.push(`## ${L.contents}`, '');
  for (const tb of tables) {
    const kind = tb.kind === 'view' ? ` _(${L.view})_` : '';
    const note = tb.comment ? ` — ${cell(tb.comment)}` : '';
    out.push(`- [${tb.name}](#${anchor.get(tb.name)})${kind}${note}`);
  }
  out.push('');

  for (const tb of tables) {
    out.push(`## ${tb.name}`, '');
    if (tb.kind === 'view') out.push(`_${L.view}_`, '');
    if (tb.comment) out.push(`> ${cell(tb.comment)}`, '');
    if (tb.rowCount != null) out.push(`${L.rows}: ~${tb.rowCount.toLocaleString('en-US')}`, '');

    out.push(`| ${L.column} | ${L.type} | ${L.nullable} | ${L.key} | ${L.references} | ${L.comment} |`);
    out.push('|---|---|---|---|---|---|');
    for (const col of tb.columns) {
      const key = [col.isPrimaryKey && 'PK', col.isForeignKey && 'FK'].filter(Boolean).join(', ');
      const ref = col.refTable
        ? byName.has(col.refTable)
          ? `[${col.refTable}](#${anchor.get(col.refTable)}).${col.refColumn ?? ''}`
          : `${col.refTable}.${col.refColumn ?? ''}`
        : '';
      const nullable = col.nullable == null ? '' : col.nullable ? L.yes : L.no;
      out.push(`| \`${cell(col.name)}\` | ${cell(col.type)} | ${nullable} | ${key} | ${cell(ref)} | ${cell(col.comment)} |`);
    }
    out.push('');

    const incoming = rels.filter((r) => r.targetTable === tb.name);
    const seen = new Set<string>();
    const refs: string[] = [];
    for (const r of incoming) {
      const k = `${r.sourceTable}\u0000${r.name ?? r.sourceColumn}`;
      if (seen.has(k)) continue;
      seen.add(k);
      refs.push(`[${r.sourceTable}](#${anchor.get(r.sourceTable)}).${r.sourceColumn}${r.name ? ` (${r.name})` : ''}`);
    }
    out.push(`**${L.referencedBy}:** ${refs.length ? refs.join(', ') : L.none}`, '');

    // The table and its direct neighbours, both directions.
    const neighbours: string[] = [];
    for (const r of rels) {
      const other = r.sourceTable === tb.name ? r.targetTable : r.targetTable === tb.name ? r.sourceTable : null;
      if (other && other !== tb.name && !neighbours.includes(other)) neighbours.push(other);
    }
    if (neighbours.length > 0) {
      const shown = neighbours.slice(0, NEIGHBOURS_MAX);
      const subset = [tb, ...shown.map((n) => byName.get(n)!)];
      out.push('```mermaid', exportToMermaid(subset, rels), '```', '');
      if (neighbours.length > shown.length) {
        out.push(`_${L.diagramTrimmed(neighbours.length - shown.length)}_`, '');
      }
    }
  }
  return out.join('\n');
}
