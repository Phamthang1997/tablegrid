import { describe, it, expect } from 'vitest';
import { filterRowsByQuery, findMatchRange, normalizeSearch, rowMatchesQuery } from '../gridSearch';

describe('normalizeSearch', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeSearch('Nguyễn')).toBe('nguyen');
    expect(normalizeSearch('ĐÀ NẴNG')).toBe('Đa nang'.toLowerCase());
  });

  it('maps nullish to the empty string so a NULL cell never matches', () => {
    expect(normalizeSearch(null)).toBe('');
    expect(normalizeSearch(undefined)).toBe('');
    expect(normalizeSearch(0)).toBe('0');
  });
});

describe('rowMatchesQuery', () => {
  const row = { id: 7, first_name: 'PENELOPE', city: 'Hà Nội', note: null };
  const cols = ['id', 'first_name', 'city', 'note'];

  it('matches any column, ignoring case and diacritics', () => {
    expect(rowMatchesQuery(row, cols, 'pene')).toBe(true);
    expect(rowMatchesQuery(row, cols, 'ha noi')).toBe(true);
    expect(rowMatchesQuery(row, cols, '7')).toBe(true);
    expect(rowMatchesQuery(row, cols, 'zzz')).toBe(false);
  });

  it('only looks at the columns it is given', () => {
    expect(rowMatchesQuery(row, ['id'], 'pene')).toBe(false);
  });

  it('an empty or blank query matches everything', () => {
    expect(rowMatchesQuery(row, cols, '')).toBe(true);
    expect(rowMatchesQuery(row, cols, '   ')).toBe(true);
  });

  it('searches the buffered edit rather than the stored value', () => {
    expect(rowMatchesQuery(row, cols, 'MARY')).toBe(false);
    expect(rowMatchesQuery(row, cols, 'MARY', { first_name: 'MARY' })).toBe(true);
    // ...and the stored value is no longer findable once it has been typed over.
    expect(rowMatchesQuery(row, cols, 'pene', { first_name: 'MARY' })).toBe(false);
  });
});

describe('filterRowsByQuery', () => {
  const rows = [{ a: 'one' }, { a: 'two' }, { a: 'three' }];

  it('returns the very same array when the query is blank', () => {
    expect(filterRowsByQuery(rows, ['a'], '  ')).toBe(rows);
  });

  it('keeps the matching rows, in order', () => {
    expect(filterRowsByQuery(rows, ['a'], 'o')).toEqual([{ a: 'one' }, { a: 'two' }]);
  });
});

describe('findMatchRange', () => {
  it('finds a plain match', () => {
    expect(findMatchRange('PENELOPE', 'nel')).toEqual({ start: 2, end: 5 });
  });

  it('returns null when there is nothing to find', () => {
    expect(findMatchRange('PENELOPE', 'zzz')).toBeNull();
    expect(findMatchRange('PENELOPE', '  ')).toBeNull();
    expect(findMatchRange('', 'a')).toBeNull();
  });

  // The regression this function exists for: normalizing the haystack changes its length, so an
  // index taken from the normalized text addresses the wrong character in the original.
  it('returns indices into the ORIGINAL string, not the normalized one', () => {
    const text = 'Nguyễn Văn A';
    const hit = findMatchRange(text, 'van');
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe('Văn');
  });

  it('keeps a diacritic inside the match itself', () => {
    const text = 'Hà Nội';
    const hit = findMatchRange(text, 'ha noi');
    expect(text.slice(hit!.start, hit!.end)).toBe('Hà Nội');
  });

  it('slicing around the match reassembles the original exactly', () => {
    const text = 'Đường Lê Lợi, Quận 1';
    const hit = findMatchRange(text, 'le loi')!;
    expect(text.slice(0, hit.start) + text.slice(hit.start, hit.end) + text.slice(hit.end)).toBe(text);
  });
});
