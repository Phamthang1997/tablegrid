import { describe, it, expect } from 'vitest';
import {
  buildCsvRows,
  buildInList,
  buildInsertStatements,
  buildJsonValues,
  buildMarkdownTable,
  buildTsv,
  buildUpdateStatements,
} from '../copyAs';

describe('buildInList', () => {
  it('quotes strings, leaves numbers bare, and wraps in parentheses', () => {
    expect(buildInList(['a', 'b'], 'mysql').sql).toBe("('a', 'b')");
    expect(buildInList([1, 2, 3], 'mysql').sql).toBe('(1, 2, 3)');
  });

  it('escapes a quote by doubling it, on every dialect', () => {
    for (const dbType of ['mysql', 'postgres', 'sqlite']) {
      expect(buildInList(["O'Brien"], dbType).sql).toBe("('O''Brien')");
    }
  });

  it('drops nulls and says so, because IN can never match one', () => {
    // `x IN (1, NULL)` is true for 1 and UNKNOWN for everything else — never false — which
    // quietly breaks a NOT IN. Keeping them would change the answer without saying anything.
    const result = buildInList([1, null, 2, undefined], 'mysql');
    expect(result.sql).toBe('(1, 2)');
    expect(result.count).toBe(2);
    expect(result.nullsDropped).toBe(2);
  });

  it('deduplicates, keeping first-seen order, and reports the count', () => {
    const result = buildInList(['b', 'a', 'b', 'a'], 'mysql');
    expect(result.sql).toBe("('b', 'a')");
    expect(result.duplicatesDropped).toBe(2);
    expect(result.count).toBe(2);
  });

  it('treats a number and its string form as one value', () => {
    // A driver may return a BIGINT as a string; the literal is what matters.
    expect(buildInList([7, '7'], 'mysql').count).toBe(2);
    expect(buildInList(['7', '7'], 'mysql').count).toBe(1);
  });

  it('wraps a long list over several lines', () => {
    const result = buildInList(
      Array.from({ length: 40 }, (_, i) => `identifier_${i}`),
      'mysql'
    );
    expect(result.count).toBe(40);
    expect(result.sql.split('\n').length).toBeGreaterThan(3);
    // Still one parenthesised list, and every value is in it.
    expect(result.sql.startsWith('(')).toBe(true);
    expect(result.sql.endsWith(')')).toBe(true);
    expect(result.sql).toContain("'identifier_39'");
  });

  it('gives an empty list rather than throwing when everything was dropped', () => {
    const result = buildInList([null, undefined], 'mysql');
    expect(result.sql).toBe('()');
    expect(result.count).toBe(0);
  });
});

describe('buildInsertStatements', () => {
  const rows = [
    { id: 1, name: "O'Brien", note: null },
    { id: 2, name: 'plain', note: 'x' },
  ];

  it('quotes identifiers per dialect', () => {
    expect(buildInsertStatements('t', ['id'], [rows[0]], 'mysql')).toContain('INSERT INTO `t` (`id`)');
    expect(buildInsertStatements('t', ['id'], [rows[0]], 'postgres')).toContain(
      'INSERT INTO "t" ("id")'
    );
    expect(buildInsertStatements('t', ['id'], [rows[0]], 'sqlite')).toContain(
      'INSERT INTO "t" ("id")'
    );
  });

  it('writes one statement per row, so a wrong one is deleted by deleting its line', () => {
    const sql = buildInsertStatements('t', ['id', 'name', 'note'], rows, 'mysql');
    const lines = sql.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("INSERT INTO `t` (`id`, `name`, `note`) VALUES (1, 'O''Brien', NULL);");
  });

  it('reads a missing column as NULL rather than as the string undefined', () => {
    expect(buildInsertStatements('t', ['id', 'absent'], [{ id: 1 }], 'mysql')).toContain(
      'VALUES (1, NULL);'
    );
  });
});

describe('buildUpdateStatements', () => {
  const cols = ['id', 'name', 'amount'];
  const rows = [{ id: 1, name: "O'Brien", amount: 5 }];

  it('keys the WHERE on the primary key and leaves it out of the SET', () => {
    const { sql } = buildUpdateStatements('t', cols, rows, 'mysql', ['id']);
    expect(sql).toBe("UPDATE `t` SET `name` = 'O''Brien', `amount` = 5 WHERE `id` = 1;");
  });

  it('REFUSES rather than emit an UPDATE with no WHERE', () => {
    // `UPDATE t SET ...;` pasted into an editor and run rewrites every row in the table. There is
    // no useful version of this without a key.
    const result = buildUpdateStatements('t', cols, rows, 'mysql', []);
    expect(result.sql).toBe('');
    expect(result.refused).toBe('noKey');

    // Same when the named key is not one of the copied columns.
    expect(buildUpdateStatements('t', cols, rows, 'mysql', ['other']).refused).toBe('noKey');
  });

  it('refuses when the key is the only column, so there is nothing to set', () => {
    expect(buildUpdateStatements('t', ['id'], rows, 'mysql', ['id']).refused).toBe('nothingToSet');
  });

  it('skips generated columns, which the database refuses to be written', () => {
    const { sql } = buildUpdateStatements(
      't',
      ['id', 'name', 'computed'],
      [{ id: 1, name: 'a', computed: 'x' }],
      'mysql',
      ['id'],
      new Set(['computed'])
    );
    expect(sql).toBe("UPDATE `t` SET `name` = 'a' WHERE `id` = 1;");
  });

  it('handles a composite key with AND', () => {
    const { sql } = buildUpdateStatements(
      't',
      ['a', 'b', 'v'],
      [{ a: 1, b: 2, v: 3 }],
      'postgres',
      ['a', 'b']
    );
    expect(sql).toBe('UPDATE "t" SET "v" = 3 WHERE "a" = 1 AND "b" = 2;');
  });

  it('matches a NULL key with IS NULL, not with =', () => {
    // `WHERE k = NULL` is never true, so the statement would run and update nothing.
    const { sql } = buildUpdateStatements(
      't',
      ['k', 'v'],
      [{ k: null, v: 1 }],
      'mysql',
      ['k']
    );
    expect(sql).toBe('UPDATE `t` SET `v` = 1 WHERE `k` IS NULL;');
  });
});

describe('buildCsvRows', () => {
  const rows = [{ a: 1, b: null }, { a: 2, b: 'x' }];

  it('writes the header only when asked', () => {
    expect(buildCsvRows(['a', 'b'], rows, true)).toBe('a,b\n1,\n2,x');
    expect(buildCsvRows(['a', 'b'], rows, false)).toBe('1,\n2,x');
  });

  it('quotes a cell holding a comma, a quote or a newline, and doubles the quote', () => {
    const tricky = [{ a: 'x,y', b: 'say "hi"', c: 'one\ntwo' }];
    expect(buildCsvRows(['a', 'b', 'c'], tricky, false)).toBe(
      '"x,y","say ""hi""","one\ntwo"',
    );
  });

  it('carries NO byte-order mark, unlike the file export', () => {
    // A BOM on the clipboard pastes as an invisible character in the first cell, which then
    // fails to compare equal to the value it looks identical to.
    expect(buildCsvRows(['a'], [{ a: 1 }], true).charCodeAt(0)).not.toBe(0xfeff);
    expect(buildCsvRows(['a'], [{ a: 1 }], true)).toBe('a\n1');
  });

  it('returns just the header for no rows, and nothing at all without one', () => {
    expect(buildCsvRows(['a', 'b'], [], true)).toBe('a,b');
    expect(buildCsvRows(['a', 'b'], [], false)).toBe('');
  });
});

describe('buildTsv', () => {
  const rows = [{ a: 1, b: null }, { a: 2, b: 'x' }];

  it('writes the header only when asked', () => {
    expect(buildTsv(['a', 'b'], rows, true)).toBe('a\tb\n1\t\n2\tx');
    expect(buildTsv(['a', 'b'], rows, false)).toBe('1\t\n2\tx');
  });

  it('renders null the way the caller asks, because the two grids disagree', () => {
    // A spreadsheet wants an empty cell; a result grid wants to tell null from an empty string.
    expect(buildTsv(['b'], [{ b: null }], false)).toBe('');
    expect(buildTsv(['b'], [{ b: null }], false, 'NULL')).toBe('NULL');
  });

  it('flattens tabs and newlines, which would otherwise split a row or a column', () => {
    expect(buildTsv(['v'], [{ v: 'a\tb' }], false)).toBe('a b');
    expect(buildTsv(['v'], [{ v: 'a\r\nb' }], false)).toBe('a b');
  });
});

describe('buildJsonValues', () => {
  it('gives a flat array for one column — the case it exists for', () => {
    expect(JSON.parse(buildJsonValues(['id'], [{ id: 1 }, { id: 2 }]))).toEqual([1, 2]);
  });

  it('gives an array per row for several columns', () => {
    expect(JSON.parse(buildJsonValues(['a', 'b'], [{ a: 1, b: 'x' }]))).toEqual([[1, 'x']]);
  });

  it('writes null for a missing column rather than dropping the slot', () => {
    expect(JSON.parse(buildJsonValues(['a', 'b'], [{ a: 1 }]))).toEqual([[1, null]]);
    expect(JSON.parse(buildJsonValues(['a'], [{ b: 1 }]))).toEqual([null]);
  });
});

describe('buildMarkdownTable', () => {
  it('writes a header, a rule and one line per row', () => {
    const md = buildMarkdownTable(['a', 'b'], [{ a: 1, b: 2 }]);
    expect(md).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('escapes a pipe so it does not split the cell, and the backslash first', () => {
    // Backslash before pipe: escaping in the other order would escape the escape.
    const md = buildMarkdownTable(['v'], [{ v: 'a|b' }, { v: 'c\\d' }]);
    expect(md).toContain('| a\\|b |');
    expect(md).toContain('| c\\\\d |');
  });

  it('flattens a newline, because a table row is one line', () => {
    expect(buildMarkdownTable(['v'], [{ v: 'one\ntwo' }])).toContain('| one two |');
  });

  it('renders null and a missing column as empty rather than as "null"', () => {
    expect(buildMarkdownTable(['a', 'b'], [{ a: null }])).toBe('| a | b |\n| --- | --- |\n|  |  |');
  });
});
