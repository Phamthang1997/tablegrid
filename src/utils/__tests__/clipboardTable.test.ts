import { describe, it, expect } from 'vitest';
import { buildTsv } from '../copyAs';
import { parseTsv, planPaste, PASTE_ROW_LIMIT } from '../clipboardTable';

describe('parseTsv', () => {
  it('splits rows and cells, ignoring the trailing line break a spreadsheet adds', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseTsv('a\tb\nc\td')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('keeps empty cells, including a trailing one', () => {
    expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']]);
    expect(parseTsv('a\t')).toEqual([['a', '']]);
  });

  it('reads a quoted cell that needed quoting: a line break, a tab or a doubled quote', () => {
    expect(parseTsv('"line 1\nline 2"\tx')).toEqual([['line 1\nline 2', 'x']]);
    expect(parseTsv('"a\tb"\tc')).toEqual([['a\tb', 'c']]);
    expect(parseTsv('"say ""hi"""')).toEqual([['say "hi"']]);
  });

  it('keeps quotes that did not need to be there as data', () => {
    expect(parseTsv('"x"\ty')).toEqual([['"x"', 'y']]);
    expect(parseTsv('"unclosed\tz')).toEqual([['"unclosed', 'z']]);
    expect(parseTsv('"a"b\tc')).toEqual([['"a"b', 'c']]);
  });

  it('reads back what the grid copies', () => {
    const cols = ['id', 'name', 'note'];
    const rows = [
      { id: 1, name: '"quoted"', note: null },
      { id: 2, name: 'tab\there', note: 'x' },
    ];
    expect(parseTsv(buildTsv(cols, rows, false))).toEqual([
      ['1', '"quoted"', ''],
      ['2', 'tab here', 'x'],
    ]);
  });
});

describe('planPaste', () => {
  const cols = ['id', 'name', 'email'];

  it('maps by position when there is no header', () => {
    expect(planPaste([['1', 'Ann'], ['2', 'Bo', 'b@x']], cols)).toEqual({
      ok: true,
      header: false,
      rows: [{ id: '1', name: 'Ann' }, { id: '2', name: 'Bo', email: 'b@x' }],
    });
  });

  it('maps by name under a header, in any order and any case', () => {
    expect(planPaste([['EMAIL', 'name'], ['a@x', 'Ann']], cols)).toEqual({
      ok: true,
      header: true,
      rows: [{ email: 'a@x', name: 'Ann' }],
    });
  });

  it('does not take a first row as a header unless every cell names a different column', () => {
    expect(planPaste([['name', 'Ann']], cols)).toMatchObject({ ok: true, header: false });
    expect(planPaste([['name', 'name'], ['a', 'b']], cols)).toMatchObject({ ok: true, header: false });
  });

  it('refuses a row wider than the columns instead of shifting values', () => {
    expect(planPaste([['1', '2', '3', '4']], cols)).toEqual({
      ok: false,
      reason: 'tooWide',
      width: 4,
      columns: 3,
    });
  });

  it('skips blank lines and reports an empty clipboard', () => {
    expect(planPaste([[''], ['', '']], cols)).toEqual({ ok: false, reason: 'empty' });
    expect(planPaste([['id', 'name']], cols)).toEqual({ ok: false, reason: 'empty' });
    expect(planPaste([['1'], [''], ['2']], cols)).toMatchObject({ ok: true, rows: [{ id: '1' }, { id: '2' }] });
  });

  it('refuses more rows than the limit', () => {
    const grid = Array.from({ length: PASTE_ROW_LIMIT + 1 }, (_, i) => [String(i)]);
    expect(planPaste(grid, cols)).toMatchObject({ ok: false, reason: 'tooMany', limit: PASTE_ROW_LIMIT });
  });
});
