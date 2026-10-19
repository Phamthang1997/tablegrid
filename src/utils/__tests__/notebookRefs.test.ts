import { describe, expect, it } from 'vitest';
import { bindCellRefs, findCellRefs, toBindValue, type CellResult } from '../notebookRefs';

const q1: CellResult = {
  columns: ['id', 'Name', 'meta'],
  rows: [
    { id: 7, Name: "O'Brien", meta: { vip: true } },
    { id: 9, Name: '0042', meta: null },
  ],
  truncated: false,
};
const results: Record<string, CellResult | null> = { q1, empty: { columns: ['id'], rows: [], truncated: false }, pending: null };
const lookup = (name: string) => (name in results ? results[name] : undefined);

describe('findCellRefs', () => {
  it('finds :cell.column and :cell.column[] in source order', () => {
    const refs = findCellRefs('SELECT * FROM t WHERE a = :q1.id AND b IN (:q2.code[])');
    expect(refs.map((r) => [r.cell, r.column, r.list])).toEqual([
      ['q1', 'id', false],
      ['q2', 'code', true],
    ]);
  });

  it('ignores strings, comments and Postgres casts', () => {
    const sql = [
      "SELECT ':q1.id', \"x:q1.id\" -- :q1.id",
      '/* :q1.id */ FROM t WHERE x::text = y AND z = :q1.id',
    ].join('\n');
    const refs = findCellRefs(sql);
    expect(refs).toHaveLength(1);
    expect(sql.slice(refs[0].start, refs[0].end)).toBe(':q1.id');
  });

  it('does not take a plain :name or a word:thing for a reference', () => {
    expect(findCellRefs('WHERE a = :id AND b = x:q1.id AND t = 10:30')).toEqual([]);
  });
});

describe('bindCellRefs', () => {
  it('binds the first row with ? on MySQL/SQLite/DuckDB', () => {
    const r = bindCellRefs('SELECT * FROM o WHERE customer_id = :q1.id', 'mysql', lookup);
    expect(r).toEqual({ sql: 'SELECT * FROM o WHERE customer_id = ?', params: [7], uses: ['q1'] });
  });

  it('numbers $n on Postgres across several references', () => {
    const r = bindCellRefs('WHERE a = :q1.id AND b IN (:q1.id[]) AND c = :q1.name', 'postgres', lookup);
    expect(r).toEqual({ sql: 'WHERE a = $1 AND b IN ($2, $3) AND c = $4', params: [7, 7, 9, "O'Brien"], uses: ['q1'] });
  });

  it('keeps values as data: an apostrophe is bound, a numeric-looking string stays a string', () => {
    const r = bindCellRefs('SELECT :q1.name[]', 'sqlite', lookup);
    expect(r).toMatchObject({ sql: 'SELECT ?, ?', params: ["O'Brien", '0042'] });
  });

  it('matches the column case-insensitively when there is no exact match', () => {
    expect(bindCellRefs('SELECT :q1.NAME', 'mysql', lookup)).toMatchObject({ params: ["O'Brien"] });
  });

  it('turns an empty list into IN (NULL), which matches nothing', () => {
    expect(bindCellRefs('WHERE id IN (:empty.id[])', 'mysql', lookup)).toMatchObject({ sql: 'WHERE id IN (?)', params: [null] });
  });

  it('sends a nested value as JSON text', () => {
    expect(toBindValue({ vip: true })).toBe('{"vip":true}');
    expect(toBindValue(undefined)).toBeNull();
  });

  it('reports why a reference cannot be bound', () => {
    expect(bindCellRefs('SELECT :nope.id', 'mysql', lookup)).toEqual({ problem: { kind: 'unknownCell', cell: 'nope' } });
    expect(bindCellRefs('SELECT :pending.id', 'mysql', lookup)).toEqual({ problem: { kind: 'notRun', cell: 'pending' } });
    expect(bindCellRefs('SELECT :empty.id', 'mysql', lookup)).toEqual({ problem: { kind: 'noRows', cell: 'empty' } });
    expect(bindCellRefs('SELECT :q1.missing', 'mysql', lookup)).toEqual({ problem: { kind: 'noColumn', cell: 'q1', column: 'missing' } });
    expect(bindCellRefs('SELECT :q1.id', 'mysql', lookup, 'q1')).toEqual({ problem: { kind: 'self', cell: 'q1' } });
  });

  it('refuses a [] list from a result whose rows were capped — it would silently miss rows', () => {
    const capped = { ...q1, truncated: true };
    expect(bindCellRefs('WHERE id IN (:q1.id[])', 'mysql', () => capped)).toEqual({
      problem: { kind: 'listTruncated', cell: 'q1', column: 'id' },
    });
    // The first row is still exact, so a scalar reference is fine.
    expect(bindCellRefs('WHERE id = :q1.id', 'mysql', () => capped)).toMatchObject({ params: [7] });
  });

  it('refuses SQL that already has placeholders of its own, which would be misnumbered', () => {
    expect(bindCellRefs('WHERE a = ? AND b = :q1.id', 'mysql', lookup)).toEqual({ problem: { kind: 'mixedParams' } });
    expect(bindCellRefs('WHERE a = $1 AND b = :q1.id', 'postgres', lookup)).toEqual({ problem: { kind: 'mixedParams' } });
    // A ? inside a string is not a placeholder.
    expect(bindCellRefs("WHERE a = '?' AND b = :q1.id", 'mysql', lookup)).toMatchObject({ params: [7] });
  });

  it('leaves SQL without references untouched', () => {
    expect(bindCellRefs('SELECT 1 WHERE a = ?', 'mysql', lookup)).toEqual({ sql: 'SELECT 1 WHERE a = ?', params: [], uses: [] });
  });
});
