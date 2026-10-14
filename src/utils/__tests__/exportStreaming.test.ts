import { describe, it, expect } from 'vitest';
import {
  buildDatabaseFile,
  buildTableFile,
  createDatabaseJsonWriter,
  createTableFileWriter,
} from '../exportHelper';

// The streaming writers exist so a big table can go straight to disk. The one property that makes
// them safe to use is that they write the SAME file the in-memory builders do — so every test here
// compares against `buildTableFile` / `buildDatabaseFile`, byte for byte.

const rows = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => ({
    id: from + i,
    name: `n${from + i}`,
    // The awkward values: a quote, a comma, a newline, a nested object and a null.
    note: i % 3 === 0 ? 'has "quote", comma\nand newline' : null,
    meta: i % 2 === 0 ? { tags: ['a', 'b'], depth: { x: 1 } } : null,
  }));

/** Feeds `data` to a writer in pages of `size`, the way the export job reads it. */
function streamed(format: 'csv' | 'json' | 'sql', data: any[], size: number, cols = ['id', 'name', 'note', 'meta']) {
  const w = createTableFileWriter(format, 'film', cols, 'mysql');
  let out = '';
  for (let i = 0; i < data.length; i += size) out += w.page(data.slice(i, i + size));
  return out + w.finish();
}

const oneShot = (format: 'csv' | 'json' | 'sql', data: any[], cols = ['id', 'name', 'note', 'meta']) =>
  buildTableFile('film', cols, data, format, 'mysql').data as string;

describe('createTableFileWriter matches the one-shot export', () => {
  for (const format of ['csv', 'json', 'sql'] as const) {
    it(`${format}: many pages, including a short last one`, () => {
      const data = rows(2000 * 2 + 7);
      expect(streamed(format, data, 2000)).toBe(oneShot(format, data));
    });

    it(`${format}: a table that fits in one page`, () => {
      expect(streamed(format, rows(3), 2000)).toBe(oneShot(format, rows(3)));
    });

    it(`${format}: an empty table`, () => {
      expect(streamed(format, [], 2000)).toBe(oneShot(format, []));
    });

    it(`${format}: no column list — the columns come from the first row`, () => {
      const data = rows(5);
      const firstRowCols = Object.keys(data[0]);
      // SQL pages must be a multiple of the rows-per-INSERT (see below); CSV/JSON take any size.
      const size = format === 'sql' ? 500 : 2;
      expect(streamed(format, data, size, [])).toBe(oneShot(format, data, firstRowCols));
    });
  }

  it('sql: a page size that is a multiple of 500 rows gives the very same INSERTs', () => {
    const data = rows(1234);
    expect(streamed('sql', data, 500)).toBe(oneShot('sql', data));
    expect(streamed('sql', data, 1000)).toBe(oneShot('sql', data));
  });

  it('an empty page in the middle changes nothing', () => {
    const w = createTableFileWriter('csv', 'film', ['id'], 'mysql');
    const out = w.page(rows(2)) + w.page([]) + w.page(rows(2, 3)) + w.finish();
    expect(out).toBe(oneShot('csv', rows(4), ['id']));
  });
});

describe('createDatabaseJsonWriter matches buildDatabaseFile', () => {
  const sheets = [
    { name: 'film', colNames: ['id'], rows: rows(5) },
    { name: 'empty', colNames: ['id'], rows: [] },
    { name: 'actor "x"', colNames: ['id'], rows: rows(2) },
  ];

  it('several tables, paged, with an empty one between them', () => {
    const w = createDatabaseJsonWriter();
    let out = '';
    for (const s of sheets) {
      out += w.table(s.name);
      for (let i = 0; i < s.rows.length; i += 2) out += w.page(s.rows.slice(i, i + 2));
    }
    out += w.finish();
    expect(out).toBe(buildDatabaseFile(sheets as any, 'json', 'x').data);
  });

  it('no tables at all', () => {
    expect(createDatabaseJsonWriter().finish()).toBe(buildDatabaseFile([], 'json', 'x').data);
  });
});
