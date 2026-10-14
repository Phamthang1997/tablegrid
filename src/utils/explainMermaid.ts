// An EXPLAIN plan as a Mermaid flowchart — text to paste into a ticket, a PR or a wiki, where
// Mermaid renders it. Pure (no monaco, no Tauri), so it is tested like the other plan helpers.
//
// The shape mirrors the diagram on screen, turned upright: leaves at the bottom, the consuming
// SELECT at the top (`flowchart BT`), each arrow labelled with the rows the child hands up
// (`edgeRows`, measured when there is a measurement). Node colour says what the % badge says.

import { edgeRows, flagSeverity, type ExplainFlag, type ExplainNode } from './explainHelper';

export interface ExplainMermaidLabels {
  /** Translated flag name — the same labels the diagram's chips use. */
  flagLabel: (flag: ExplainFlag) => string;
  cost: string;
  rows: string;
  locale: string;
}

/** A self-cost share at or above this is "hot", matching the diagram's red badge. */
const HOT_PCT = 25;
/** …and this is "warm", its amber badge. */
const WARM_PCT = 15;

/**
 * Text inside a Mermaid `["…"]` label or `|"…"|` edge label. Mermaid has no backslash escape;
 * it takes HTML-style entity codes instead, and `<`/`>` would otherwise be read as markup.
 */
function label(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}

function num(n: number, locale: string, digits = 0): string {
  return n.toLocaleString(locale, { maximumFractionDigits: digits });
}

export function explainToMermaid(
  root: ExplainNode,
  totalSelfCost: number,
  labels: ExplainMermaidLabels,
): string {
  const lines: string[] = ['flowchart BT'];
  const edges: string[] = [];
  const hot: string[] = [];
  const warm: string[] = [];
  const flagged: string[] = [];
  let seq = 0;

  const visit = (node: ExplainNode): string => {
    const id = `n${seq++}`;
    const head = [node.type, node.table ? `on ${node.table}` : ''].filter(Boolean).join(' ');
    const parts = [label(head)];
    if (node.indexName) parts.push(label(`index: ${node.indexName}`));

    const pct = totalSelfCost > 0 && node.selfCost != null ? (node.selfCost / totalSelfCost) * 100 : null;
    const stats: string[] = [];
    if (node.cost) stats.push(`${labels.cost} ${num(node.cost.total, labels.locale, 2)}`);
    if (pct != null) stats.push(`${num(pct, labels.locale, 1)}%`);
    if (stats.length) parts.push(label(stats.join(' · ')));

    const flags = node.flags ?? [];
    if (flags.length) parts.push(label(flags.map(labels.flagLabel).join(', ')));

    lines.push(`    ${id}["${parts.join('<br/>')}"]`);
    if (pct != null && pct >= HOT_PCT) hot.push(id);
    else if (pct != null && pct >= WARM_PCT) warm.push(id);
    if (flagSeverity(flags) === 'danger' || flagSeverity(flags) === 'warn') flagged.push(id);

    for (const child of node.children ?? []) {
      const childId = visit(child);
      const rows = edgeRows(child);
      edges.push(
        rows != null
          ? `    ${childId} -->|"${label(`${num(rows, labels.locale)} ${labels.rows}`)}"| ${id}`
          : `    ${childId} --> ${id}`,
      );
    }
    return id;
  };

  visit(root);
  lines.push(...edges);

  // Literal colours on purpose: this text is rendered by GitHub/Notion/mermaid.live, where the
  // app's theme tokens do not exist.
  if (hot.length) lines.push('    classDef hot fill:#fee2e2,stroke:#dc2626,color:#7f1d1d', `    class ${hot.join(',')} hot`);
  if (warm.length) lines.push('    classDef warm fill:#fef3c7,stroke:#d97706,color:#78350f', `    class ${warm.join(',')} warm`);
  if (flagged.length) lines.push('    classDef flagged stroke-dasharray:4 3,stroke-width:2px', `    class ${flagged.join(',')} flagged`);
  return lines.join('\n');
}
