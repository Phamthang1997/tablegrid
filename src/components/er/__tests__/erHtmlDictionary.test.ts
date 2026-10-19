import { describe, expect, it } from 'vitest';
import { escapeHtml, exportToHtmlDictionary, type ErHtmlLabels } from '../erHtmlDictionary';
import type { ERColumn, ERRelationship, ERTable } from '../erTypes';

const labels: ErHtmlLabels = {
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
  search: 'Search…',
  noMatches: 'Nothing matches',
  shown: (n, total) => `${n} of ${total} tables`,
  all: 'All',
  tables: 'Tables',
  views: 'Views',
  columns: 'Columns',
  theme: 'Theme',
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
    comment: 'Who pays',
    rowCount: 599,
    columns: [col('customer_id', { isPrimaryKey: true, nullable: false }), col('email', { type: 'varchar(50)', nullable: true })],
  },
  {
    id: 'payment',
    name: 'payment',
    columns: [
      col('payment_id', { isPrimaryKey: true }),
      col('customer_id', { isForeignKey: true, refTable: 'customer', refColumn: 'customer_id' }),
    ],
  },
];
const rels: ERRelationship[] = [
  {
    id: 'payment.customer_id->customer.customer_id',
    name: 'fk_payment_customer',
    sourceTable: 'payment',
    sourceColumn: 'customer_id',
    targetTable: 'customer',
    targetColumn: 'customer_id',
  },
];

/** The page with its inlined style and script cut out, so assertions read the rendered data only. */
function body(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '');
}

describe('exportToHtmlDictionary', () => {
  it('is one self-contained page: no external stylesheet, script or font', () => {
    const html = exportToHtmlDictionary(tables, rels, labels);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/@import|url\(\s*['"]?https?:/i);
  });

  it('renders one section and one contents entry per table, with the FK linked', () => {
    const html = body(exportToHtmlDictionary(tables, rels, labels));
    expect(html.match(/<section /g)).toHaveLength(2);
    expect(html.match(/<li data-for=/g)).toHaveLength(2);
    expect(html).toContain('id="t-customer"');
    // payment.customer_id points at the customer section …
    expect(html).toContain('<a href="#t-customer">customer</a>.customer_id');
    // … and customer lists payment under "Referenced by", with the constraint name.
    expect(html).toMatch(/Referenced by<\/h3><ul><li><a href="#t-payment">payment<\/a>\.<span class="mono">customer_id<\/span> <span class="dim">\(fk_payment_customer\)/);
    expect(html).toContain('Generated · 2 tables, 1 relationships');
  });

  it('escapes everything that comes from the database — a comment cannot become markup', () => {
    const hostile: ERTable[] = [
      {
        id: 'x',
        name: 'x"><img src=1 onerror=alert(1)>',
        comment: '<script>alert(1)</script>',
        columns: [col('c', { comment: '</td></tr></table><b>x</b>', type: "enum('a','b')" })],
      },
    ];
    const html = body(exportToHtmlDictionary(hostile, [], labels));
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('enum(&#39;a&#39;,&#39;b&#39;)');
    // The search attribute is escaped as well, so it cannot close its own quote.
    expect(html).not.toMatch(/data-s="[^"]*"><img/);
  });

  it('lowercases the search text once, and includes type, comment and referenced table', () => {
    const html = body(exportToHtmlDictionary(tables, rels, labels));
    expect(html).toContain('data-s="customer who pays"');
    expect(html).toContain('<tr data-s="email varchar(50)">');
    expect(html).toContain('<tr data-s="customer_id int customer">');
  });

  it('lists indexes when given, and says "none" for a table that has none', () => {
    const html = body(
      exportToHtmlDictionary(tables, rels, labels, {
        customer: [{ name: 'idx_email', columns: 'email, customer_id', unique: true }],
        payment: [],
      }),
    );
    expect(html).toContain('<span class="mono">idx_email</span> (<span class="mono">email</span>, <span class="mono">customer_id</span>) <span class="pill uq">unique</span>');
    expect(html).toMatch(/id="t-payment"[\s\S]*Indexes<\/h3><p class="none">none<\/p>/);
  });

  it('offers the table/view filter only when there is a view to filter', () => {
    expect(body(exportToHtmlDictionary(tables, rels, labels))).not.toContain('class="kinds"');
    const withView = [...tables, { id: 'v', name: 'customer_list', kind: 'view' as const, columns: [col('name')] }];
    const html = body(exportToHtmlDictionary(withView, rels, labels));
    expect(html).toContain('class="kinds"');
    expect(html).toContain('data-kind="view"');
  });

  it('gives two tables whose names slug the same two different anchors', () => {
    const twins = [
      { id: 'a', name: 'Order', columns: [] },
      { id: 'b', name: 'order', columns: [] },
    ];
    const html = body(exportToHtmlDictionary(twins, [], labels));
    expect(html).toContain('id="t-order"');
    expect(html).toContain('id="t-order-1"');
  });

  it('carries the language and a count template the script can fill', () => {
    const html = exportToHtmlDictionary(tables, rels, labels, undefined, 'vi');
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain('data-template="-1 of -2 tables"');
    expect(html).toContain('>2 of 2 tables<');
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter in text and quoted attributes', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});
