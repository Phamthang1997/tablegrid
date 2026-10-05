import { describe, expect, it } from 'vitest';
import {
  duplicateNames,
  fromStored,
  isValidCellName,
  newCell,
  nextCellName,
  parseNotebook,
  serializeNotebook,
  toStored,
  type NotebookCell,
} from '../notebookFile';
import { parseInline, parseMarkdown, safeHref } from '../notebookMarkdown';

describe('notebook cells', () => {
  it('names SQL cells q1, q2… and reuses the first free number', () => {
    expect(nextCellName([])).toBe('q1');
    expect(nextCellName([{ name: 'q1' }, { name: 'Q3' }])).toBe('q2');
    const a = newCell('sql', []);
    expect(a.name).toBe('q1');
    expect(newCell('md', [a]).name).toBeUndefined();
  });

  it('accepts only names a :name.column reference can spell', () => {
    expect(isValidCellName('orders_2024')).toBe(true);
    expect(isValidCellName('2024')).toBe(false);
    expect(isValidCellName('my cell')).toBe(false);
    expect(isValidCellName('')).toBe(false);
  });

  it('flags duplicate names case-insensitively, SQL cells only', () => {
    const cells: NotebookCell[] = [
      { id: 1, kind: 'sql', name: 'q1', source: '' },
      { id: 2, kind: 'sql', name: 'Q1', source: '' },
      { id: 3, kind: 'sql', name: 'q2', source: '' },
    ];
    expect([...duplicateNames(cells)]).toEqual(['q1']);
  });

  it('stores cells without their React key and reads malformed ones away', () => {
    const cells: NotebookCell[] = [
      { id: 10, kind: 'md', source: '# Hi' },
      { id: 11, kind: 'sql', name: 'q1', source: 'SELECT 1' },
    ];
    expect(toStored(cells)).toEqual([
      { kind: 'md', source: '# Hi' },
      { kind: 'sql', name: 'q1', source: 'SELECT 1' },
    ]);
    const back = fromStored([...toStored(cells), { kind: 'chart' }, null, { kind: 'sql', name: 'bad name', source: 'x' }]);
    expect(back.map((c) => [c.kind, c.name, c.source])).toEqual([
      ['md', undefined, '# Hi'],
      ['sql', 'q1', 'SELECT 1'],
      // An unusable name gets a fresh one rather than the cell being lost.
      ['sql', 'q2', 'x'],
    ]);
    expect(fromStored('nope')).toEqual([]);
  });
});

describe('.tgnb files', () => {
  const cells: NotebookCell[] = [
    { id: 1, kind: 'md', source: 'Top customers' },
    { id: 2, kind: 'sql', name: 'q1', source: 'SELECT id FROM customer' },
  ];

  it('round-trips, and carries no results and no React keys', () => {
    const text = serializeNotebook(cells, 'sakila');
    expect(JSON.parse(text)).toEqual({
      format: 'tablegrid-notebook',
      version: 1,
      title: 'sakila',
      cells: [
        { kind: 'md', source: 'Top customers' },
        { kind: 'sql', name: 'q1', source: 'SELECT id FROM customer' },
      ],
    });
    const back = parseNotebook(text);
    expect(back.ok && back.cells.map((c) => c.source)).toEqual(['Top customers', 'SELECT id FROM customer']);
    expect(back.ok && back.dropped).toBe(0);
  });

  it('refuses a file of another shape or a newer version, and survives a BOM', () => {
    expect(parseNotebook('{oops')).toEqual({ ok: false, reason: 'json' });
    expect(parseNotebook('{"format":"jupyter","cells":[]}')).toEqual({ ok: false, reason: 'format' });
    expect(parseNotebook('{"format":"tablegrid-notebook","version":99,"cells":[]}')).toEqual({ ok: false, reason: 'version' });
    expect(parseNotebook('﻿' + serializeNotebook(cells)).ok).toBe(true);
  });

  it('drops and counts malformed cells inside a valid file', () => {
    const r = parseNotebook('{"format":"tablegrid-notebook","version":1,"cells":[{"kind":"md","source":"a"},{"kind":"x"}]}');
    expect(r).toMatchObject({ ok: true, dropped: 1 });
  });
});

describe('notebook markdown', () => {
  it('parses the blocks a note uses', () => {
    const md = ['# Title', '', 'Some *text* and `code`.', '', '- one', '- two', '', '1. first', '2. second', '', '> quoted', '', '---', '', '```sql', 'SELECT 1;', '```'].join('\n');
    expect(parseMarkdown(md).map((b) => b.t)).toEqual(['h', 'p', 'ul', 'ol', 'quote', 'hr', 'code']);
    const code = parseMarkdown(md).find((b) => b.t === 'code');
    expect(code).toEqual({ t: 'code', v: 'SELECT 1;', lang: 'sql' });
  });

  it('joins consecutive lines into one paragraph', () => {
    expect(parseMarkdown('a\nb\n\nc')).toEqual([
      { t: 'p', c: [{ t: 'text', v: 'a b' }] },
      { t: 'p', c: [{ t: 'text', v: 'c' }] },
    ]);
  });

  it('keeps snake_case identifiers intact instead of reading them as emphasis', () => {
    expect(parseInline('see customer_id and store_id')).toEqual([{ t: 'text', v: 'see customer_id and store_id' }]);
    expect(parseInline('an _italic_ word')).toEqual([
      { t: 'text', v: 'an ' },
      { t: 'i', c: [{ t: 'text', v: 'italic' }] },
      { t: 'text', v: ' word' },
    ]);
  });

  it('keeps only http(s) and mailto links; others render as their text', () => {
    expect(parseInline('[docs](https://x.dev)')).toEqual([{ t: 'a', href: 'https://x.dev', c: [{ t: 'text', v: 'docs' }] }]);
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ t: 'text', v: 'click' }, { t: 'text', v: ')' }]);
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('MAILTO:a@b.c')).toBe('MAILTO:a@b.c');
  });

  it('shows raw HTML as text — the tree has no markup to inject', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
  });
});
