/**
 * ER Diagram Auto-Layout Engine.
 * Implements hierarchical DAG layout, topological layering, collision avoidance,
 * and smart socket routing for relationship connector lines.
 */

import type {
  ERColumn,
  ERTable,
  ERRelationship,
  ERNodePosition,
  ERLayoutPositions,
  ERDetailLevel,
} from './erTypes';

export const HEADER_HEIGHT = 38;
export const ROW_HEIGHT = 24;
export const FOOTER_HEIGHT = 6;
export const DEFAULT_NODE_WIDTH = 260;
export const HORIZONTAL_SPACING = 120;
export const VERTICAL_SPACING = 60;

/**
 * The rows a detail level actually shows.
 *
 * The single definition of it: the card renders these, the node height is measured from
 * them, and the FK connectors anchor at their positions — three answers that have to agree
 * or a line points at the wrong row.
 */
export function visibleColumnsOf(table: ERTable, detailLevel: ERDetailLevel): ERColumn[] {
  if (detailLevel === 'keys_only') {
    const keys = table.columns.filter((col) => col.isPrimaryKey || col.isForeignKey);
    // A table with no key at all would otherwise be a header with nothing under it.
    return keys.length > 0 ? keys : table.columns.slice(0, 3);
  }
  if (detailLevel === 'compact') return table.columns.slice(0, 5);
  return table.columns;
}

/**
 * Calculates node dimensions based on columns and detail level.
 */
export function calculateNodeDimensions(
  table: ERTable,
  detailLevel: ERDetailLevel = 'full',
  isCollapsed: boolean = false
): { width: number; height: number } {
  if (isCollapsed) {
    return { width: DEFAULT_NODE_WIDTH, height: HEADER_HEIGHT };
  }
  const rows = visibleColumnsOf(table, detailLevel).length;
  return { width: DEFAULT_NODE_WIDTH, height: HEADER_HEIGHT + rows * ROW_HEIGHT + FOOTER_HEIGHT };
}

/** The FK graph, in the three shapes the layout needs. Self-references and edges naming a
 *  table that is not in this diagram are dropped — they cannot be drawn either way. */
export interface ERFkGraph {
  /** Tables this one references. */
  parentsOf: Map<string, string[]>;
  /** Tables that reference this one. */
  childrenOf: Map<string, string[]>;
  /** Both directions, for community detection, which does not care about direction. */
  neighboursOf: Map<string, string[]>;
}

export function buildFkGraph(tables: ERTable[], relationships: ERRelationship[]): ERFkGraph {
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  const neighboursOf = new Map<string, string[]>();
  const known = new Set(tables.map((table) => table.name));

  for (const name of known) {
    parentsOf.set(name, []);
    childrenOf.set(name, []);
    neighboursOf.set(name, []);
  }

  for (const rel of relationships) {
    const child = rel.sourceTable;
    const parent = rel.targetTable;
    if (child === parent || !known.has(child) || !known.has(parent)) continue;
    parentsOf.get(child)?.push(parent);
    childrenOf.get(parent)?.push(child);
    neighboursOf.get(child)?.push(parent);
    neighboursOf.get(parent)?.push(child);
  }

  return { parentsOf, childrenOf, neighboursOf };
}

/**
 * Composite key for one edge. NUL rather than a space or a dot: a quoted identifier may
 * legally contain either of those, so `a b > c` would be ambiguous about where the first name
 * ends, and no identifier can hold a NUL. Written as an escape because as a literal character
 * it is invisible in the source — and it made grep treat this whole file as binary.
 */
const EDGE_SEP = String.fromCharCode(0);
const edgeKey = (parent: string, child: string) => `${parent}${EDGE_SEP}${child}`;

/**
 * The edges to ignore so the graph can be layered, found by DFS.
 *
 * A schema with a circular reference has no valid layering, and the old code coped by letting a
 * table into a layer before its parents were placed whenever the next layer was still small
 * (`nextLayerSet.size < 6`). That did not just tolerate cycles — it **created** long backwards
 * edges in perfectly acyclic schemas, which is a good part of why the picture looked like
 * spaghetti. Removing real back edges up front means the layering can then be strict.
 *
 * Iterative on purpose: a chain of a couple of thousand tables would put that many frames on
 * the stack.
 */
export function breakCycles(names: string[], childrenOf: Map<string, string[]>): Set<string> {
  const removed = new Set<string>();
  /** 0 = unseen, 1 = on the current path, 2 = finished. */
  const state = new Map<string, 0 | 1 | 2>();
  for (const name of names) state.set(name, 0);

  for (const root of names) {
    if (state.get(root) !== 0) continue;
    state.set(root, 1);
    const stack: { node: string; next: number }[] = [{ node: root, next: 0 }];

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const children = childrenOf.get(top.node) ?? [];
      if (top.next >= children.length) {
        state.set(top.node, 2);
        stack.pop();
        continue;
      }
      const child = children[top.next++];
      const seen = state.get(child);
      if (seen === undefined || seen === 2) continue;
      if (seen === 1) {
        // Points back at something on the current path: this is the edge that closes a cycle.
        removed.add(edgeKey(top.node, child));
        continue;
      }
      state.set(child, 1);
      stack.push({ node: child, next: 0 });
    }
  }

  return removed;
}

/**
 * Longest-path layering: a table sits one column right of the furthest thing it references, so
 * every FK points rightwards and the depth of a chain is visible in the picture.
 */
export function assignLayers(
  names: string[],
  childrenOf: Map<string, string[]>,
  removed: Set<string>
): Map<string, number> {
  const remaining = new Map<string, number>();
  const layer = new Map<string, number>();
  for (const name of names) {
    remaining.set(name, 0);
    layer.set(name, 0);
  }
  for (const parent of names) {
    for (const child of childrenOf.get(parent) ?? []) {
      if (removed.has(edgeKey(parent, child)) || !remaining.has(child)) continue;
      remaining.set(child, (remaining.get(child) ?? 0) + 1);
    }
  }

  // Kahn, so the depth of the schema cannot overflow anything.
  const queue = names.filter((name) => remaining.get(name) === 0);
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    for (const child of childrenOf.get(parent) ?? []) {
      if (removed.has(edgeKey(parent, child)) || !remaining.has(child)) continue;
      layer.set(child, Math.max(layer.get(child) ?? 0, (layer.get(parent) ?? 0) + 1));
      const left = (remaining.get(child) ?? 0) - 1;
      remaining.set(child, left);
      if (left === 0) queue.push(child);
    }
  }

  return layer;
}

/**
 * Splits the tables into blocks whose foreign keys mostly stay inside them.
 *
 * This started as label propagation, which is the textbook answer and **collapsed**: labels are
 * updated in place in a fixed order and ties go to the smaller one, so the alphabetically
 * smallest label sweeps the entire graph. Measured on a generated schema with 79% of its foreign
 * keys inside a module, it returned ONE community of 1200 — the classic degenerate result, and a
 * seeded shuffle only makes it unstable rather than correct.
 *
 * The reframing is what fixed it. Layout does not need the true communities of the graph; it
 * needs a partition into blocks of a workable size with most edges internal. Stated that way it
 * is a size-capped partitioning, and greedy growth answers it: take the busiest table left, then
 * keep pulling in whichever neighbour has the most edges into the block, until the cap.
 *
 * The cap is what makes it impossible to collapse, and it also keeps a block roughly a
 * screenful — a module of 400 tables would be no more readable as one block than as the whole
 * diagram was. A block that splits a real module in two is not a problem: `orderBlocks` puts
 * the halves next to each other, because that is where their edges point.
 *
 * Every block is filled to the cap, including past the point where it runs out of neighbours
 * — see the note at that branch. Blocks that are too small are their own problem.
 *
 * Deterministic throughout: every choice is broken by degree and then by name.
 */
export function partitionIntoBlocks(
  names: string[],
  neighboursOf: Map<string, string[]>
): Map<string, number> {
  const block = new Map<string, number>();
  if (names.length === 0) return block;

  const degree = new Map<string, number>();
  for (const name of names) degree.set(name, neighboursOf.get(name)?.length ?? 0);

  // Roughly sqrt(n) blocks of roughly sqrt(n) tables, which is also what keeps the packed
  // result square-ish. The floor stops a small schema being chopped into pairs.
  const cap = Math.max(12, Math.round(Math.sqrt(names.length) * 1.5));

  // Busiest first, so a block grows out from a hub rather than from a leaf.
  const seeds = [...names].sort(
    (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
  );

  let index = 0;
  let nextSeed = 0;
  for (const seed of seeds) {
    if (block.has(seed)) continue;

    const members = new Set<string>([seed]);
    block.set(seed, index);

    /** Unassigned neighbours of the block, and how many edges each has into it. */
    const frontier = new Map<string, number>();
    const consider = (name: string) => {
      for (const other of neighboursOf.get(name) ?? []) {
        if (block.has(other) || members.has(other)) continue;
        frontier.set(other, (frontier.get(other) ?? 0) + 1);
      }
    };
    consider(seed);

    while (members.size < cap) {
      let best = '';
      let bestTies = -1;
      let bestDegree = -1;
      for (const [candidate, ties] of frontier) {
        const candidateDegree = degree.get(candidate) ?? 0;
        if (
          ties > bestTies ||
          (ties === bestTies &&
            (candidateDegree > bestDegree ||
              (candidateDegree === bestDegree && candidate < best)))
        ) {
          best = candidate;
          bestTies = ties;
          bestDegree = candidateDegree;
        }
      }

      if (best === "") {
        // The frontier ran dry before the cap did. Ending the block here is what fragmented
        // the result: 320 tables came out as 70 blocks of four or five rather than twelve of
        // twenty-seven, which inflated the diagram by all the gaps between them, lengthened
        // the mean connector, and made `orderBlocks` quadratic over hundreds of entries
        // (183ms at 2500 tables). Carry on with the busiest table left instead: it has no
        // edges into this block, so where it sits does not matter, and the block reaches a
        // useful size.
        while (nextSeed < seeds.length && block.has(seeds[nextSeed])) nextSeed++;
        if (nextSeed >= seeds.length) break;
        best = seeds[nextSeed];
      }

      frontier.delete(best);
      members.add(best);
      block.set(best, index);
      consider(best);
    }

    index++;
  }

  return block;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Orders each layer so related tables end up next to each other — the step the layout was
 * missing, and the reason two tables sharing a parent could sit at opposite ends of a column
 * twelve thousand pixels tall.
 *
 * Barycentric ordering: a table wants to sit at the average position of its neighbours in the
 * adjacent layer, and a few alternating sweeps settle it.
 *
 * Called per block, where it means what it says. Across a whole diagram it did not: keeping a
 * few hundred tables screen-shaped forces each layer to wrap into several columns, and a
 * wrapped layer has no index that corresponds to y. Measured, that cancelled most of the
 * benefit — the median connector moved 12% and the mean 5%.
 */
export function orderLayers(
  layers: string[][],
  parentsOf: Map<string, string[]>,
  childrenOf: Map<string, string[]>,
  sweeps = 4
): string[][] {
  const order = layers.map((layer) => [...layer].sort(byName));

  const sortAgainst = (index: number, reference: number, edges: Map<string, string[]>) => {
    const layer = order[index];
    const ref = order[reference];
    if (!layer || !ref) return;

    const refPosition = new Map<string, number>();
    ref.forEach((name, position) => refPosition.set(name, position));

    // A table with nothing in the reference layer keeps its place rather than being flung to
    // one end, so an unrelated table does not drift across the diagram between sweeps.
    const bary = new Map<string, number>();
    layer.forEach((name, fallback) => {
      let sum = 0;
      let count = 0;
      for (const other of edges.get(name) ?? []) {
        const position = refPosition.get(other);
        if (position !== undefined) {
          sum += position;
          count++;
        }
      }
      bary.set(name, count > 0 ? sum / count : fallback);
    });

    layer.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || byName(a, b));
  };

  for (let sweep = 0; sweep < sweeps; sweep++) {
    if (sweep % 2 === 0) {
      for (let i = 1; i < order.length; i++) sortAgainst(i, i - 1, parentsOf);
    } else {
      for (let i = order.length - 2; i >= 0; i--) sortAgainst(i, i + 1, childrenOf);
    }
  }

  return order;
}

/** Gap between two blocks. Wider than the space inside one, so a block reads as a unit. */
export const BLOCK_GAP = 220;
/**
 * How much wider than tall to aim for when packing the blocks.
 *
 * Higher than a screen's own 1.78 because shelf packing leaves ragged rows, so the result comes
 * out squarer than asked. Swept on a generated schema, reading fit-to-view zoom at 320 and 1200
 * tables: 1.5 gave 0.081/0.055, 2.2 gave 0.122/0.065, 3.0 gave 0.102/0.053. 2.2 it is — the
 * earlier work to keep a large diagram screen-shaped rather than a ribbon is worth as much as
 * the block layout itself, and at 1.5 the packing was quietly giving it back.
 */
const TARGET_ASPECT = 2.2;
/**
 * A row never wraps below this. Wrapping exists to stop a wide diagram running off to the
 * right, and below about one screen there is nothing to gain from it — the area-derived
 * target alone stacked a four-table schema vertically, which reads worse and is no smaller.
 */
const MIN_ROW_WIDTH = 2400;

export interface ERBlock {
  positions: ERLayoutPositions;
  width: number;
  height: number;
}

/**
 * Lays out one set of tables on its own, from (0, 0).
 *
 * The layered reading lives HERE rather than across the whole diagram, and that is the change
 * that makes it work. Ordering a layer by the barycentre of its neighbours only means anything
 * while a layer is one column — and to keep a few hundred tables screen-shaped, layers have to
 * wrap into several. So the wrap was quietly cancelling the ordering: a table's index within
 * its layer stopped being its y coordinate. A module is small enough to need little or no wrap,
 * so inside a block the two agree again.
 *
 * Only edges with both ends in `names` are used, which is what keeps a block self-contained:
 * a cross-module foreign key must not drag one module's layering into another's.
 */
export function layoutBlock(
  names: string[],
  graph: ERFkGraph,
  dims: Map<string, { width: number; height: number }>,
  collapsedMap: Record<string, boolean>
): ERBlock {
  const inBlock = new Set(names);
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  for (const name of names) {
    parentsOf.set(
      name,
      (graph.parentsOf.get(name) ?? []).filter((other) => inBlock.has(other))
    );
    childrenOf.set(
      name,
      (graph.childrenOf.get(name) ?? []).filter((other) => inBlock.has(other))
    );
  }

  const removed = breakCycles(names, childrenOf);
  const layerOf = assignLayers(names, childrenOf, removed);

  let depth = 0;
  for (const name of names) depth = Math.max(depth, layerOf.get(name) ?? 0);
  const layers: string[][] = Array.from({ length: depth + 1 }, () => []);
  for (const name of names) layers[layerOf.get(name) ?? 0].push(name);

  const ordered = orderLayers(layers, parentsOf, childrenOf);

  let stack = 0;
  for (const name of names) stack += (dims.get(name)?.height ?? 0) + VERTICAL_SPACING;
  const columnPitch = DEFAULT_NODE_WIDTH + HORIZONTAL_SPACING;
  const columnCount = Math.max(1, Math.ceil(Math.sqrt(stack / columnPitch)));
  const budget = Math.max(stack / columnCount, 1200);

  const positions: ERLayoutPositions = {};
  let x = 0;
  let y = 0;
  let columnWidth = DEFAULT_NODE_WIDTH;
  let width = 0;
  let height = 0;

  const nextColumn = () => {
    x += columnWidth + HORIZONTAL_SPACING;
    y = 0;
    columnWidth = DEFAULT_NODE_WIDTH;
  };

  for (const layer of ordered) {
    if (y > 0) nextColumn();
    for (const name of layer) {
      const dim = dims.get(name);
      if (!dim) continue;
      if (y > 0 && y + dim.height > budget) nextColumn();

      positions[name] = {
        x,
        y,
        width: dim.width,
        height: dim.height,
        isCollapsed: !!collapsedMap[name],
      };
      y += dim.height + VERTICAL_SPACING;
      columnWidth = Math.max(columnWidth, dim.width);
      width = Math.max(width, x + dim.width);
      height = Math.max(height, y - VERTICAL_SPACING);
    }
  }

  return { positions, width, height };
}

/** A plain grid, for the tables that have no foreign key and so no flow to belong to. */
export function layoutGrid(
  names: string[],
  dims: Map<string, { width: number; height: number }>,
  collapsedMap: Record<string, boolean>,
  budget: number
): ERBlock {
  const positions: ERLayoutPositions = {};
  let x = 0;
  let y = 0;
  let columnWidth = DEFAULT_NODE_WIDTH;
  let width = 0;
  let height = 0;

  for (const name of names) {
    const dim = dims.get(name);
    if (!dim) continue;
    if (y > 0 && y + dim.height > budget) {
      x += columnWidth + HORIZONTAL_SPACING;
      y = 0;
      columnWidth = DEFAULT_NODE_WIDTH;
    }
    positions[name] = {
      x,
      y,
      width: dim.width,
      height: dim.height,
      isCollapsed: !!collapsedMap[name],
    };
    y += dim.height + VERTICAL_SPACING;
    columnWidth = Math.max(columnWidth, dim.width);
    width = Math.max(width, x + dim.width);
    height = Math.max(height, y - VERTICAL_SPACING);
  }

  return { positions, width, height };
}

/**
 * Orders the blocks so the ones that reference each other end up adjacent.
 *
 * A greedy walk over the block graph: start at the largest, then repeatedly take whichever
 * unplaced block has the most foreign keys crossing into what is already placed. Shelf packing
 * turns that one-dimensional sequence into two-dimensional adjacency, so neighbours in the walk
 * become neighbours on the canvas.
 */
export function orderBlocks(groups: string[][], graph: ERFkGraph): number[] {
  const owner = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const name of group) owner.set(name, index);
  });

  const weight = groups.map(() => new Map<number, number>());
  for (const [name, parents] of graph.parentsOf) {
    const from = owner.get(name);
    if (from === undefined) continue;
    for (const parent of parents) {
      const to = owner.get(parent);
      if (to === undefined || to === from) continue;
      weight[from].set(to, (weight[from].get(to) ?? 0) + 1);
      weight[to].set(from, (weight[to].get(from) ?? 0) + 1);
    }
  }

  const remaining = new Set(groups.map((_, index) => index));
  const order: number[] = [];
  let current = 0;
  for (let i = 1; i < groups.length; i++) {
    if (groups[i].length > groups[current].length) current = i;
  }

  while (remaining.size > 0) {
    order.push(current);
    remaining.delete(current);
    if (remaining.size === 0) break;

    let best = -1;
    let bestScore = -1;
    for (const candidate of remaining) {
      let score = 0;
      for (const placed of order) score += weight[candidate].get(placed) ?? 0;
      // Ties by size, then by index — a stable answer matters more than a clever one.
      if (
        score > bestScore ||
        (score === bestScore &&
          best >= 0 &&
          (groups[candidate].length > groups[best].length ||
            (groups[candidate].length === groups[best].length && candidate < best)))
      ) {
        best = candidate;
        bestScore = score;
      }
    }
    current = best >= 0 ? best : [...remaining][0];
  }

  return order;
}

/** Shelf packing: fill rows up to a target width, then start the next one. */
export function packBlocks(blocks: ERBlock[]): ERLayoutPositions {
  let area = 0;
  for (const block of blocks) area += (block.width + BLOCK_GAP) * (block.height + BLOCK_GAP);
  const widest = blocks.reduce((max, block) => Math.max(max, block.width), 0);
  const rowTarget = Math.max(Math.sqrt(area * TARGET_ASPECT), widest, MIN_ROW_WIDTH);

  const positions: ERLayoutPositions = {};
  const ORIGIN = 60;
  let rowX = ORIGIN;
  let rowY = ORIGIN;
  let rowHeight = 0;

  for (const block of blocks) {
    if (rowX > ORIGIN && rowX - ORIGIN + block.width > rowTarget) {
      rowX = ORIGIN;
      rowY += rowHeight + BLOCK_GAP;
      rowHeight = 0;
    }
    for (const [name, spot] of Object.entries(block.positions)) {
      positions[name] = { ...spot, x: spot.x + rowX, y: spot.y + rowY };
    }
    rowX += block.width + BLOCK_GAP;
    rowHeight = Math.max(rowHeight, block.height);
  }

  return positions;
}

/**
 * Places every table.
 *
 * The diagram is laid out as one block per MODULE, not as one big layered graph. Both were
 * measured on the same generated schema, and the difference is the whole reason for the split:
 * ordering layers by their neighbours across the whole diagram moved the median connector by
 * only 12%, because keeping a few hundred tables screen-shaped forces each layer to wrap into
 * several columns, and a wrapped layer no longer has an index that means "y". A module is small
 * enough not to wrap, so inside a block the ordering means what it says.
 *
 * What is given up: the left-to-right reading is now per module rather than diagram-wide. That
 * is where it was being read anyway — nobody traces a foreign key across thirty columns.
 *
 *  1. `breakCycles` per block, so each block's layering can be strict.
 *  2. `partitionIntoBlocks` over the whole graph, to find the blocks in the first place.
 *  3. `layoutBlock` for each, laying out its own layers from (0, 0).
 *  4. `orderBlocks` + `packBlocks`, so blocks that reference each other end up adjacent.
 *
 * Tables with no foreign key at all get a grid of their own at the end — mixed into layer 0
 * they used to stretch the first column of the flow for no reason.
 */
export function computeAutoLayout(
  tables: ERTable[],
  relationships: ERRelationship[],
  detailLevel: ERDetailLevel = 'full',
  collapsedMap: Record<string, boolean> = {}
): ERLayoutPositions {
  if (tables.length === 0) return {};

  const graph = buildFkGraph(tables, relationships);
  const connected: string[] = [];
  const loose: string[] = [];
  for (const table of tables) {
    if ((graph.neighboursOf.get(table.name)?.length ?? 0) > 0) connected.push(table.name);
    else loose.push(table.name);
  }

  // Measure every node up front: both the per-block column budget and the packing need it.
  const dims = new Map<string, { width: number; height: number }>();
  let totalStack = 0;
  for (const table of tables) {
    const dim = calculateNodeDimensions(table, detailLevel, !!collapsedMap[table.name]);
    dims.set(table.name, dim);
    totalStack += dim.height + VERTICAL_SPACING;
  }

  const blockOf = partitionIntoBlocks(connected, graph.neighboursOf);
  const byBlock = new Map<number, string[]>();
  for (const name of connected) {
    const index = blockOf.get(name) ?? 0;
    const list = byBlock.get(index);
    if (list) list.push(name);
    else byBlock.set(index, [name]);
  }
  const groups = [...byBlock.keys()].sort((a, b) => a - b).map((key) => byBlock.get(key) ?? []);

  const blocks = groups.map((group) => layoutBlock(group, graph, dims, collapsedMap));
  const ordered = orderBlocks(groups, graph).map((index) => blocks[index]);

  if (loose.length > 0) {
    const columnPitch = DEFAULT_NODE_WIDTH + HORIZONTAL_SPACING;
    const looseStack = loose.reduce(
      (sum, name) => sum + (dims.get(name)?.height ?? 0) + VERTICAL_SPACING,
      0
    );
    const columns = Math.max(1, Math.ceil(Math.sqrt(looseStack / columnPitch)));
    ordered.push(layoutGrid(loose, dims, collapsedMap, Math.max(looseStack / columns, 1200)));
  }

  return packBlocks(ordered);
}

/**
 * Which row a column occupies, by lower-cased name, for one table at one detail level.
 *
 * This exists because of how often the canvas renderer asks. It resolves both sockets of every
 * visible connector on **every frame**, and the obvious spelling —
 * `visibleColumnsOf(...).findIndex((col) => col.name.toLowerCase() === needle)` — is O(columns)
 * with a fresh string per column, plus a fresh filtered array per call at the non-`full` detail
 * levels. On a Doctrine-shaped schema that was measured in the thousands of short-lived strings
 * per frame: not slow enough to drop a frame, but enough garbage to make the whole thing feel
 * sticky rather than smooth, which is a harder symptom to attribute.
 *
 * Keyed by the `ERTable` object in a `WeakMap`, so reloading the catalog drops the entries with
 * the tables themselves.
 */
const rowIndexCache = new WeakMap<ERTable, Map<ERDetailLevel, Map<string, number>>>();

/**
 * Lower-cased names, memoized.
 *
 * The row lookup below is case-insensitive, and the canvas asks for it twice per connector per
 * frame — at fit-to-view on a large schema that is ~9,000 `toLowerCase()` allocations a frame
 * for a set of strings that never changes. Column names are bounded, so a plain `Map` is the
 * whole fix; the cap only guards against a pathological catalog.
 */
const lowerCache = new Map<string, string>();
const LOWER_CACHE_MAX = 20000;

function lower(name: string): string {
  let hit = lowerCache.get(name);
  if (hit === undefined) {
    if (lowerCache.size >= LOWER_CACHE_MAX) lowerCache.clear();
    hit = name.toLowerCase();
    lowerCache.set(name, hit);
  }
  return hit;
}

function rowIndexMap(table: ERTable, detailLevel: ERDetailLevel): Map<string, number> {
  let byLevel = rowIndexCache.get(table);
  if (!byLevel) rowIndexCache.set(table, (byLevel = new Map()));

  let rows = byLevel.get(detailLevel);
  if (!rows) {
    rows = new Map();
    const shown = visibleColumnsOf(table, detailLevel);
    for (let i = 0; i < shown.length; i += 1) {
      const key = lower(shown[i].name);
      // First wins, which is what `findIndex` did — two columns differing only in case would
      // otherwise anchor on the later row.
      if (!rows.has(key)) rows.set(key, i);
    }
    byLevel.set(detailLevel, rows);
  }
  return rows;
}

/**
 * Calculates exact socket anchor point for a specific column in a table node.
 */
export function getColumnSocketPosition(
  nodePos: ERNodePosition,
  table: ERTable,
  columnName: string,
  side: 'left' | 'right',
  detailLevel: ERDetailLevel = 'full'
): { x: number; y: number } {
  if (nodePos.isCollapsed) {
    return {
      x: side === 'left' ? nodePos.x : nodePos.x + nodePos.width,
      y: nodePos.y + HEADER_HEIGHT / 2,
    };
  }

  // A column this level does not show anchors on the first row rather than off the card.
  const row = rowIndexMap(table, detailLevel).get(lower(columnName)) ?? 0;
  const y = nodePos.y + HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const x = side === 'left' ? nodePos.x : nodePos.x + nodePos.width;

  return { x, y };
}

/** The four points of one connector curve. */
export interface ERBezier {
  x1: number;
  y1: number;
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
  x2: number;
  y2: number;
}

/**
 * The control points of the connector curve.
 *
 * Split out from the path string because the canvas renderer needs the numbers (for
 * `bezierCurveTo`, for the arrow head's tangent and for hit testing) while the SVG export
 * needs the string. One definition of the curvature, two ways of spelling it — a second copy
 * would drift and the exported diagram would stop matching the one on screen.
 */
export function computeBezierControls(
  source: { x: number; y: number },
  target: { x: number; y: number }
): ERBezier {
  const dx = target.x - source.x;
  const curvature = Math.max(Math.min(Math.abs(dx) * 0.5, 180), 40);

  return {
    x1: source.x,
    y1: source.y,
    cx1: source.x + (dx >= 0 ? curvature : -curvature),
    cy1: source.y,
    cx2: target.x - (dx >= 0 ? curvature : -curvature),
    cy2: target.y,
    x2: target.x,
    y2: target.y,
  };
}

/**
 * Computes smooth Cubic Bezier path between source socket and target socket.
 */
export function computeBezierPath(
  source: { x: number; y: number },
  target: { x: number; y: number }
): string {
  const b = computeBezierControls(source, target);
  return `M ${b.x1} ${b.y1} C ${b.cx1} ${b.cy1}, ${b.cx2} ${b.cy2}, ${b.x2} ${b.y2}`;
}

/**
 * The two anchor points of one connector, including which side of each card it leaves from.
 *
 * Shared by the per-connector component and by the flattened path below, so the two can never
 * disagree about where a line starts — the alternative is the same side-picking rules written
 * twice and the lines jumping when the level of detail changes.
 */
export function connectorSockets(
  relationship: ERRelationship,
  sourceTable: ERTable,
  targetTable: ERTable,
  sourcePos: ERNodePosition,
  targetPos: ERNodePosition,
  detailLevel: ERDetailLevel = 'full'
): { source: { x: number; y: number }; target: { x: number; y: number } } {
  const sourceLeftOfTarget = sourcePos.x + sourcePos.width < targetPos.x;
  const targetLeftOfSource = targetPos.x + targetPos.width < sourcePos.x;

  let sourceSide: 'left' | 'right' = 'right';
  let targetSide: 'left' | 'right' = 'right';
  if (sourceLeftOfTarget) {
    targetSide = 'left';
  } else if (targetLeftOfSource) {
    sourceSide = 'left';
  }

  return {
    source: getColumnSocketPosition(
      sourcePos,
      sourceTable,
      relationship.sourceColumn,
      sourceSide,
      detailLevel
    ),
    target: getColumnSocketPosition(
      targetPos,
      targetTable,
      relationship.targetColumn,
      targetSide,
      detailLevel
    ),
  };
}

/**
 * Calculates bounding box of all placed table nodes.
 */
export function computeDiagramBounds(positions: ERLayoutPositions): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  const values = Object.values(positions);
  if (values.length === 0) {
    return { minX: 0, minY: 0, maxX: 1000, maxY: 800, width: 1000, height: 800 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  values.forEach((pos) => {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + pos.width);
    maxY = Math.max(maxY, pos.y + pos.height);
  });

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(maxX - minX, 100),
    height: Math.max(maxY - minY, 100),
  };
}
