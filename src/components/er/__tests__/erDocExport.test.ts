import { describe, expect, it } from 'vitest';
import { exportToMarkdownDoc, headingSlug, NEIGHBOURS_MAX, type ErDocLabels } from '../erDocExport';
import type { ERColumn, ERRelationship, ERTable } from '../erTypes';

const labels: ErDocLabels = {
  title: 'sakila — schema',
  generated: (tables, relations) => `Generated · ${tables} tables, ${relations} relationships`,
  contents: 'Contents',
  view: 'view',
  rows: 'Rows',
  column: 'Column',
  type: 'Type',
  nullable: 'Null',
  key: 'Key',
  references: 'References',
  comment: 'Comment',
  yes: 'yes',
  no: 'no',
  referencedBy: 'Referenced by',
  indexes: 'Indexes',
  unique: 'unique',
  none: 'none',
  diagramTrimmed: (n) => `${n} more not shown`,
};

const col = (name: string, over: Partial<ERColumn> = {}): ERColumn => ({
  name,
  type: 'int',
  isPrimaryKey: false,
  isForeignKey: false,
  ...over,
});

const tables: ERTable[] = [
  {
    id: 'customer',
    name: 'customer',
    comment: 'Who pays | who rents',
    rowCount: 599,
    columns: [
      col('customer_id', { isPrimaryKey: true, nullable: false }),
      col('store_id', { isForeignKey: true, refTable: 'store', refColumn: 'store_id', nullable: false }),
      col('email', { type: 'varchar(50)', nullable: true, comment: 'may be\nempty' }),
    ],
  },
  { id: 'store', name: 'store', columns: [col('store_id', { isPrimaryKey: true, nullable: false })] },
  { id: 'lonely', name: 'lonely', kind: 'view', columns: [col('x')] },
];
const rels: ERRelationship[] = [
  { id: 'r1', name: 'fk_customer_store', sourceTable: 'customer', sourceColumn: 'store_id', targetTable: 'store', targetColumn: 'store_id' },
  // To a table outside the export: left out of counts, references and diagrams.
  { id: 'r2', name: 'fk_x', sourceTable: 'customer', sourceColumn: 'store_id', targetTable: 'hidden', targetColumn: 'id' },
];

describe('exportToMarkdownDoc', () => {
  const doc = exportToMarkdownDoc(tables, rels, labels);

  it('opens with the title, the counts and a contents list linking to each section', () => {
    expect(doc.startsWith('# sakila — schema\n')).toBe(true);
    expect(doc).toContain('_Generated · 3 tables, 1 relationships_');
    expect(doc).toContain('- [customer](#customer) — Who pays \\| who rents');
    expect(doc).toContain('- [lonely](#lonely) _(view)_');
  });

  it('writes one row per column, escaping what would break the table', () => {
    expect(doc).toContain('| Column | Type | Null | Key | References | Comment |');
    expect(doc).toContain('| `store_id` | int | no | FK | [store](#store).store_id |  |');
    expect(doc).toContain('| `email` | varchar(50) | yes |  |  | may be empty |');
    expect(doc).toContain('Rows: ~599');
  });

  it('lists who references a table, and says so when nobody does', () => {
    expect(doc).toContain('**Referenced by:** [customer](#customer).store_id (fk_customer_store)');
    expect(doc).toContain('**Referenced by:** none');
    expect(doc).not.toContain('hidden');
  });

  it('draws a neighbourhood diagram only for a table that has neighbours', () => {
    const sections = doc.split('\n## ');
    const customer = sections.find((s) => s.startsWith('customer'))!;
    const lonely = sections.find((s) => s.startsWith('lonely'))!;
    expect(customer).toContain('```mermaid\nerDiagram');
    expect(customer).toContain('store ||..o{ customer : "fk_customer_store"');
    expect(lonely).not.toContain('```mermaid');
  });

  it('keeps a crowded neighbourhood within NEIGHBOURS_MAX and says how many were left out', () => {
    const hub: ERTable = { id: 'hub', name: 'hub', columns: [col('id', { isPrimaryKey: true })] };
    const spokes: ERTable[] = Array.from({ length: NEIGHBOURS_MAX + 3 }, (_, i) => ({
      id: `s${i}`,
      name: `s${i}`,
      columns: [col('hub_id', { isForeignKey: true })],
    }));
    const spokeRels: ERRelationship[] = spokes.map((s) => ({
      id: s.id, name: `fk_${s.id}`, sourceTable: s.name, sourceColumn: 'hub_id', targetTable: 'hub', targetColumn: 'id',
    }));
    const hubSection = exportToMarkdownDoc([hub, ...spokes], spokeRels, labels).split('\n## ')[2];
    expect(hubSection.startsWith('hub')).toBe(true);
    expect(hubSection.match(/ \{\n/g)).toHaveLength(NEIGHBOURS_MAX + 1);
    expect(hubSection).toContain('_3 more not shown_');
  });
});

describe('exportToMarkdownDoc — indexes', () => {
  it('lists each table\'s indexes when they are given, and says so when there are none', () => {
    const doc = exportToMarkdownDoc(tables, rels, labels, {
      customer: [
        { name: 'PRIMARY', columns: 'customer_id', unique: true },
        { name: 'idx_store_email', columns: 'store_id, email', unique: false },
      ],
      store: [],
    });
    expect(doc).toContain('**Indexes:** \n- PRIMARY (`customer_id`) — unique\n- idx_store_email (`store_id`, `email`)');
    expect(doc).toContain('**Indexes:** none');
    // A table the map does not mention gets no index line at all (it was not read, not empty).
    expect(doc.split('\n## ').find((s) => s.startsWith('lonely'))).not.toContain('Indexes');
  });

  it('writes no index lines when no indexes are passed', () => {
    expect(exportToMarkdownDoc(tables, rels, labels)).not.toContain('Indexes');
  });
});

describe('headingSlug', () => {
  it('matches GitHub anchors, including repeats and non-Latin names', () => {
    const used = new Map<string, number>();
    expect(headingSlug('Film Actor', used)).toBe('film-actor');
    expect(headingSlug('film_actor', used)).toBe('film_actor');
    expect(headingSlug('Film Actor', used)).toBe('film-actor-1');
    expect(headingSlug('Khách hàng', used)).toBe('khách-hàng');
    expect(headingSlug('bookings.flights', used)).toBe('bookingsflights');
  });
});
