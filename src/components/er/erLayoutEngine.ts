/**
 * ER Diagram Auto-Layout Engine.
 * Implements hierarchical DAG layout, topological layering, collision avoidance,
 * and smart socket routing for relationship connector lines.
 */

import type { ERTable, ERRelationship, ERNodePosition, ERLayoutPositions, ERDetailLevel } from './erTypes';

export const HEADER_HEIGHT = 38;
export const ROW_HEIGHT = 24;
export const FOOTER_HEIGHT = 6;
export const DEFAULT_NODE_WIDTH = 260;
export const HORIZONTAL_SPACING = 120;
export const VERTICAL_SPACING = 60;

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

  let visibleColumns = table.columns;
  if (detailLevel === 'keys_only') {
    visibleColumns = table.columns.filter((col) => col.isPrimaryKey || col.isForeignKey);
    if (visibleColumns.length === 0) {
      visibleColumns = table.columns.slice(0, 3);
    }
  } else if (detailLevel === 'compact') {
    visibleColumns = table.columns.slice(0, 5);
  }

  const height = HEADER_HEIGHT + visibleColumns.length * ROW_HEIGHT + FOOTER_HEIGHT;
  return { width: DEFAULT_NODE_WIDTH, height };
}

/**
 * Automatically computes hierarchical layout for all tables using DAG topological layering.
 */
export function computeAutoLayout(
  tables: ERTable[],
  relationships: ERRelationship[],
  detailLevel: ERDetailLevel = 'full',
  collapsedMap: Record<string, boolean> = {}
): ERLayoutPositions {
  if (tables.length === 0) return {};

  const tableMap = new Map<string, ERTable>();
  tables.forEach((table) => tableMap.set(table.name, table));

  // Build in-degree and adjacency map for DAG layering
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};
  const revAdj: Record<string, string[]> = {};

  tables.forEach((table) => {
    inDegree[table.name] = 0;
    adj[table.name] = [];
    revAdj[table.name] = [];
  });

  relationships.forEach((rel) => {
    if (tableMap.has(rel.sourceTable) && tableMap.has(rel.targetTable) && rel.sourceTable !== rel.targetTable) {
      adj[rel.targetTable].push(rel.sourceTable);
      revAdj[rel.sourceTable].push(rel.targetTable);
      inDegree[rel.sourceTable] = (inDegree[rel.sourceTable] || 0) + 1;
    }
  });

  // Calculate layers (Rank by depth from root tables)
  const layers: string[][] = [];
  const visited = new Set<string>();

  let currentLayer = tables.filter((table) => inDegree[table.name] === 0).map((table) => table.name);
  if (currentLayer.length === 0) {
    currentLayer = [tables[0].name];
  }

  while (currentLayer.length > 0) {
    layers.push(currentLayer);
    currentLayer.forEach((name) => visited.add(name));

    const nextLayerSet = new Set<string>();
    currentLayer.forEach((name) => {
      (adj[name] || []).forEach((child) => {
        if (!visited.has(child)) {
          const parents = revAdj[child] || [];
          const allParentsVisited = parents.every((parentName) => visited.has(parentName));
          if (allParentsVisited || nextLayerSet.size < 6) {
            nextLayerSet.add(child);
          }
        }
      });
    });

    currentLayer = Array.from(nextLayerSet);
  }

  const unplaced = tables.filter((table) => !visited.has(table.name)).map((table) => table.name);
  if (unplaced.length > 0) {
    for (let i = 0; i < unplaced.length; i += 4) {
      layers.push(unplaced.slice(i, i + 4));
    }
  }

  // Measure every node up front, so the column height can be derived from the real total rather
  // than guessed.
  const dims = new Map<string, { width: number; height: number }>();
  let totalStack = 0;
  for (const table of tables) {
    const dim = calculateNodeDimensions(table, detailLevel, !!collapsedMap[table.name]);
    dims.set(table.name, dim);
    totalStack += dim.height + VERTICAL_SPACING;
  }

  /**
   * How tall one column may get before the layer spills into another one.
   *
   * Without this, layering alone decides the shape — and the layering here puts most tables in a
   * handful of layers, so 320 tables came out **5580 x 17460**: a ribbon three times taller than
   * it is wide, which cannot be fitted on any screen (fit-to-view clamped at the minimum zoom and
   * still showed a sliver) and which reduces the minimap to a 44px strip in a 208px box.
   *
   * Solving `columns * COLUMN_PITCH = totalStack / columns` for a square-ish diagram gives the
   * column count below; the budget is then the height that many columns need. Layer order is
   * untouched — a spilled layer simply continues in the next column, so a table still sits to the
   * right of everything it references.
   */
  const columnPitch = DEFAULT_NODE_WIDTH + HORIZONTAL_SPACING;
  const columnCount = Math.max(1, Math.ceil(Math.sqrt(totalStack / columnPitch)));
  // The floor keeps a small diagram (a handful of tables) laid out exactly as before, one layer
  // per column, instead of wrapping a two-node layer.
  const columnBudget = Math.max(totalStack / columnCount, 1200);

  const positions: ERLayoutPositions = {};
  const ORIGIN = 60;
  let currentX = ORIGIN;
  let currentY = ORIGIN;
  let columnWidth = DEFAULT_NODE_WIDTH;

  const nextColumn = () => {
    currentX += columnWidth + HORIZONTAL_SPACING;
    currentY = ORIGIN;
    columnWidth = DEFAULT_NODE_WIDTH;
  };

  layers.forEach((layer) => {
    // Every layer starts its own column, which is what keeps the left-to-right reading.
    if (currentY > ORIGIN) nextColumn();

    layer.forEach((tableName) => {
      const table = tableMap.get(tableName);
      const dim = dims.get(tableName);
      if (!table || !dim) return;

      if (currentY > ORIGIN && currentY - ORIGIN + dim.height > columnBudget) nextColumn();

      positions[tableName] = {
        x: currentX,
        y: currentY,
        width: dim.width,
        height: dim.height,
        isCollapsed: !!collapsedMap[tableName],
      };

      currentY += dim.height + VERTICAL_SPACING;
      columnWidth = Math.max(columnWidth, dim.width);
    });
  });

  return positions;
}

/**
 * Calculates exact SVG socket anchor point for a specific column in a table node.
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

  let visibleColumns = table.columns;
  if (detailLevel === 'keys_only') {
    visibleColumns = table.columns.filter((col) => col.isPrimaryKey || col.isForeignKey);
    if (visibleColumns.length === 0) visibleColumns = table.columns.slice(0, 3);
  } else if (detailLevel === 'compact') {
    visibleColumns = table.columns.slice(0, 5);
  }

  const colIndex = visibleColumns.findIndex((col) => col.name.toLowerCase() === columnName.toLowerCase());
  const actualIndex = colIndex !== -1 ? colIndex : 0;

  const y = nodePos.y + HEADER_HEIGHT + actualIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  const x = side === 'left' ? nodePos.x : nodePos.x + nodePos.width;

  return { x, y };
}

/**
 * Computes smooth Cubic Bezier path between source socket and target socket.
 */
export function computeBezierPath(
  source: { x: number; y: number },
  target: { x: number; y: number }
): string {
  const dx = target.x - source.x;
  const curvature = Math.max(Math.min(Math.abs(dx) * 0.5, 180), 40);

  const cx1 = source.x + (dx >= 0 ? curvature : -curvature);
  const cy1 = source.y;
  const cx2 = target.x - (dx >= 0 ? curvature : -curvature);
  const cy2 = target.y;

  return `M ${source.x} ${source.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${target.x} ${target.y}`;
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
 * Every connector as straight segments of ONE path.
 *
 * For the zoomed-out level of detail, where no connector can be hovered, highlighted or dimmed
 * individually and a curve is indistinguishable from a line. A few hundred `<path>` elements
 * become one: that is a few hundred fewer DOM nodes, memo comparisons and stroked paths, and it
 * is the difference that matters in the one case culling cannot help with — the whole diagram
 * fitted on screen, where every connector there is has to be drawn.
 */
export function buildFlatConnectorPath(
  relationships: ERRelationship[],
  positions: ERLayoutPositions,
  tables: Map<string, ERTable>,
  detailLevel: ERDetailLevel = 'full'
): string {
  const parts: string[] = [];
  for (const rel of relationships) {
    const sourceTable = tables.get(rel.sourceTable);
    const targetTable = tables.get(rel.targetTable);
    const sourcePos = positions[rel.sourceTable];
    const targetPos = positions[rel.targetTable];
    if (!sourceTable || !targetTable || !sourcePos || !targetPos) continue;

    const { source, target } = connectorSockets(
      rel,
      sourceTable,
      targetTable,
      sourcePos,
      targetPos,
      detailLevel
    );
    parts.push(`M ${source.x} ${source.y} L ${target.x} ${target.y}`);
  }
  return parts.join(' ');
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
