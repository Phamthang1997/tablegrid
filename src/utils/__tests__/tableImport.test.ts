import { describe, it, expect } from 'vitest';
import {
  autoMap,
  buildRows,
  coerceCell,
  detectDelimiter,
  displayRowNumber,
  jsonToMatrix,
  maxLengthOf,
  missingRequired,
  parseDelimited,
  toSourceTable,
  typeFamily,
  type TargetColumn,
} from '../tableImport';

const col = (name: string, type: string, over: Partial<TargetColumn> = {}): TargetColumn => ({
  name,
  type,
  nullable: true,
  hasDefault: false,
  ...over,
});
const opts = { emptyAs: 'null' as const, trim: true };

describe('parseDelimited', () => {
  it('handles quotes, doubled quotes, the delimiter and line breaks inside a quoted field', () => {
    const text = 'id,note\r\n1,"a, ""quoted"" note"\n2,"two\nlines"\n';
    expect(parseDelimited(text, ',')).toEqual([
      ['id', 'note'],
      ['1', 'a, "quoted" note'],
      ['2', 'two\nlines'],
    ]);
  });

  it('keeps spaces and empty fields, and drops a BOM', () => {
    expect(parseDelimited('﻿a;b;c\n x ;;z', ';')).toEqual([
      ['a', 'b', 'c'],
      [' x ', '', 'z'],
    ]);
  });

  it('a tab is only a delimiter when chosen', () => {
    expect(parseDelimited('a\tb,c', ',')).toEqual([['a\tb', 'c']]);
  });

  it('ends on a lone CR too, and a last line without a newline', () => {
    expect(parseDelimited('a\rb', ',')).toEqual([['a'], ['b']]);
  });
});

describe('detectDelimiter', () => {
  it('picks the one that splits every line the same way', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectDelimiter('a|b\n1|2')).toBe('|');
  });

  it('ignores a delimiter inside quotes', () => {
    expect(detectDelimiter('"x,y";z\n"1,2";3')).toBe(';');
  });

  it('falls back to comma for a single column', () => {
    expect(detectDelimiter('name\nalice\nbob')).toBe(',');
  });
});

describe('toSourceTable', () => {
  it('names blank and repeated headers so every column can be picked', () => {
    const t = toSourceTable([['id', '', 'id'], [1, 2, 3]], true);
    expect(t.headers).toEqual(['id', 'Column 2', 'id (2)']);
  });

  it('without a header row, numbers the columns and keeps the first row as data', () => {
    const t = toSourceTable([['a', 'b'], ['c']], false);
    expect(t.headers).toEqual(['Column 1', 'Column 2']);
    expect(t.rows).toEqual([['a', 'b'], ['c', null]]);
  });

  it('drops rows that are entirely blank', () => {
    const t = toSourceTable([['a'], [''], ['  '], [null], ['x']], true);
    expect(t.rows).toEqual([['x']]);
  });

  it('JSON arrays become the same grid', () => {
    expect(jsonToMatrix([{ a: 1 }, { b: 2, a: 3 }])).toEqual([['a', 'b'], [1, null], [3, 2]]);
  });
});

describe('typeFamily / maxLengthOf', () => {
  it.each([
    ['int(11)', 'integer'],
    ['bigint unsigned', 'integer'],
    ['serial', 'integer'],
    ['tinyint(1)', 'boolean'],
    ['boolean', 'boolean'],
    ['numeric(10,2)', 'decimal'],
    ['double precision', 'float'],
    ['timestamp without time zone', 'datetime'],
    ['datetime', 'datetime'],
    ['date', 'date'],
    ['time', 'time'],
    ['jsonb', 'json'],
    ['uuid', 'uuid'],
    ['character varying(50)', 'text'],
    ["enum('a','b')", 'text'],
    ['bytea', 'other'],
  ])('%s → %s', (type, fam) => {
    expect(typeFamily(type)).toBe(fam);
  });

  it('reads a declared length', () => {
    expect(maxLengthOf('varchar(50)')).toBe(50);
    expect(maxLengthOf('character varying(12)')).toBe(12);
    expect(maxLengthOf('char(3)')).toBe(3);
    expect(maxLengthOf('text')).toBeNull();
  });
});

describe('autoMap', () => {
  const targets = [col('id', 'int'), col('first_name', 'text'), col('Email', 'text'), col('total', 'int', { generated: true })];

  it('matches exactly, then ignoring case, spaces and underscores', () => {
    expect(autoMap(['First Name', 'id', 'EMAIL', 'total'], targets)).toEqual([1, 0, 2, null]);
  });

  it('uses each source column once, and prefers an exact match', () => {
    expect(autoMap(['firstname', 'first_name'], [col('first_name', 'text'), col('firstName', 'text')])).toEqual([1, 0]);
  });

  it('never maps a generated column', () => {
    expect(autoMap(['total'], [col('total', 'int', { generated: true })])).toEqual([null]);
  });
});

describe('coerceCell', () => {
  it('empty is NULL, except in a text column when asked to keep it', () => {
    expect(coerceCell('', col('n', 'int'), opts)).toEqual({ ok: true, value: null });
    expect(coerceCell('', col('s', 'text'), opts)).toEqual({ ok: true, value: null });
    expect(coerceCell('', col('s', 'text'), { ...opts, emptyAs: 'empty' })).toEqual({ ok: true, value: '' });
  });

  it('flags a NULL for a NOT NULL column, default or not', () => {
    expect(coerceCell(null, col('n', 'int', { nullable: false }), opts)).toEqual({ ok: false, issue: 'required' });
    expect(coerceCell('', col('n', 'int', { nullable: false, hasDefault: true }), opts)).toEqual({ ok: false, issue: 'required' });
  });

  it('integers: exact, and past 2^53 kept as text rather than rounded', () => {
    expect(coerceCell(' 42 ', col('n', 'int'), opts)).toEqual({ ok: true, value: 42 });
    expect(coerceCell('9007199254740993', col('n', 'bigint'), opts)).toEqual({ ok: true, value: '9007199254740993' });
    expect(coerceCell('4.5', col('n', 'int'), opts)).toEqual({ ok: false, issue: 'notInteger' });
    expect(coerceCell(4.5, col('n', 'int'), opts)).toEqual({ ok: false, issue: 'notInteger' });
  });

  it('decimals stay text so nothing is rounded; floats become numbers', () => {
    expect(coerceCell('0.1', col('d', 'decimal(10,2)'), opts)).toEqual({ ok: true, value: '0.1' });
    expect(coerceCell('1e3', col('f', 'double'), opts)).toEqual({ ok: true, value: 1000 });
    expect(coerceCell('1,5', col('d', 'numeric'), opts)).toEqual({ ok: false, issue: 'notNumber' });
  });

  it('booleans in the usual spellings', () => {
    for (const s of ['true', 'Yes', 'y', '1', 'ON']) expect(coerceCell(s, col('b', 'boolean'), opts)).toEqual({ ok: true, value: true });
    for (const s of ['false', 'no', '0']) expect(coerceCell(s, col('b', 'tinyint(1)'), opts)).toEqual({ ok: true, value: false });
    expect(coerceCell('maybe', col('b', 'boolean'), opts)).toEqual({ ok: false, issue: 'notBoolean' });
  });

  it('dates only in ISO order, and only real ones', () => {
    expect(coerceCell('2026-9-5', col('d', 'date'), opts)).toEqual({ ok: true, value: '2026-09-05' });
    expect(coerceCell('2026-09-05 00:00:00', col('d', 'date'), opts)).toEqual({ ok: true, value: '2026-09-05' });
    expect(coerceCell('03/04/2026', col('d', 'date'), opts)).toEqual({ ok: false, issue: 'notDate' });
    expect(coerceCell('2026-02-30', col('d', 'date'), opts)).toEqual({ ok: false, issue: 'notDate' });
  });

  it('datetimes and times', () => {
    expect(coerceCell('2026-09-05T10:20:30Z', col('t', 'timestamp'), opts).ok).toBe(true);
    expect(coerceCell('2026-09-05 25:00', col('t', 'datetime'), opts)).toEqual({ ok: false, issue: 'notDateTime' });
    expect(coerceCell('23:59:59', col('t', 'time'), opts).ok).toBe(true);
    expect(coerceCell('24:00', col('t', 'time'), opts)).toEqual({ ok: false, issue: 'notTime' });
  });

  it('json, uuid and text length', () => {
    expect(coerceCell({ a: 1 }, col('j', 'jsonb'), opts)).toEqual({ ok: true, value: '{"a":1}' });
    expect(coerceCell('{bad', col('j', 'json'), opts)).toEqual({ ok: false, issue: 'notJson' });
    expect(coerceCell('not-a-uuid', col('u', 'uuid'), opts)).toEqual({ ok: false, issue: 'notUuid' });
    expect(coerceCell('abcd', col('s', 'varchar(3)'), opts)).toEqual({ ok: false, issue: 'tooLong' });
    // Characters, not UTF-16 units: an emoji is one character.
    expect(coerceCell('ab😀', col('s', 'varchar(3)'), opts)).toEqual({ ok: true, value: 'ab😀' });
    expect(coerceCell(12, col('s', 'text'), opts)).toEqual({ ok: true, value: '12' });
  });

  it('passes a type it does not model straight through', () => {
    expect(coerceCell('\\x0102', col('b', 'bytea'), opts)).toEqual({ ok: true, value: '\\x0102' });
  });
});

describe('buildRows', () => {
  const targets = [
    col('id', 'int', { nullable: false }),
    col('name', 'varchar(5)'),
    col('skipped', 'text'),
  ];
  const source = toSourceTable(
    [
      ['id', 'name'],
      ['1', 'ann'],
      ['x', 'toolongname'],
      ['3', 'bo'],
    ],
    true,
  );

  it('keeps the clean rows with their source index, and one issue per bad cell', () => {
    const res = buildRows(source, targets, [0, 1, null], opts);
    expect(res.columns).toEqual(['id', 'name']);
    expect(res.rows).toEqual([[1, 'ann'], [3, 'bo']]);
    expect(res.indexes).toEqual([0, 2]);
    expect(res.badRows).toBe(1);
    expect(res.issues.map((i) => [i.index, i.column, i.issue])).toEqual([
      [1, 'id', 'notInteger'],
      [1, 'name', 'tooLong'],
    ]);
  });

  it('a range converts only those rows; the issue cap limits what is kept, not what is counted', () => {
    const res = buildRows(source, targets, [0, 1, null], opts, 1, 3, 1);
    expect(res.indexes).toEqual([2]);
    expect(res.issues).toHaveLength(1);
    expect(res.badRows).toBe(1);
  });
});

describe('missingRequired / displayRowNumber', () => {
  it('names NOT NULL columns with no default that nothing feeds', () => {
    const targets = [
      col('id', 'int', { nullable: false, hasDefault: true }),
      col('name', 'text', { nullable: false }),
      col('note', 'text'),
      col('calc', 'int', { nullable: false, generated: true }),
    ];
    expect(missingRequired(targets, [null, null, null, null])).toEqual(['name']);
    expect(missingRequired(targets, [null, 0, null, null])).toEqual([]);
  });

  it('counts the header line like a spreadsheet does', () => {
    expect(displayRowNumber(0, true)).toBe(2);
    expect(displayRowNumber(0, false)).toBe(1);
  });
});
