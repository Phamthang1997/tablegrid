import { describe, expect, it } from 'vitest';
import { nextRowId, withoutRowIds } from '../rowIds';

describe('rowIds', () => {
  it('mints a different id every time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextRowId()));
    expect(ids.size).toBe(50);
  });

  it('strips the id and keeps everything else', () => {
    const rows = [
      { rowId: nextRowId(), name: '', type: 'INT' },
      { rowId: nextRowId(), name: '', type: 'TEXT' },
    ];
    expect(withoutRowIds(rows)).toEqual([
      { name: '', type: 'INT' },
      { name: '', type: 'TEXT' },
    ]);
    // The input rows are state; they must not lose their key.
    expect(rows.every((r) => typeof r.rowId === 'number')).toBe(true);
  });
});
