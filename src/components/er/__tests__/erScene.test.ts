import { describe, it, expect } from 'vitest';
import type { ERLayoutPositions, ERRelationship, ERTable } from '../erTypes';
import { computeBezierControls, HEADER_HEIGHT } from '../erLayoutEngine';
import {
  bezierHit,
  hitTestCards,
  hitTestRelationships,
  resolveRelationships,
} from '../erScene';
import {
  blockCardDetail,
  cardCacheKey,
  chevronHitBox,
  quantizeRasterScale,
} from '../erCardRenderer';
import type { ERPalette } from '../erTheme';

const table = (name: string, columns: string[] = ['id']): ERTable => ({
  id: name,
  name,
  columns: columns.map((col, index) => ({
    name: col,
    type: 'int',
    isPrimaryKey: index === 0,
    isForeignKey: false,
  })),
});

const at = (x: number, y: number, width = 260, height = 100) => ({ x, y, width, height });

describe('erScene card hit testing', () => {
  const tables = [table('a'), table('b')];
  const positions: ERLayoutPositions = { a: at(0, 0), b: at(100, 50) };

  it('finds the card under a world point', () => {
    expect(hitTestCards(tables, positions, 10, 10)).toBe('a');
  });

  it('misses outside every card', () => {
    expect(hitTestCards(tables, positions, -5, -5)).toBeNull();
    expect(hitTestCards(tables, positions, 1000, 1000)).toBeNull();
  });

  it('returns the card drawn LAST where two overlap', () => {
    // Drawing order is the array order, so the topmost card is the one furthest along it —
    // picking the first match would hand back the card buried underneath.
    expect(hitTestCards(tables, positions, 150, 60)).toBe('b');
  });

  it('ignores a table the layout has no position for', () => {
    expect(hitTestCards([table('ghost')], {}, 0, 0)).toBeNull();
  });

  it('counts the card edges as inside', () => {
    expect(hitTestCards([tables[0]], { a: at(0, 0) }, 0, 0)).toBe('a');
    expect(hitTestCards([tables[0]], { a: at(0, 0) }, 260, 100)).toBe('a');
  });
});

describe('erScene connector hit testing', () => {
  const curve = computeBezierControls({ x: 0, y: 0 }, { x: 400, y: 200 });

  it('hits at both ends of the curve', () => {
    expect(bezierHit(curve, 0, 0, 4)).toBe(true);
    expect(bezierHit(curve, 400, 200, 4)).toBe(true);
  });

  it('hits near the middle, which the straight chord does not pass through', () => {
    // The curve bows away from the source/target line, so a midpoint test against the chord
    // would answer for a different shape than the one drawn.
    expect(bezierHit(curve, 200, 100, 6)).toBe(true);
  });

  it('misses a point well off the curve', () => {
    expect(bezierHit(curve, 200, 600, 4)).toBe(false);
    expect(bezierHit(curve, -400, 0, 4)).toBe(false);
  });

  it('widens with the tolerance', () => {
    const justOff = { x: 0, y: 30 };
    expect(bezierHit(curve, justOff.x, justOff.y, 2)).toBe(false);
    expect(bezierHit(curve, justOff.x, justOff.y, 40)).toBe(true);
  });

  it('finds the relationship a point sits on', () => {
    const tables = [table('child', ['id', 'parent_id']), table('parent')];
    const tableMap = new Map(tables.map((entry) => [entry.name, entry]));
    const positions: ERLayoutPositions = { child: at(0, 0), parent: at(600, 0) };
    const rel: ERRelationship = {
      id: 'child.parent_id->parent.id',
      sourceTable: 'child',
      sourceColumn: 'parent_id',
      targetTable: 'parent',
      targetColumn: 'id',
    };

    const resolved = resolveRelationships([rel], tableMap);
    // The socket of the second column of `child`, on its right edge.
    const sourceY = HEADER_HEIGHT + 24 + 12;
    expect(hitTestRelationships(resolved, positions, 'full', 260, sourceY, 5)).toBe(rel.id);
    expect(hitTestRelationships(resolved, positions, 'full', 430, 900, 5)).toBeNull();
  });

  it('drops a relationship naming a table that is not in the diagram', () => {
    const tables = [table('child', ['id', 'parent_id'])];
    const tableMap = new Map(tables.map((entry) => [entry.name, entry]));
    const rel: ERRelationship = {
      id: 'dangling',
      sourceTable: 'child',
      sourceColumn: 'parent_id',
      targetTable: 'not_here',
      targetColumn: 'id',
    };
    // It is dropped when the list is RESOLVED, once, rather than re-checked on every frame and
    // every pointer move.
    expect(resolveRelationships([rel], tableMap)).toHaveLength(0);
  });
});

describe('erCardRenderer raster scale', () => {
  it('never renders a card below the scale it is displayed at', () => {
    for (const zoom of [0.55, 0.7, 0.9, 1, 1.35, 2]) {
      expect(quantizeRasterScale(zoom, 1)).toBeGreaterThanOrEqual(zoom);
    }
  });

  it('holds still across the zooms a single gesture passes through', () => {
    // This IS the optimisation: a wheel burst must re-use the bitmaps it already has rather
    // than re-render every visible card per frame.
    expect(quantizeRasterScale(0.72, 1)).toBe(quantizeRasterScale(0.99, 1));
    expect(quantizeRasterScale(1.05, 1)).toBe(quantizeRasterScale(1.39, 1));
  });

  it('follows the device pixel ratio', () => {
    expect(quantizeRasterScale(1, 2)).toBe(2);
    expect(quantizeRasterScale(0.4, 2)).toBe(1);
  });

  it('caps rather than growing without bound', () => {
    // Past the cap a card is drawn from a smaller bitmap, which is soft. Unbounded it would be
    // a 3x-zoomed card at dpr 2 rendered at 6x, i.e. ~3.5MB for one table.
    expect(quantizeRasterScale(3, 2)).toBe(2.8);
    expect(quantizeRasterScale(99, 4)).toBe(2.8);
  });
});

describe('erCardRenderer block cards', () => {
  it('drops the corner radius once it is under a device pixel', () => {
    expect(blockCardDetail(0.03).rounded).toBe(false);
    expect(blockCardDetail(0.45).rounded).toBe(true);
  });

  it('drops the title once it is too small to read', () => {
    // At 0.03 zoom a 12px name renders 0.36px tall — and at fit-to-view that is ~2500 invisible
    // strings, each costing a measure, an ellipsis fit and a fillText, every frame.
    expect(blockCardDetail(0.03).title).toBe(false);
    expect(blockCardDetail(0.2).title).toBe(false);
    expect(blockCardDetail(0.49).title).toBe(true);
  });
});

describe('erCardRenderer cache key', () => {
  const palette = (id: string) => ({ id }) as ERPalette;
  const style = (over: Partial<{ lod: 'full' | 'names' | 'blocks'; theme: string }> = {}) => ({
    detailLevel: 'full' as const,
    lod: over.lod ?? ('full' as const),
    palette: palette(over.theme ?? 'dark#0'),
  });

  it('is stable for the same card', () => {
    const key = cardCacheKey(table('a'), at(10, 20), style(), 1);
    expect(cardCacheKey(table('a'), at(99, 99), style(), 1)).toBe(key);
  });

  it('separates every input that changes the pixels', () => {
    const base = cardCacheKey(table('a'), at(0, 0), style(), 1);
    expect(cardCacheKey(table('b'), at(0, 0), style(), 1)).not.toBe(base);
    expect(cardCacheKey(table('a'), at(0, 0), style({ lod: 'names' }), 1)).not.toBe(base);
    expect(cardCacheKey(table('a'), at(0, 0), style(), 2)).not.toBe(base);
    expect(cardCacheKey(table('a'), at(0, 0, 260, 200), style(), 1)).not.toBe(base);
    expect(
      cardCacheKey(table('a'), { ...at(0, 0), isCollapsed: true }, style(), 1)
    ).not.toBe(base);
    // A theme switch changes every colour baked into the bitmap, and the palette id is how the
    // cache hears about it — there is no explicit invalidation to forget.
    expect(cardCacheKey(table('a'), at(0, 0), style({ theme: 'light#0' }), 1)).not.toBe(base);
  });
});

describe('erCardRenderer chevron box', () => {
  it('sits inside the card header', () => {
    const pos = at(100, 200);
    const box = chevronHitBox(pos);
    expect(box.x).toBeGreaterThan(pos.x);
    expect(box.x + box.width).toBeLessThanOrEqual(pos.x + pos.width);
    expect(box.y).toBeGreaterThanOrEqual(pos.y);
    expect(box.y + box.height).toBeLessThanOrEqual(pos.y + HEADER_HEIGHT);
  });
});
