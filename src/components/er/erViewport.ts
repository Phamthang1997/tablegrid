/**
 * Viewport math for the ER canvas: zoom clamping, cursor-anchored zoom, world/screen
 * conversion, level-of-detail thresholds and the culling rectangle.
 *
 * Everything here is pure so it can be unit-tested, because the layer above it paints to a
 * canvas rather than to the DOM — a bug in this math shows up as content in the wrong place,
 * and there is no element inspector to find it with.
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
 * Level of detail, chosen from the zoom alone.
 *
 * The point is not only speed: at 0.3 zoom an 11.5px type name renders at 3.5px, so `full`
 * measures and draws two strings per column row for something nobody can read. The heights do
 * NOT change between levels — a node keeps the size `calculateNodeDimensions` gave it — so
 * switching level can never move a table or an FK line.
 *
 * What a level costs moved when the cards became bitmaps: it is now paid once per card per
 * raster generation rather than once per frame, so the thresholds are chosen purely for
 * legibility. `blocks` is the exception that is still about speed — it is the only level that
 * is NOT cached (see `erCardRenderer`), because it is the one where fit-to-view can put
 * thousands of cards on screen at once.
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
 *
 * The margin defaults to nothing, and that default is the shape of the renderer: the frame is
 * redrawn from scratch, so there is no reason to reach past the edge. It was 0.25 viewports
 * when cards were React components that had to stay mounted while the live transform ran ahead
 * of the last commit — and it entered the cost SQUARED, since the area is `(1 + 2 * margin)²`
 * screens.
 */
export function visibleWorldRect(
  vp: ERViewport,
  width: number,
  height: number,
  margin: number = 0
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
 * point and it was measured: on a 1200-table diagram at 85% zoom, 21 cards are on screen and
 * the box test passed **all 2398** connectors, because a connector between two tables half a
 * diagram apart has a box that overlaps every viewport.
 *
 * It is the right test at `blocks` only. See `connectorHasVisibleEnd` below for the one used
 * at the zoomed-in levels, and why the two differ.
 *
 * Conservative by construction: the drawn curve stays within the centre-to-centre segment
 * grown by half a card plus the bezier reach, so nothing visible is ever culled.
 */
/**
 * Whether either END of the connector is itself on screen.
 *
 * The test used at the zoomed-in levels. `connectorIntersects` is geometrically honest and at a
 * working zoom it keeps far more than is useful: measured on this app's own diagram at zoom
 * 1.00, **176** connectors passed the segment test against 7 visible cards — meaning ~140 dashed
 * lines crossing the view with both ends, both sockets and the arrow head off screen. Such a line
 * says nothing (you cannot see what it joins) and at `full` it costs two socket resolutions, a
 * curve, two arcs and an arrow head.
 *
 * At `blocks` the honest test is used instead and those diagonals stay, because zoomed out they
 * ARE the shape of the graph — and at that level a connector is two points in a batched path.
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
