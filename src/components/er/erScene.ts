/**
 * One frame of the ER canvas, and the geometry hit tests that replace asking the DOM.
 *
 * The whole diagram is drawn here every frame, which sounds worse than the HTML renderer it
 * replaced and is dramatically better: the frame is `O(what is on screen)` and each card costs
 * one blit, whereas the HTML version paid style, layout and rasterization for ~10 elements per
 * column row and paid all of it again whenever the viewport SCALE changed — i.e. on every frame
 * of every zoom gesture.
 *
 * Two consequences shape this file:
 *
 *  - **There is no cull margin and no committed viewport.** Those existed to keep React's
 *    mounted set stable while the live transform ran ahead of it. Nothing is mounted now, so
 *    culling is just "is it on screen", recomputed per frame.
 *  - **Hit testing is geometry, not `document.elementFromPoint`.** That call forced a layout
 *    and walked every connector's 14px hitbox stroke; the functions at the bottom of this file
 *    are pure, so they are also the only part of the interaction layer that can be unit-tested.
 */

import type {
  ERDetailLevel,
  ERLayoutPositions,
  ERNodePosition,
  ERRelationship,
  ERTable,
  ERViewport,
} from './erTypes';
import {
  computeBezierControls,
  connectorSockets,
  type ERBezier,
} from './erLayoutEngine';
import {
  connectorHasVisibleEnd,
  connectorIntersects,
  lodForZoom,
  rectIntersectsNode,
  visibleWorldRect,
  type ERLodLevel,
  type ERRect,
} from './erViewport';
import {
  ERCardCache,
  blockCardDetail,
  cardOutlinePath,
  drawBlockCard,
  drawCardSkeleton,
} from './erCardRenderer';
import type { ERPalette } from './erTheme';

/** Opacity of everything outside the focused neighbourhood — `.focused` in the old CSS. */
const DIM_CARD = 0.35;
const DIM_REL = 0.15;
const REL_BASE_ALPHA = 0.6;
const REL_WIDTH = 1.5;
/** The lit connectors keep a constant width on SCREEN, which is what `non-scaling-stroke` did
 *  for the old focus path: at 0.1 zoom a 1.5 world-unit stroke is a sixth of a device pixel. */
const REL_LIT_SCREEN_WIDTH = 2.5;
const SOCKET_RADIUS = 3.5;
const ARROW_LENGTH = 7;
const ARROW_HALF_WIDTH = 3.5;

export interface ERSceneInput {
  ctx: CanvasRenderingContext2D;
  dpr: number;
  /** Container size in CSS pixels. */
  width: number;
  height: number;
  viewport: ERViewport;
  /** Tables actually in the diagram, after the view/isolated filters. */
  tables: ERTable[];
  tableMap: Map<string, ERTable>;
  positions: ERLayoutPositions;
  relationships: ERResolvedRelationship[];
  detailLevel: ERDetailLevel;
  selected: ReadonlySet<string>;
  /** Non-empty means something is focused, and everything outside these two dims. */
  litNodes: ReadonlySet<string>;
  litRels: ReadonlySet<string>;
  cache: ERCardCache;
  palette: ERPalette;
  rasterScale: number;
  marquee: ERRect | null;
  /**
   * How many card bitmaps this frame may render before falling back to skeletons.
   *
   * Without it one frame can be asked to render every card it can see — fit-to-view, a theme
   * switch, the first frame after a detail-level change — and that frame is the stall this
   * whole renderer exists to remove. The frame reports back that it was incomplete and the
   * caller draws again, so the cards fill in over two or three frames instead.
   */
  fillBudget: number;
}

export interface ERSceneResult {
  /** False when the fill budget ran out: draw again to finish the remaining cards. */
  complete: boolean;
  /** Cards and connectors that survived culling — what the frame actually cost. */
  cards: number;
  connectors: number;
  /** Card bitmaps rendered this frame rather than blitted from the cache. */
  rendered: number;
}

/**
 * A relationship with both of its tables already looked up.
 *
 * Resolved once, when the table list or the relationship list changes — NOT per frame. The two
 * `Map.get` calls look trivial, and at 5000 foreign keys they are 20,000 lookups every frame
 * for an answer that only changes when the catalog reloads.
 */
export interface ERResolvedRelationship {
  rel: ERRelationship;
  source: ERTable;
  target: ERTable;
}

export function resolveRelationships(
  relationships: ERRelationship[],
  tableMap: Map<string, ERTable>
): ERResolvedRelationship[] {
  const out: ERResolvedRelationship[] = [];
  for (const rel of relationships) {
    const source = tableMap.get(rel.sourceTable);
    const target = tableMap.get(rel.targetTable);
    if (source && target) out.push({ rel, source, target });
  }
  return out;
}

export function drawScene(input: ERSceneInput): ERSceneResult {
  const { ctx, dpr, width, height, viewport } = input;
  const zoom = viewport.zoom;
  const lod = lodForZoom(zoom);
  const focused = input.litNodes.size > 0 || input.litRels.size > 0;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, viewport.x * dpr, viewport.y * dpr);

  // No margin: there is nothing to keep mounted ahead of the viewport any more.
  const view = visibleWorldRect(viewport, width, height, 0);

  const connectors = drawConnectors(input, view, lod, focused);
  const cards = drawCards(input, view, lod, focused);
  drawMarquee(input);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { complete: cards.complete, cards: cards.drawn, rendered: cards.rendered, connectors };
}

/** Returns how many connectors survived culling. */
function drawConnectors(
  input: ERSceneInput,
  view: ERRect,
  lod: ERLodLevel,
  focused: boolean
): number {
  const { ctx, palette, positions, detailLevel, viewport } = input;
  const zoom = viewport.zoom;
  const decorate = lod === 'full';
  /**
   * At the lowest level a connector is a straight segment, which is what the old flattened path
   * drew. The curve's bow is at most 180 world units, i.e. under a device pixel down there — and
   * skipping it saves both the control-point object and, far more importantly, the curve
   * flattening the rasterizer does per path: measured at 4499 connectors in ONE frame when the
   * whole diagram is fitted on screen.
   */
  const flat = lod === 'blocks';
  // Zoomed in, a connector with both ends off screen is a line you cannot follow to anything.
  // Zoomed out, those diagonals ARE the shape of the graph. See `connectorHasVisibleEnd`.
  const visible = flat ? connectorIntersects : connectorHasVisibleEnd;

  /**
   * Four batches, not four draws per connector.
   *
   * Everything a connector contributes goes into one of these and each is submitted ONCE. That
   * matters most for the decorations: at `full` a couple of hundred visible connectors were
   * ~750 individual `beginPath`/`fill`/`stroke` submissions per frame, and the cost of a canvas
   * path is dominated by submitting it rather than by how many segments it holds.
   */
  const curves = { plain: new Path2D(), lit: new Path2D(), plainCount: 0, litCount: 0 };
  const sockets = { plain: new Path2D(), lit: new Path2D() };
  const arrows = { plain: new Path2D(), lit: new Path2D() };

  for (const entry of input.relationships) {
    const sourcePos = positions[entry.rel.sourceTable];
    const targetPos = positions[entry.rel.targetTable];
    if (!sourcePos || !targetPos) continue;
    if (!visible(view, sourcePos, targetPos)) continue;

    const anchors = connectorSockets(
      entry.rel,
      entry.source,
      entry.target,
      sourcePos,
      targetPos,
      detailLevel
    );
    const isLit = input.litRels.has(entry.rel.id);
    const curve = isLit ? curves.lit : curves.plain;
    if (isLit) curves.litCount += 1;
    else curves.plainCount += 1;

    if (flat) {
      curve.moveTo(anchors.source.x, anchors.source.y);
      curve.lineTo(anchors.target.x, anchors.target.y);
      continue;
    }

    const bezier = computeBezierControls(anchors.source, anchors.target);
    curve.moveTo(bezier.x1, bezier.y1);
    curve.bezierCurveTo(bezier.cx1, bezier.cy1, bezier.cx2, bezier.cy2, bezier.x2, bezier.y2);

    // Sockets and arrow heads only at the top level of detail: below ~0.7 zoom both are under a
    // device pixel, so they are pure cost.
    if (!decorate) continue;
    const socket = isLit ? sockets.lit : sockets.plain;
    socket.moveTo(bezier.x1 + SOCKET_RADIUS, bezier.y1);
    socket.arc(bezier.x1, bezier.y1, SOCKET_RADIUS, 0, Math.PI * 2);
    socket.moveTo(bezier.x2 + SOCKET_RADIUS, bezier.y2);
    socket.arc(bezier.x2, bezier.y2, SOCKET_RADIUS, 0, Math.PI * 2);
    appendArrowHead(isLit ? arrows.lit : arrows.plain, bezier);
  }

  ctx.lineCap = 'butt';

  if (curves.plainCount > 0) {
    ctx.strokeStyle = palette.relLine;
    ctx.lineWidth = REL_WIDTH;
    ctx.globalAlpha = focused ? REL_BASE_ALPHA * DIM_REL : REL_BASE_ALPHA;
    // The dash is what `.er-rel-path.dashed` drew, and it is the reason batching the curves
    // matters: a dash pattern makes the rasterizer flatten every curve and walk it.
    if (decorate) ctx.setLineDash([4, 2]);
    ctx.stroke(curves.plain);
    ctx.setLineDash([]);
  }

  if (curves.litCount > 0) {
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = REL_LIT_SCREEN_WIDTH / zoom;
    ctx.globalAlpha = 1;
    ctx.stroke(curves.lit);
  }

  if (decorate) {
    ctx.lineWidth = REL_WIDTH;
    ctx.fillStyle = palette.cardBg;

    ctx.globalAlpha = focused ? DIM_REL : 1;
    ctx.strokeStyle = palette.relLine;
    ctx.fill(sockets.plain);
    ctx.stroke(sockets.plain);
    ctx.fillStyle = palette.relLine;
    ctx.fill(arrows.plain);

    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.cardBg;
    ctx.strokeStyle = palette.accent;
    ctx.fill(sockets.lit);
    ctx.stroke(sockets.lit);
    ctx.fillStyle = palette.accent;
    ctx.fill(arrows.lit);
  }

  ctx.globalAlpha = 1;
  return curves.plainCount + curves.litCount;
}

/** The target arrow, pointing along the curve's own tangent at its end. */
function appendArrowHead(path: Path2D, bezier: ERBezier): void {
  const dx = bezier.x2 - bezier.cx2;
  const dy = bezier.y2 - bezier.cy2;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const baseX = bezier.x2 - ux * ARROW_LENGTH;
  const baseY = bezier.y2 - uy * ARROW_LENGTH;

  path.moveTo(bezier.x2, bezier.y2);
  path.lineTo(baseX - uy * ARROW_HALF_WIDTH, baseY + ux * ARROW_HALF_WIDTH);
  path.lineTo(baseX + uy * ARROW_HALF_WIDTH, baseY - ux * ARROW_HALF_WIDTH);
  path.closePath();
}

function drawCards(
  input: ERSceneInput,
  view: ERRect,
  lod: ERLodLevel,
  focused: boolean
): { complete: boolean; drawn: number; rendered: number } {
  const { ctx, positions, cache, palette, detailLevel, rasterScale } = input;
  const style = { detailLevel, lod, palette };
  // Resolved once per frame rather than per card: at fit-to-view this loop runs 2500 times.
  const block = lod === 'blocks' ? blockCardDetail(input.viewport.zoom) : null;
  const budget = { left: input.fillBudget, ranOut: false, rendered: 0 };
  let drawn = 0;

  // Two passes so a lit or selected card is never covered by a neighbour drawn after it —
  // the z-index the old CSS gave `.hl` and `.selected`.
  const front: { table: ERTable; pos: ERNodePosition }[] = [];

  for (const table of input.tables) {
    const pos = positions[table.name];
    if (!pos || !rectIntersectsNode(view, pos)) continue;
    if ((focused && input.litNodes.has(table.name)) || input.selected.has(table.name)) {
      front.push({ table, pos });
      continue;
    }
    ctx.globalAlpha = focused ? DIM_CARD : 1;
    paintCard(ctx, table, pos, style, cache, rasterScale, block, budget);
    drawn += 1;
  }

  ctx.globalAlpha = 1;
  for (const item of front) {
    paintCard(ctx, item.table, item.pos, style, cache, rasterScale, block, budget);
    drawn += 1;
  }

  // Rings last, so one never lands under the next card.
  for (const item of front) {
    const isSelected = input.selected.has(item.table.name);
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = (isSelected ? 2 : 1) / input.viewport.zoom;
    cardOutlinePath(ctx, item.pos, 0);
    ctx.stroke();
  }

  return { complete: !budget.ranOut, drawn, rendered: budget.rendered };
}

function paintCard(
  ctx: CanvasRenderingContext2D,
  table: ERTable,
  pos: ERNodePosition,
  style: { detailLevel: ERDetailLevel; lod: ERLodLevel; palette: ERPalette },
  cache: ERCardCache,
  rasterScale: number,
  block: { rounded: boolean; title: boolean } | null,
  budget: { left: number; ranOut: boolean; rendered: number }
): void {
  // `blocks` is drawn straight rather than cached: it is a filled rectangle with at most a
  // title, and it is the level where fit-to-view can put thousands of cards on screen — the one
  // case where a bitmap per card would be a memory problem rather than a saving.
  if (block) {
    drawBlockCard(ctx, table, pos, style.palette, block);
    return;
  }

  if (!cache.has(table, pos, style, rasterScale)) {
    if (budget.left <= 0) {
      budget.ranOut = true;
      drawCardSkeleton(ctx, pos, style.palette);
      return;
    }
    budget.left -= 1;
    budget.rendered += 1;
  }

  const bitmap = cache.acquire(table, pos, style, rasterScale);
  if (!bitmap) return;
  ctx.drawImage(bitmap, pos.x, pos.y, pos.width, pos.height);
}

function drawMarquee(input: ERSceneInput): void {
  const { ctx, marquee, palette, viewport } = input;
  if (!marquee) return;
  const w = marquee.maxX - marquee.minX;
  const h = marquee.maxY - marquee.minY;
  ctx.fillStyle = palette.marqueeFill;
  ctx.fillRect(marquee.minX, marquee.minY, w, h);
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1 / viewport.zoom;
  ctx.strokeRect(marquee.minX, marquee.minY, w, h);
}

// -------------------------------------------------------------------------------------------
// Hit testing
//
// Pure, and deliberately so: what the pointer is over used to be `document.elementFromPoint`
// plus `closest('[data-er-node]')`, which is a forced layout and a walk over every connector
// hitbox on every pointer move. These run over the same numbers the frame was drawn from.
// -------------------------------------------------------------------------------------------

/** The topmost table at a world point, or null. Later tables draw over earlier ones. */
export function hitTestCards(
  tables: ERTable[],
  positions: ERLayoutPositions,
  x: number,
  y: number
): string | null {
  for (let i = tables.length - 1; i >= 0; i -= 1) {
    const pos = positions[tables[i].name];
    if (!pos) continue;
    if (x >= pos.x && x <= pos.x + pos.width && y >= pos.y && y <= pos.y + pos.height) {
      return tables[i].name;
    }
  }
  return null;
}

function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** How many straight pieces a curve is flattened into for hit testing. */
const BEZIER_SAMPLES = 14;

/** Whether a world point is within `tolerance` of the curve. */
export function bezierHit(
  b: ERBezier,
  px: number,
  py: number,
  tolerance: number
): boolean {
  // Cheap reject first: the curve never leaves the box of its own control points.
  const minX = Math.min(b.x1, b.cx1, b.cx2, b.x2) - tolerance;
  const maxX = Math.max(b.x1, b.cx1, b.cx2, b.x2) + tolerance;
  const minY = Math.min(b.y1, b.cy1, b.cy2, b.y2) - tolerance;
  const maxY = Math.max(b.y1, b.cy1, b.cy2, b.y2) + tolerance;
  if (px < minX || px > maxX || py < minY || py > maxY) return false;

  const toleranceSq = tolerance * tolerance;
  let prevX = b.x1;
  let prevY = b.y1;
  for (let i = 1; i <= BEZIER_SAMPLES; i += 1) {
    const t = i / BEZIER_SAMPLES;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const c = 3 * mt * mt * t;
    const d = 3 * mt * t * t;
    const e = t * t * t;
    const x = a * b.x1 + c * b.cx1 + d * b.cx2 + e * b.x2;
    const y = a * b.y1 + c * b.cy1 + d * b.cy2 + e * b.y2;
    if (pointSegmentDistanceSq(px, py, prevX, prevY, x, y) <= toleranceSq) return true;
    prevX = x;
    prevY = y;
  }
  return false;
}

/**
 * The connector under a world point, or null. Only called when no card was hit.
 *
 * `view` is not an optimisation detail — it is what keeps this affordable. Resolving a
 * connector's sockets calls `getColumnSocketPosition`, which scans the table's columns by name,
 * so doing it for every foreign key in the schema is O(relationships × columns) on **every
 * pointer move**: at 5000 FKs over 20-column tables that is six figures of string comparisons
 * per mouse movement. Culling to what is on screen first leaves a couple of dozen.
 */
export function hitTestRelationships(
  relationships: ERResolvedRelationship[],
  positions: ERLayoutPositions,
  detailLevel: ERDetailLevel,
  x: number,
  y: number,
  tolerance: number,
  view: ERRect | null = null
): string | null {
  for (const entry of relationships) {
    const sourcePos = positions[entry.rel.sourceTable];
    const targetPos = positions[entry.rel.targetTable];
    if (!sourcePos || !targetPos) continue;
    if (view && !connectorIntersects(view, sourcePos, targetPos)) continue;
    const anchors = connectorSockets(
      entry.rel,
      entry.source,
      entry.target,
      sourcePos,
      targetPos,
      detailLevel
    );
    if (bezierHit(computeBezierControls(anchors.source, anchors.target), x, y, tolerance)) {
      return entry.rel.id;
    }
  }
  return null;
}
