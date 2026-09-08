import { describe, it, expect } from 'vitest';
import {
  CULL_MARGIN,
  LOD_BLOCKS_BELOW,
  LOD_NAMES_BELOW,
  ZOOM_MAX,
  ZOOM_MIN,
  boundsOf,
  clampZoom,
  fitViewport,
  lerpViewport,
  lodForZoom,
  marqueeHits,
  needsRecommit,
  rectContainsNode,
  rectFromCorners,
  connectorHasVisibleEnd,
  connectorIntersects,
  rectIntersectsNode,
  segmentIntersectsRect,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAtPoint,
} from '../erViewport';
import type { ERLayoutPositions, ERViewport } from '../erTypes';

const node = (x: number, y: number, width = 260, height = 100) => ({ x, y, width, height });

const positions: ERLayoutPositions = {
  a: node(0, 0),
  b: node(500, 0),
  c: node(0, 400),
  far: node(10_000, 10_000),
};

describe('erViewport zoom', () => {
  it('clamps zoom into the supported range and survives garbage', () => {
    expect(clampZoom(0.0001)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('keeps the world point under the cursor pinned while zooming', () => {
    const before: ERViewport = { x: 37, y: -12, zoom: 0.8 };
    const cursor = { x: 320, y: 210 };
    const world = screenToWorld(before, cursor.x, cursor.y);

    const after = zoomAtPoint(before, 1.35, cursor.x, cursor.y);
    const screenAgain = worldToScreen(after, world.x, world.y);

    expect(screenAgain.x).toBeCloseTo(cursor.x, 6);
    expect(screenAgain.y).toBeCloseTo(cursor.y, 6);
  });

  it('does not drift when zooming past the limit', () => {
    // The anchor has to be computed from the CLAMPED zoom; using the raw product would slide the
    // diagram sideways every time the user keeps scrolling at the maximum.
    const atMax: ERViewport = { x: 10, y: 20, zoom: ZOOM_MAX };
    const after = zoomAtPoint(atMax, 2, 400, 300);
    expect(after.zoom).toBe(ZOOM_MAX);
    expect(after.x).toBeCloseTo(10, 6);
    expect(after.y).toBeCloseTo(20, 6);
  });

  it('round-trips screen and world coordinates', () => {
    const vp: ERViewport = { x: -140, y: 66, zoom: 1.7 };
    const world = screenToWorld(vp, 12, 34);
    const back = worldToScreen(vp, world.x, world.y);
    expect(back.x).toBeCloseTo(12, 6);
    expect(back.y).toBeCloseTo(34, 6);
  });
});

describe('erViewport level of detail', () => {
  it('picks a level from the zoom, with the thresholds exclusive at the bottom', () => {
    expect(lodForZoom(1)).toBe('full');
    expect(lodForZoom(LOD_NAMES_BELOW)).toBe('full');
    expect(lodForZoom(LOD_NAMES_BELOW - 0.01)).toBe('names');
    expect(lodForZoom(LOD_BLOCKS_BELOW)).toBe('names');
    expect(lodForZoom(LOD_BLOCKS_BELOW - 0.01)).toBe('blocks');
    expect(lodForZoom(ZOOM_MIN)).toBe('blocks');
  });
});

describe('erViewport culling', () => {
  it('covers the screen plus the margin on every side', () => {
    const vp: ERViewport = { x: 0, y: 0, zoom: 1 };
    const rect = visibleWorldRect(vp, 1000, 500, CULL_MARGIN);
    expect(rect.minX).toBeCloseTo(-1000 * CULL_MARGIN, 6);
    expect(rect.maxX).toBeCloseTo(1000 + 1000 * CULL_MARGIN, 6);
    expect(rect.minY).toBeCloseTo(-500 * CULL_MARGIN, 6);
    expect(rect.maxY).toBeCloseTo(500 + 500 * CULL_MARGIN, 6);
  });

  it('grows in world units as the diagram is zoomed out', () => {
    const wide = visibleWorldRect({ x: 0, y: 0, zoom: 0.25 }, 1000, 500, 0);
    expect(wide.maxX - wide.minX).toBeCloseTo(4000, 6);
  });

  it('keeps nodes that only touch the rectangle and drops the ones outside', () => {
    const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(rectIntersectsNode(rect, node(-259, 0))).toBe(true);
    expect(rectIntersectsNode(rect, node(-261, 0))).toBe(false);
    expect(rectIntersectsNode(rect, node(100, 100))).toBe(true);
    expect(rectIntersectsNode(rect, node(101, 0))).toBe(false);
  });

  it('tells a touched node from a fully enclosed one', () => {
    const rect = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
    expect(rectContainsNode(rect, node(10, 10))).toBe(true);
    expect(rectContainsNode(rect, node(200, 10))).toBe(false);
    expect(rectIntersectsNode(rect, node(200, 10))).toBe(true);
  });

  it('clips a segment against a rectangle, including the parallel cases', () => {
    const inside = (ax: number, ay: number, bx: number, by: number) =>
      segmentIntersectsRect(0, 0, 100, 100, ax, ay, bx, by);

    expect(inside(-50, 50, 150, 50)).toBe(true); // straight through
    expect(inside(10, 10, 20, 20)).toBe(true); // entirely inside
    expect(inside(-50, 50, 10, 50)).toBe(true); // enters and stops
    expect(inside(-50, -50, 150, 150)).toBe(true); // corner to corner
    expect(inside(-50, 150, 150, 250)).toBe(false); // below, parallel-ish
    expect(inside(-50, 50, -10, 50)).toBe(false); // stops short
    expect(inside(50, -50, 50, -10)).toBe(false); // above, vertical
    expect(inside(50, -50, 50, 150)).toBe(true); // vertical through
    expect(inside(50, 50, 50, 50)).toBe(true); // degenerate, inside
    expect(inside(-50, -50, -50, -50)).toBe(false); // degenerate, outside
  });

  it('culls a connector by its line, not by the box around its two cards', () => {
    const rect = { minX: 0, minY: 0, maxX: 800, maxY: 600 };

    // The box test that this replaced passed this: two cards far apart on opposite sides
    // give a bounding box that swallows the viewport, even though the line misses it by
    // thousands of pixels.
    const farAbove = node(-4000, -5000);
    const farBelow = node(6000, -4800);
    expect(connectorIntersects(rect, farAbove, farBelow)).toBe(false);

    // A line that really does cross the viewport survives, with both cards off screen.
    expect(connectorIntersects(rect, node(-3000, -2000), node(4000, 2600))).toBe(true);

    // And so does one whose cards merely sit just outside, because the curve bows out.
    expect(connectorIntersects(rect, node(-300, 100), node(-320, 400))).toBe(true);
  });

  it('at the zoomed-in levels keeps only connectors with an end on screen', () => {
    const rect = { minX: 0, minY: 0, maxX: 800, maxY: 600 };
    const inside = node(100, 100);
    const outside = node(-9000, -9000);

    expect(connectorHasVisibleEnd(rect, inside, outside)).toBe(true);
    expect(connectorHasVisibleEnd(rect, outside, inside)).toBe(true);
    expect(connectorHasVisibleEnd(rect, inside, node(400, 300))).toBe(true);

    // A long diagonal that crosses the viewport with both ends far outside: honest geometry,
    // and the line test keeps it — but there is nothing to read in it at this zoom, and at a
    // few thousand tables there are hundreds of them, each a `<g>` of six elements.
    const across = [node(-3000, -2000), node(4000, 2600)] as const;
    expect(connectorIntersects(rect, across[0], across[1])).toBe(true);
    expect(connectorHasVisibleEnd(rect, across[0], across[1])).toBe(false);
  });
});

describe('erViewport recommit policy', () => {
  const base: ERViewport = { x: 0, y: 0, zoom: 1 };

  it('holds still for a small pan', () => {
    expect(needsRecommit(base, { ...base, x: -100 }, 1000, 600)).toBe(false);
  });

  it('commits once the pan eats into the cull margin', () => {
    const drift = (1000 * CULL_MARGIN) / 2 + 10;
    expect(needsRecommit(base, { ...base, x: -drift }, 1000, 600)).toBe(true);
  });

  it('commits on a zoom ratio rather than an absolute difference', () => {
    expect(needsRecommit(base, { ...base, zoom: 1.1 }, 1000, 600)).toBe(false);
    expect(needsRecommit(base, { ...base, zoom: 1.3 }, 1000, 600)).toBe(true);
    // The same 0.2 difference far below 1 is a huge relative change and must commit.
    const small: ERViewport = { x: 0, y: 0, zoom: 0.2 };
    expect(needsRecommit(small, { ...small, zoom: 0.4 }, 1000, 600)).toBe(true);
  });

  it('always commits when the level of detail would change', () => {
    const a: ERViewport = { x: 0, y: 0, zoom: LOD_NAMES_BELOW };
    const b: ERViewport = { x: 0, y: 0, zoom: LOD_NAMES_BELOW - 0.001 };
    expect(lodForZoom(a.zoom)).not.toBe(lodForZoom(b.zoom));
    expect(needsRecommit(a, b, 1000, 600)).toBe(true);
  });
});

describe('erViewport fit', () => {
  it('centres the bounds and never zooms past the cap', () => {
    const vp = fitViewport({ minX: 0, minY: 0, width: 100, height: 100 }, 1000, 600, 0, 1.2);
    expect(vp.zoom).toBe(1.2);
    expect(vp.x).toBeCloseTo((1000 - 120) / 2, 6);
    expect(vp.y).toBeCloseTo((600 - 120) / 2, 6);
  });

  it('shrinks to fit a diagram larger than the viewport, honouring the padding', () => {
    const vp = fitViewport({ minX: 0, minY: 0, width: 4000, height: 1000 }, 1000, 600, 50);
    expect(vp.zoom).toBeCloseTo(900 / 4000, 6);
  });

  it('offsets by the bounds origin so a diagram far from 0,0 still lands on screen', () => {
    const vp = fitViewport({ minX: 5000, minY: 5000, width: 200, height: 200 }, 800, 800, 0, 1);
    const topLeft = worldToScreen(vp, 5000, 5000);
    expect(topLeft.x).toBeCloseTo(300, 6);
    expect(topLeft.y).toBeCloseTo(300, 6);
  });
});

describe('erViewport selection helpers', () => {
  it('normalizes a rectangle dragged in any direction', () => {
    expect(rectFromCorners(100, 80, 20, 10)).toEqual({
      minX: 20,
      minY: 10,
      maxX: 100,
      maxY: 80,
    });
  });

  it('lassoes every node the rectangle touches', () => {
    const hits = marqueeHits(positions, { minX: -10, minY: -10, maxX: 520, maxY: 50 });
    expect(hits.sort()).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty drag, which is how a click clears the selection', () => {
    expect(marqueeHits(positions, { minX: 400, minY: 200, maxX: 400, maxY: 200 })).toEqual([]);
  });

  it('bounds only the named nodes and ignores names with no position', () => {
    expect(boundsOf(positions, ['a', 'b', 'nope'])).toEqual({
      minX: 0,
      minY: 0,
      width: 760,
      height: 100,
    });
    expect(boundsOf(positions, ['nope'])).toBeNull();
    expect(boundsOf({}, [])).toBeNull();
  });
});

describe('erViewport tween', () => {
  it('starts at the source and ends exactly on the target', () => {
    const from: ERViewport = { x: 0, y: 0, zoom: 0.5 };
    const to: ERViewport = { x: 400, y: -200, zoom: 2 };
    expect(lerpViewport(from, to, 0)).toEqual(from);
    const end = lerpViewport(from, to, 1);
    expect(end.x).toBeCloseTo(400, 6);
    expect(end.y).toBeCloseTo(-200, 6);
    expect(end.zoom).toBeCloseTo(2, 6);
  });

  it('interpolates zoom geometrically, so half way is the geometric mean', () => {
    // A linear ramp from 0.5 to 2 would put half way at 1.25 and spend most of the animation
    // near the top, which reads as a lurch.
    const mid = lerpViewport({ x: 0, y: 0, zoom: 0.5 }, { x: 0, y: 0, zoom: 2 }, 0.5);
    // easeOutCubic(0.5) = 0.875, so the exponent is 0.875 rather than 0.5.
    expect(mid.zoom).toBeCloseTo(0.5 * 4 ** 0.875, 6);
    expect(mid.zoom).toBeGreaterThan(0.5);
    expect(mid.zoom).toBeLessThan(2);
  });

  it('clamps a t outside 0..1 instead of overshooting', () => {
    const to: ERViewport = { x: 100, y: 100, zoom: 1 };
    expect(lerpViewport({ x: 0, y: 0, zoom: 1 }, to, 2)).toEqual(to);
    expect(lerpViewport({ x: 0, y: 0, zoom: 1 }, to, -1)).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
