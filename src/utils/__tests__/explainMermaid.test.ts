import { describe, expect, it } from 'vitest';
import { explainToMermaid, type ExplainMermaidLabels } from '../explainMermaid';
import type { ExplainNode } from '../explainHelper';

const labels: ExplainMermaidLabels = {
  flagLabel: (f) => `flag:${f}`,
  cost: 'Cost',
  rows: 'rows',
  locale: 'en-US',
};

const plan: ExplainNode = {
  id: 'root',
  type: 'Hash Join',
  cost: { start: 0, total: 1234.5 },
  selfCost: 30,
  children: [
    {
      id: 'a',
      type: 'Seq Scan',
      table: 'film',
      cost: { start: 0, total: 64 },
      selfCost: 60,
      rowsOut: 1000,
      flags: ['fullTableScan'],
    },
    {
      id: 'b',
      type: 'Index Scan',
      table: 'film_actor',
      indexName: 'idx_film_id',
      selfCost: 10,
      rowsOut: 5462,
    },
  ],
};

describe('explainToMermaid', () => {
  const out = explainToMermaid(plan, 100, labels);

  it('draws leaves below the root, each arrow labelled with the rows it hands up', () => {
    expect(out.split('\n')[0]).toBe('flowchart BT');
    expect(out).toContain('n1 -->|"1,000 rows"| n0');
    expect(out).toContain('n2 -->|"5,462 rows"| n0');
  });

  it('labels each operator with its table, index, cost, share and flags', () => {
    expect(out).toContain('n0["Hash Join<br/>Cost 1,234.5 · 30%"]');
    expect(out).toContain('n1["Seq Scan on film<br/>Cost 64 · 60%<br/>flag:fullTableScan"]');
    expect(out).toContain('n2["Index Scan on film_actor<br/>index: idx_film_id<br/>10%"]');
  });

  it('colours the hot and warm operators like the diagram, and marks flagged ones', () => {
    expect(out).toContain('class n0,n1 hot');
    expect(out).not.toContain('class n2');
    expect(out).toContain('class n1 flagged');
  });

  it('escapes what would break a Mermaid label', () => {
    const odd = explainToMermaid(
      { id: 'x', type: 'Filter', table: 'a"b<c>', flags: [] },
      0,
      labels,
    );
    expect(odd).toContain('n0["Filter on a#quot;b#lt;c#gt;"]');
    // No cost total to divide by: no share, and no colour classes.
    expect(odd).not.toContain('%');
    expect(odd).not.toContain('classDef');
  });

  it('draws a plain arrow when the rows are unknown', () => {
    const o = explainToMermaid({ id: 'r', type: 'Limit', children: [{ id: 'c', type: 'Sort' }] }, 0, labels);
    expect(o).toContain('n1 --> n0');
  });
});
