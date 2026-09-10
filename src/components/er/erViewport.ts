/**
 * Viewport math for the ER canvas: zoom clamping, cursor-anchored zoom, world/screen
 * conversion, level-of-detail thresholds and the culling rectangle.
 *
 * Everything here is pure so it can be unit-tested, because the interactive layer above it
 * (`ERDiagramView`) deliberately bypasses React while a gesture is in flight — a bug in this
 * math shows up as content in the wrong place, which is much harder to see in a profiler than
 * a slow render.
 */

import type { ERLayoutPositions, ERNodePosition, ERViewport } from './erTypes';

/**
 * The lower bound is deliberately far below anything readable: it is there to stop a runaway
 * pinch, not to cap the size of a diagram. Fit-to-view scales as `1/sqrt(tables)` — 320
 * tables land near 0.12 and 1200 near 0.066, so a floor of 0.06 was about to start clamping
 * and leaving "fit the whole diagram" showing only part of it.
 */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 3;

/**
 * How much of the diagram is kept mounted outside the visible area, as a fraction of the
 * viewport on EACH side. It is what buys the right to skip React while panning: the live
 * transform can run ahead of the last committed viewport by this much and still find every
 * node it needs already in the DOM.
 *
 * **Per side, so it enters the cost squared** — the mounted area is `(1 + 2 * margin)²`
 * screens. That is what made 0.75 a mistake: 6.25 screens of DOM, which at a third of the
 * way zoomed out covers a whole 300-table diagram, so culling mounted everything and the
 * only thing still saving the frame was the level of detail. 0.25 is 2.25 screens.
 *
 * It has to stay above `needsRecommit`'s drift budget (half of this), which is the distance
 * the live transform is allowed to run before React catches up. Lowering it further trades
 * mounted DOM for more frequent commits; the DOM is the more expensive half, because it is
 * paid on every paint rather than once per commit.
 */
export const CULL_MARGIN = 0.25;

/**
 * Level of detail, chosen from the zoom alone.
 *
 * The point is not only speed: at 0.3 zoom an 11.5px type name renders at 3.5px, so `full`
 * spends ~10 DOM nodes per column row on something nobody can read. The heights do NOT change
 * between levels — a node keeps the size `calculateNodeDimensions` gave it — so switching
 * level can never move a table or an FK line.
 *
 *  - `full`   — everything: icons, column names, types, NOT NULL dots. Starts at the zoom
 *               where the 11.5px type text still renders at 8px, the usual floor for legible
 *               UI text. Raise LOD_NAMES_BELOW to trade detail for speed; the two constants
 *               below are the only place to tune this.
 *  - `names`  — one element per column row, its name as text. Not about reading each name
 *               (at the bottom of this band they are ~6px) but about the row structure, the
 *               PK/FK tints, and the fact that a connector can still be hovered here.
 *  - `blocks` — header title only; the body is an empty block of the same height. Below this
 *               even the structure is gone, so laying out a few thousand text nodes nobody
 *               can see was pure cost.
 */
export type ERLodLevel = 'full' | 'names' | 'blocks';

export const LOD_NAMES_BELOW = 0.7;
export const LOD_BLOCKS_BELOW = 0.5;

export function lodForZoom(zoom: number): ERLodLevel {
  if (zoom < LOD_BLOCKS_BELOW) return 'blocks';
  if (zoom < LOD_NAMES_BELOW) return 'names';
  return 'full';
}

export interface ERRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
}

/** Screen point (relative to the container's top-left) -> world coordinates. */
export function screenToWorld(vp: ERViewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - vp.x) / vp.zoom, y: (sy - vp.y) / vp.zoom };
}

/** World point -> screen point relative to the container's top-left. */
export function worldToScreen(vp: ERViewport, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * vp.zoom + vp.x, y: wy * vp.zoom + vp.y };
}

/**
 * Zoom by `factor` while keeping the world point under (`px`, `py`) pinned to that same screen
 * pixel. This is the whole reason wheel-zoom feels right rather than sliding away from the
 * cursor, and it has to use the CLAMPED zoom to compute the offset — anchoring against the
 * unclamped value makes the diagram drift every time the user keeps scrolling at the limit.
 */
export function zoomAtPoint(vp: ERViewport, factor: number, px: number, py: number): ERViewport {
  const zoom = clampZoom(vp.zoom * factor);
  const ratio = zoom / vp.zoom;
  return {
    x: px - (px - vp.x) * ratio,
    y: py - (py - vp.y) * ratio,
    zoom,
  };
}

/**
 * The world rectangle that is on screen, grown by `margin` viewports on each side.
 * `margin` is what culling renders beyond the visible edge.
 */
export function visibleWorldRect(
  vp: ERViewport,
  width: number,
  height: number,
  margin: number = CULL_MARGIN
): ERRect {
  const worldW = width / vp.zoom;
  const worldH = height / vp.zoom;
  const padX = worldW * margin;
  const padY = worldH * margin;
  const topLeft = screenToWorld(vp, 0, 0);
  return {
    minX: topLeft.x - padX,
    minY: topLeft.y - padY,
    maxX: topLeft.x + worldW + padX,
    maxY: topLeft.y + worldH + padY,
  };
}

export function rectsOverlap(a: ERRect, b: ERRect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function rectIntersectsNode(rect: ERRect, pos: ERNodePosition): boolean {
  return (
    pos.x <= rect.maxX &&
    pos.x + pos.width >= rect.minX &&
    pos.y <= rect.maxY &&
    pos.y + pos.height >= rect.minY
  );
}

/** A node fully inside the rect, i.e. what a marquee that must fully enclose would take. */
export function rectContainsNode(rect: ERRect, pos: ERNodePosition): boolean {
  return (
    pos.x >= rect.minX &&
    pos.x + pos.width <= rect.maxX &&
    pos.y >= rect.minY &&
    pos.y + pos.height <= rect.maxY
  );
}

/** Bezier control points reach up to 180px sideways past a socket (`computeBezierPath`). */
const BEZIER_SLACK = 200;

/**
 * Whether the segment a-b passes through the rectangle. Liang-Barsky, written out so it
 * allocates nothing: it runs once per relationship on every viewport commit.
 */
export function segmentIntersectsRect(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;

  // Each edge as a half-plane: p is the direction along the segment, q the distance to it.
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // Parallel: inside the slab, or nowhere near it.
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  return (
    clip(-dx, ax - minX) &&
    clip(dx, maxX - ax) &&
    clip(-dy, ay - minY) &&
    clip(dy, maxY - ay)
  );
}

/**
 * Whether a connector between two cards can be seen in `rect`.
 *
 * It tests the LINE, not the bounding box of the two cards. That distinction is the whole
 * point and it was measured: on a 1200-table diagram at 85% zoom, 21 cards are mounted and
 * the box test passed **all 2398** connectors, because a connector between two tables half a
 * diagram apart has a box that overlaps every viewport. Rendering all of them is a few
 * thousand SVG elements for the sake of a handful of visible lines.
 *
 * Conservative by construction: the drawn curve stays within the centre-to-centre segment
 * grown by half a card plus the bezier reach, so nothing visible is ever culled.
 */
/**
 * Whether either end of the connector is itself on screen.
 *
 * The test used at the zoomed-in levels, where each connector is its own `<g>` with a hitbox, a
 * stroke and (at `full`) markers and socket dots — six elements and two marker instances each.
 * `connectorIntersects` below is geometrically honest but at a couple of thousand tables it
 * still passes several hundred long diagonals whose two ends are both off screen, and such a
 * line carries no information: you cannot see what it joins or follow it anywhere. Measured on a
 * 2500-table diagram at 85% zoom: 42 cards mounted, and the line test passed 600 connectors
 * against this one's few dozen.
 *
 * At `blocks` the whole layer is a single path, so the honest test is used there instead and the
 * long diagonals stay — zoomed out they are the shape of the graph, and they are nearly free.
 */
export function connectorHasVisibleEnd(
  rect: ERRect,
  a: ERNodePosition,
  b: ERNodePosition
): boolean {
  return rectIntersectsNode(rect, a) || rectIntersectsNode(rect, b);
}

export function connectorIntersects(
  rect: ERRect,
  a: ERNodePosition,
  b: ERNodePosition
): boolean {
  const padX = Math.max(a.width, b.width) / 2 + BEZIER_SLACK;
  const padY = Math.max(a.height, b.height) / 2;
  return segmentIntersectsRect(
    rect.minX - padX,
    rect.minY - padY,
    rect.maxX + padX,
    rect.maxY + padY,
    a.x + a.width / 2,
    a.y + a.height / 2,
    b.x + b.width / 2,
    b.y + b.height / 2
  );
}

/**
 * Whether the last committed viewport is too far from the live one to keep reusing its culled
 * set and its LOD level. Panning is allowed to drift up to HALF the cull margin before React is
 * involved at all, which leaves the other half as slack for the frame the re-render takes; zoom
 * is checked as a ratio because a fixed epsilon means something completely different at 0.1
 * than at 2.
 */
export function needsRecommit(
  committed: ERViewport,
  live: ERViewport,
  width: number,
  height: number
): boolean {
  if (lodForZoom(committed.zoom) !== lodForZoom(live.zoom)) return true;
  const ratio = live.zoom / committed.zoom;
  if (ratio > 1.2 || ratio < 1 / 1.2) return true;
  const driftX = Math.abs(live.x - committed.x) / live.zoom;
  const driftY = Math.abs(live.y - committed.y) / live.zoom;
  const budget = CULL_MARGIN / 2;
  return driftX > (width / live.zoom) * budget || driftY > (height / live.zoom) * budget;
}

/** Viewport that fits `bounds` into `width`x`height` with `padding` screen pixels of margin. */
export function fitViewport(
  bounds: { minX: number; minY: number; width: number; height: number },
  width: number,
  height: number,
  padding: number = 64,
  maxZoom: number = 1.2
): ERViewport {
  const availableW = Math.max(width - padding * 2, 1);
  const availableH = Math.max(height - padding * 2, 1);
  const zoom = clampZoom(
    Math.min(maxZoom, Math.min(availableW / bounds.width, availableH / bounds.height))
  );
  return {
    x: (width - bounds.width * zoom) / 2 - bounds.minX * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.minY * zoom,
    zoom,
  };
}

/** Bounding box of the named nodes, or `null` when none of them has a position. */
export function boundsOf(
  positions: ERLayoutPositions,
  names: Iterable<string>
): { minX: number; minY: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;

  for (const name of names) {
    const pos = positions[name];
    if (!pos) continue;
    found = true;
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + pos.width);
    maxY = Math.max(maxY, pos.y + pos.height);
  }

  if (!found) return null;
  return { minX, minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

/** Names of the nodes a marquee rectangle picks up (touching is enough, as in Figma). */
export function marqueeHits(positions: ERLayoutPositions, rect: ERRect): string[] {
  const hits: string[] = [];
  for (const [name, pos] of Object.entries(positions)) {
    if (rectIntersectsNode(rect, pos)) hits.push(name);
  }
  return hits;
}

/** Normalizes two corner points into a rect, so dragging up/left works like down/right. */
export function rectFromCorners(
  ax: number,
  ay: number,
  bx: number,
  by: number
): ERRect {
  return {
    minX: Math.min(ax, bx),
    minY: Math.min(ay, by),
    maxX: Math.max(ax, bx),
    maxY: Math.max(ay, by),
  };
}

export function easeOutCubic(t: number): number {
  const clamped = Math.min(Math.max(t, 0), 1);
  return 1 - (1 - clamped) ** 3;
}

/** Linear interpolation of a whole viewport, for the eased fit/reset/fly-to animation. */
export function lerpViewport(from: ERViewport, to: ERViewport, t: number): ERViewport {
  const e = easeOutCubic(t);
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    // Zoom is interpolated geometrically: a linear ramp from 0.1 to 2 spends most of its
    // frames near the top and reads as a lurch.
    zoom: from.zoom * (to.zoom / from.zoom) ** e,
  };
}
