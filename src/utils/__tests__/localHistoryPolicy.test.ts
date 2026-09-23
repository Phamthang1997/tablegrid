import { describe, it, expect } from 'vitest';
import {
  decideEditSnapshots,
  EDIT_INTERVAL_MS,
  isBigDeletion,
  lineDelta,
  MAX_AGE_MS,
  MAX_PER_DOC,
  MAX_SNAPSHOT_CHARS,
  MAX_TOTAL_CHARS,
  pruneIds,
  snapshotTitle,
  worthStoring,
} from '../localHistoryPolicy';

const long = (n: number) => 'x'.repeat(n);

describe('isBigDeletion', () => {
  it('flags large absolute or relative losses only', () => {
    expect(isBigDeletion(long(1000), long(500))).toBe(true);
    expect(isBigDeletion(long(100), long(50))).toBe(true);
    expect(isBigDeletion(long(100), long(90))).toBe(false);
    expect(isBigDeletion(long(20), '')).toBe(false); // too short to matter
    expect(isBigDeletion('a', 'abc')).toBe(false);
  });
});

describe('decideEditSnapshots', () => {
  it('takes the first snapshot immediately', () => {
    expect(decideEditSnapshots(null, null, 'SELECT 1', 0)).toEqual([{ text: 'SELECT 1', reason: 'edit' }]);
  });

  it('throttles edit snapshots', () => {
    const last = { ts: 1000, text: 'a' };
    expect(decideEditSnapshots(last, 'a', 'ab', 1000 + EDIT_INTERVAL_MS - 1)).toEqual([]);
    expect(decideEditSnapshots(last, 'a', 'ab', 1000 + EDIT_INTERVAL_MS)).toEqual([{ text: 'ab', reason: 'edit' }]);
  });

  it('saves the text BEFORE a large deletion, regardless of the throttle', () => {
    const before = long(900);
    const out = decideEditSnapshots({ ts: 0, text: 'old' }, before, 'x', 10);
    expect(out).toEqual([{ text: before, reason: 'beforeDelete' }]);
  });

  it('does not re-store the same text or an empty pane', () => {
    expect(decideEditSnapshots({ ts: 0, text: 'same' }, 'same', 'same', EDIT_INTERVAL_MS * 9)).toEqual([]);
    expect(decideEditSnapshots(null, null, '   ', 0)).toEqual([]);
  });
});

describe('worthStoring', () => {
  it('skips duplicates, blanks and dumps', () => {
    expect(worthStoring({ ts: 0, text: 'a' }, 'a')).toBe(false);
    expect(worthStoring(null, ' ')).toBe(false);
    expect(worthStoring(null, long(MAX_SNAPSHOT_CHARS + 1))).toBe(false);
    expect(worthStoring(null, 'SELECT 1')).toBe(true);
  });
});

describe('pruneIds', () => {
  it('drops by age, then per-pane count, keeping the newest', () => {
    const now = MAX_AGE_MS * 2;
    const entries = [
      { id: 1, doc: 'a', ts: 0, chars: 1 }, // too old
      ...Array.from({ length: MAX_PER_DOC + 2 }, (_, i) => ({ id: 100 + i, doc: 'b', ts: now - i, chars: 1 })),
    ];
    const dropped = new Set(pruneIds(entries, now));
    expect(dropped.has(1)).toBe(true);
    expect(dropped.has(100)).toBe(false); // newest of b
    expect(dropped.has(100 + MAX_PER_DOC)).toBe(true);
    expect(dropped.has(100 + MAX_PER_DOC + 1)).toBe(true);
    expect(dropped.size).toBe(3);
  });

  it('enforces the total budget from the oldest end', () => {
    const half = Math.ceil(MAX_TOTAL_CHARS / 2) + 1;
    const dropped = pruneIds([
      { id: 1, doc: 'a', ts: 3, chars: half },
      { id: 2, doc: 'b', ts: 2, chars: half },
      { id: 3, doc: 'c', ts: 1, chars: 1 },
    ], 10);
    expect(dropped).toEqual([2, 3]);
  });
});

describe('snapshotTitle / lineDelta', () => {
  it('takes the first non-empty line', () => {
    expect(snapshotTitle('\n\n  SELECT *\nFROM t')).toBe('SELECT *');
    expect(snapshotTitle(long(100), 10)).toBe(`${long(10)}…`);
  });

  it('counts added and removed lines', () => {
    expect(lineDelta('a\nb\nc', 'a\nc\nd\ne')).toEqual({ added: 2, removed: 1 });
    expect(lineDelta('a', 'a')).toEqual({ added: 0, removed: 0 });
  });
});
