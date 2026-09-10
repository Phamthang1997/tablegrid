import { describe, it, expect } from 'vitest';
import {
  resolveRowClick,
  resolveRowContextMenu,
  type RowSelectionState,
} from '../rowSelection';

const ROWS = ['a', 'b', 'c', 'd', 'e'];
const EMPTY: RowSelectionState<string> = { rows: new Set(), anchor: null };
const sel = (anchor: string | null, ...rows: string[]): RowSelectionState<string> => ({
  rows: new Set(rows),
  anchor,
});
const plain = { shift: false, ctrl: false };

describe('resolveRowClick', () => {
  it('selects a single row and takes the anchor with it', () => {
    const next = resolveRowClick(ROWS, EMPTY, 'c', plain);
    expect([...next.rows]).toEqual(['c']);
    expect(next.anchor).toBe('c');
  });

  it('replaces a bigger selection on a plain click', () => {
    const next = resolveRowClick(ROWS, sel('a', 'a', 'b', 'c'), 'e', plain);
    expect([...next.rows]).toEqual(['e']);
  });

  it('adds and removes with ctrl, moving the anchor each time', () => {
    const added = resolveRowClick(ROWS, sel('a', 'a'), 'd', { shift: false, ctrl: true });
    expect([...added.rows].sort()).toEqual(['a', 'd']);
    expect(added.anchor).toBe('d');

    const removed = resolveRowClick(ROWS, added, 'a', { shift: false, ctrl: true });
    expect([...removed.rows]).toEqual(['d']);
    expect(removed.anchor).toBe('a');
  });

  it('extends from the anchor in screen order, in either direction', () => {
    const down = resolveRowClick(ROWS, sel('b', 'b'), 'd', { shift: true, ctrl: false });
    expect([...down.rows]).toEqual(['b', 'c', 'd']);

    const up = resolveRowClick(ROWS, sel('d', 'd'), 'b', { shift: true, ctrl: false });
    expect([...up.rows]).toEqual(['b', 'c', 'd']);
  });

  it('leaves the anchor put, so a second shift+click resizes one range', () => {
    const first = resolveRowClick(ROWS, sel('b', 'b'), 'd', { shift: true, ctrl: false });
    expect(first.anchor).toBe('b');
    // Chaining would give b..d plus d..e; resizing gives b..e, which is what the user sees.
    const second = resolveRowClick(ROWS, first, 'e', { shift: true, ctrl: false });
    expect([...second.rows]).toEqual(['b', 'c', 'd', 'e']);
    expect(second.anchor).toBe('b');
  });

  it('falls back to a plain select when there is no anchor to measure from', () => {
    const next = resolveRowClick(ROWS, EMPTY, 'c', { shift: true, ctrl: false });
    expect([...next.rows]).toEqual(['c']);
    expect(next.anchor).toBe('c');
  });

  it('falls back to a plain select when the anchor is no longer on screen', () => {
    // A re-sort or a filter dropped the anchor out of the visible list.
    const next = resolveRowClick(ROWS, sel('zz', 'zz'), 'c', { shift: true, ctrl: false });
    expect([...next.rows]).toEqual(['c']);
    expect(next.anchor).toBe('c');
  });

  it('never hands back the set it was given, so React state stays immutable', () => {
    const current = sel('a', 'a');
    const next = resolveRowClick(ROWS, current, 'b', { shift: false, ctrl: true });
    expect(next.rows).not.toBe(current.rows);
    expect([...current.rows]).toEqual(['a']);
  });

  it('works on object keys, which is how the SQL result grid identifies a row', () => {
    const objects = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const next = resolveRowClick(
      objects,
      { rows: new Set([objects[0]]), anchor: objects[0] },
      objects[2],
      { shift: true, ctrl: false }
    );
    expect([...next.rows]).toEqual(objects);
  });
});

describe('resolveRowContextMenu', () => {
  it('keeps a selection the clicked row is part of, by reference', () => {
    const current = sel('b', 'a', 'b', 'c');
    const next = resolveRowContextMenu(current, 'b');
    expect(next.rows).toBe(current.rows);
  });

  it('selects just the clicked row when it is outside the selection', () => {
    const next = resolveRowContextMenu(sel('a', 'a', 'b'), 'e');
    expect([...next.rows]).toEqual(['e']);
  });

  it('moves the anchor to the clicked row either way', () => {
    expect(resolveRowContextMenu(sel('b', 'a', 'b', 'c'), 'c').anchor).toBe('c');
    expect(resolveRowContextMenu(sel('a', 'a'), 'e').anchor).toBe('e');
  });
});
