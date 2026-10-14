import { describe, it, expect } from 'vitest';
import {
  ABBR_RE,
  atStatementStart,
  BUILTIN_TEMPLATES,
  customBodyToSnippet,
  snippetPreview,
  templatesFor,
} from '../liveTemplates';

describe('customBodyToSnippet', () => {
  it('keeps numbered placeholders live', () => {
    expect(customBodyToSnippet('SELECT * FROM ${1:t} WHERE id = ${2}')).toBe('SELECT * FROM ${1:t} WHERE id = ${2}');
  });

  it('escapes Postgres parameters and dollar-quoted bodies', () => {
    expect(customBodyToSnippet('WHERE id = $1')).toBe('WHERE id = \\$1');
    expect(customBodyToSnippet('AS $$ BEGIN END $$')).toBe('AS \\$\\$ BEGIN END \\$\\$');
  });

  it('keeps known variables and escapes unknown ones', () => {
    expect(customBodyToSnippet("'${CURRENT_DATE}'")).toBe("'${CURRENT_DATE}'");
    expect(customBodyToSnippet('${FOO}')).toBe('\\${FOO\\}');
  });

  it('escapes braces and backslashes in literal text and in labels', () => {
    expect(customBodyToSnippet("'{\"a\": 1}'")).toBe("'{\"a\": 1\\}'");
    expect(customBodyToSnippet('a\\b')).toBe('a\\\\b');
  });

  it('round-trips through the preview', () => {
    const src = "SELECT '$1', '${1:x}' FROM t -- }";
    expect(snippetPreview(customBodyToSnippet(src))).toBe("SELECT '$1', 'x' FROM t -- }");
  });
});

describe('snippetPreview', () => {
  it('shows labels and drops bare tab stops', () => {
    expect(snippetPreview('SELECT ${2:*}\nFROM ${1:table};$0')).toBe('SELECT *\nFROM table;');
  });
});

describe('templatesFor', () => {
  it('filters built-ins by dialect', () => {
    const my = templatesFor('mysql').filter((tpl) => tpl.abbr === 'upsert');
    const pg = templatesFor('pgsql').filter((tpl) => tpl.abbr === 'upsert');
    expect(my).toHaveLength(1);
    expect(my[0].body).toContain('ON DUPLICATE KEY');
    expect(pg[0].body).toContain('ON CONFLICT');
  });

  it('gives every dialect exactly one template per abbreviation', () => {
    for (const d of ['mysql', 'pgsql', 'genericsql']) {
      const abbrs = templatesFor(d).map((tpl) => tpl.abbr);
      expect(new Set(abbrs).size).toBe(abbrs.length);
    }
  });

  it('lets a user abbreviation shadow a built-in and ignores invalid ones', () => {
    const list = templatesFor('mysql', [
      { name: 'Mine', template: 'SELECT 1', abbr: 'sel' },
      { name: 'Bad', template: 'x', abbr: '1x' },
      { name: 'None', template: 'y' },
    ]);
    const sel = list.filter((tpl) => tpl.abbr === 'sel');
    expect(sel).toHaveLength(1);
    expect(sel[0].custom).toBe(true);
    expect(list.some((tpl) => tpl.name === 'Bad' || tpl.name === 'None')).toBe(false);
  });

  it('keeps only the first of two user templates with the same abbreviation', () => {
    const list = templatesFor('mysql', [
      { name: 'A', template: 'a', abbr: 'zz' },
      { name: 'B', template: 'b', abbr: 'ZZ' },
    ]);
    expect(list.filter((tpl) => tpl.abbr.toLowerCase() === 'zz').map((tpl) => tpl.name)).toEqual(['A']);
  });
});

describe('atStatementStart', () => {
  it('is true for an empty statement, after a semicolon and after an open paren', () => {
    expect(atStatementStart('sel')).toBe(true);
    expect(atStatementStart('SELECT 1;\n  de')).toBe(true);
    expect(atStatementStart('SELECT * FROM (sel')).toBe(true);
    expect(atStatementStart('-- note\nsel')).toBe(true);
  });

  it('is false in the middle of a statement', () => {
    expect(atStatementStart('SELECT * FROM t WHERE del')).toBe(false);
    expect(atStatementStart('SELECT * FROM t ij')).toBe(false);
  });

  it('keeps statement templates out of the middle of a statement, clause templates in', () => {
    const mid = templatesFor('mysql', [{ name: 'Mine', template: 'x', abbr: 'mine' }], false).map((tpl) => tpl.abbr);
    expect(mid).not.toContain('del');
    expect(mid).toContain('ij');
    expect(mid).toContain('mine');
  });
});

describe('built-ins', () => {
  it('all have valid abbreviations and end on a final tab stop', () => {
    for (const tpl of BUILTIN_TEMPLATES) {
      expect(ABBR_RE.test(tpl.abbr)).toBe(true);
      expect(tpl.body).toContain('$0');
    }
  });
});
