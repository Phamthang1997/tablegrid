import { describe, it, expect } from 'vitest';
import {
  QUERY_SHARE_FORMAT,
  buildShareFile,
  newSavedQueries,
  newSnippets,
  parseShareFile,
  shareFileName,
} from '../queryShare';

const NOW = '2026-09-25T10:15:00.000Z';

describe('buildShareFile / parseShareFile', () => {
  it('round-trips saved queries and snippets', () => {
    const text = buildShareFile(
      {
        savedQueries: [{ name: 'Active users', sql: 'SELECT * FROM users WHERE active' }],
        snippets: [{ name: 'Upsert', category: 'DML', description: 'd', template: 'INSERT … ON CONFLICT', abbr: 'ups' }],
      },
      NOW,
    );
    const parsed = parseShareFile(text);
    expect(parsed).toEqual({
      ok: true,
      dropped: 0,
      data: {
        savedQueries: [{ name: 'Active users', sql: 'SELECT * FROM users WHERE active' }],
        snippets: [{ name: 'Upsert', category: 'DML', description: 'd', template: 'INSERT … ON CONFLICT', abbr: 'ups' }],
      },
    });
  });

  it('writes no server key, id or run result — only what someone else can use', () => {
    const text = buildShareFile(
      { savedQueries: [{ name: 'q', sql: 'SELECT 1', conn: 'mysql:prod:3306', db: 'shop', id: '1', ok: true } as any] },
      NOW,
    );
    const raw = JSON.parse(text);
    expect(raw.format).toBe(QUERY_SHARE_FORMAT);
    expect(raw.savedQueries).toEqual([{ name: 'q', sql: 'SELECT 1' }]);
    expect(text).not.toContain('prod');
  });

  it('refuses a file that is not JSON, or not this format, or from a newer version', () => {
    expect(parseShareFile('SELECT 1')).toEqual({ ok: false, error: 'notJson' });
    expect(parseShareFile('{"savedQueries":[]}')).toEqual({ ok: false, error: 'wrongFormat' });
    expect(parseShareFile(JSON.stringify({ format: QUERY_SHARE_FORMAT, version: 99 }))).toEqual({
      ok: false,
      error: 'newerVersion',
    });
  });

  it('drops malformed entries and counts them instead of failing the file', () => {
    const text = JSON.stringify({
      format: QUERY_SHARE_FORMAT,
      version: 1,
      savedQueries: [{ name: 'ok', sql: 'SELECT 1' }, { name: 'no sql' }, { name: 'blank', sql: '   ' }, 42],
      snippets: [{ name: 'x', template: 'SELECT 2' }, { template: 'no name' }],
    });
    const parsed = parseShareFile(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dropped).toBe(4);
    expect(parsed.data.savedQueries).toEqual([{ name: 'ok', sql: 'SELECT 1' }]);
    // A snippet with no category or description gets the defaults the panel uses.
    expect(parsed.data.snippets).toEqual([{ name: 'x', category: 'Custom', description: '', template: 'SELECT 2' }]);
  });

  it('names a nameless query after its text rather than dropping it', () => {
    const text = JSON.stringify({ format: QUERY_SHARE_FORMAT, version: 1, savedQueries: [{ name: '', sql: 'SELECT now()' }] });
    const parsed = parseShareFile(text);
    expect(parsed.ok && parsed.data.savedQueries[0].name).toBe('SELECT now()');
  });
});

describe('newSavedQueries', () => {
  it('skips what is already saved (same name and text), keeps same-name-different-text', () => {
    const existing = [{ name: 'Active users', sql: 'SELECT 1' }];
    const res = newSavedQueries(existing, [
      { name: 'Active users', sql: ' SELECT 1 ' },
      { name: 'Active users', sql: 'SELECT 2' },
      { name: 'Other', sql: 'SELECT 3' },
    ]);
    expect(res.skipped).toBe(1);
    expect(res.added.map((q) => q.sql)).toEqual(['SELECT 2', 'SELECT 3']);
  });

  it('importing the same file twice adds nothing the second time', () => {
    const incoming = [{ name: 'a', sql: 'SELECT 1' }];
    const first = newSavedQueries([], incoming);
    expect(newSavedQueries(first.added, incoming)).toEqual({ added: [], skipped: 1 });
  });

  it('a file repeating the same query adds it once', () => {
    const q = { name: 'a', sql: 'SELECT 1' };
    expect(newSavedQueries([], [q, q]).added).toHaveLength(1);
  });
});

describe('newSnippets', () => {
  const snip = (name: string, abbr?: string) => ({ name, category: 'Custom', description: '', template: `-- ${name}`, abbr });

  it('drops a clashing or invalid abbreviation but keeps the snippet', () => {
    const res = newSnippets([{ ...snip('mine', 'sel') }], [snip('theirs', 'SEL'), snip('bad', '9x'), snip('fine', 'up')]);
    expect(res.added.map((s) => [s.name, s.abbr])).toEqual([
      ['theirs', undefined],
      ['bad', undefined],
      ['fine', 'up'],
    ]);
    expect(res.abbrDropped).toBe(2);
  });

  it('two imported snippets cannot take the same abbreviation', () => {
    const res = newSnippets([], [snip('a', 'q'), snip('b', 'q')]);
    expect(res.added.map((s) => s.abbr)).toEqual(['q', undefined]);
  });

  it('skips a snippet already present', () => {
    const res = newSnippets([snip('a')], [snip('a'), snip('b')]);
    expect(res).toMatchObject({ skipped: 1 });
    expect(res.added.map((s) => s.name)).toEqual(['b']);
  });
});

it('shareFileName', () => {
  expect(shareFileName('20260925_101500', 'queries')).toBe('tablegrid-queries-20260925_101500.json');
});
