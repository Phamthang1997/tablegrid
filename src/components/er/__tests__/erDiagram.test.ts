import { describe, it, expect } from 'vitest';
import {
  computeAutoLayout,
  calculateNodeDimensions,
  connectorSockets,
  getColumnSocketPosition,
  computeBezierPath,
  computeBezierControls,
  computeDiagramBounds,
  HEADER_HEIGHT,
  ROW_HEIGHT,
} from '../erLayoutEngine';
import { exportToMermaid, exportToDbml, exportToSql, generateFullDiagramSvg } from '../erExportHelper';
import type { ERTable, ERRelationship, ERLayoutPositions } from '../erTypes';

const mockTables: ERTable[] = [
  {
    id: 'customer',
    name: 'customer',
    columns: [
      { name: 'customer_id', type: 'int', isPrimaryKey: true, isForeignKey: false },
      { name: 'store_id', type: 'int', isPrimaryKey: false, isForeignKey: true, refTable: 'store', refColumn: 'store_id' },
      { name: 'first_name', type: 'varchar(45)', isPrimaryKey: false, isForeignKey: false },
      { name: 'email', type: 'varchar(50)', isPrimaryKey: false, isForeignKey: false, nullable: true },
    ],
  },
  {
    id: 'payment',
    name: 'payment',
    columns: [
      { name: 'payment_id', type: 'int', isPrimaryKey: true, isForeignKey: false },
      { name: 'customer_id', type: 'int', isPrimaryKey: false, isForeignKey: true, refTable: 'customer', refColumn: 'customer_id' },
      { name: 'amount', type: 'decimal(5,2)', isPrimaryKey: false, isForeignKey: false },
    ],
  },
  {
    id: 'store',
    name: 'store',
    columns: [
      { name: 'store_id', type: 'int', isPrimaryKey: true, isForeignKey: false },
      { name: 'manager_staff_id', type: 'int', isPrimaryKey: false, isForeignKey: false },
    ],
  },
  {
    id: 'isolated_log',
    name: 'isolated_log',
    columns: [
      { name: 'log_id', type: 'bigint', isPrimaryKey: true, isForeignKey: false },
      { name: 'message', type: 'text', isPrimaryKey: false, isForeignKey: false },
    ],
  },
];

const mockRelationships: ERRelationship[] = [
  {
    id: 'payment.customer_id->customer.customer_id',
    name: 'fk_payment_customer',
    sourceTable: 'payment',
    sourceColumn: 'customer_id',
    targetTable: 'customer',
    targetColumn: 'customer_id',
  },
  {
    id: 'customer.store_id->store.store_id',
    name: 'fk_customer_store',
    sourceTable: 'customer',
    sourceColumn: 'store_id',
    targetTable: 'store',
    targetColumn: 'store_id',
  },
];

const boxOf = (layout: ERLayoutPositions, names: string[]) => ({
  minX: Math.min(...names.map((name) => layout[name].x)),
  minY: Math.min(...names.map((name) => layout[name].y)),
  maxX: Math.max(...names.map((name) => layout[name].x + layout[name].width)),
  maxY: Math.max(...names.map((name) => layout[name].y + layout[name].height)),
});

type Box = ReturnType<typeof boxOf>;
const overlaps = (a: Box, b: Box) =>
  a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

describe('erLayoutEngine', () => {
  it('calculates correct node dimensions for different detail levels', () => {
    const fullDim = calculateNodeDimensions(mockTables[0], 'full', false);
    expect(fullDim.width).toBe(260);
    expect(fullDim.height).toBe(38 + 4 * 24 + 6);

    const keysOnlyDim = calculateNodeDimensions(mockTables[0], 'keys_only', false);
    expect(keysOnlyDim.height).toBe(38 + 2 * 24 + 6);

    const collapsedDim = calculateNodeDimensions(mockTables[0], 'full', true);
    expect(collapsedDim.height).toBe(38);
  });

  it('computes hierarchical auto-layout without overlap', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');

    expect(layout['store']).toBeDefined();
    expect(layout['customer']).toBeDefined();
    expect(layout['payment']).toBeDefined();
    expect(layout['isolated_log']).toBeDefined();

    expect(layout['store'].x).toBeLessThan(layout['customer'].x);
    expect(layout['customer'].x).toBeLessThan(layout['payment'].x);
  });

  it('keeps a large schema roughly screen-shaped instead of a tall ribbon', () => {
    // The layering puts most tables into a handful of layers, so before the column budget a
    // 320-table schema came out 5580x17460 — three times taller than wide, which no fit-to-view
    // could show (it clamped at the minimum zoom) and which squeezed the minimap into a strip.
    const tables: ERTable[] = [];
    const rels: ERRelationship[] = [];
    for (let i = 0; i < 320; i++) {
      tables.push({
        id: `t${i}`,
        name: `t${i}`,
        columns: Array.from({ length: 10 }, (_, c) => ({
          name: `c${c}`,
          type: 'int',
          isPrimaryKey: c === 0,
          isForeignKey: false,
        })),
      });
      if (i > 0) {
        rels.push({
          id: `r${i}`,
          sourceTable: `t${i}`,
          sourceColumn: 'c1',
          targetTable: `t${i % 17}`,
          targetColumn: 'c0',
        });
      }
    }

    const layout = computeAutoLayout(tables, rels, 'full');
    expect(Object.keys(layout)).toHaveLength(320);

    const bounds = computeDiagramBounds(layout);
    const aspect = bounds.width / bounds.height;
    expect(aspect).toBeGreaterThan(0.6);
    expect(aspect).toBeLessThan(3);

    // No two nodes may share a spot: a column that wraps must move sideways, not overlap.
    const spots = new Set(Object.values(layout).map((pos) => `${pos.x},${pos.y}`));
    expect(spots.size).toBe(320);
  });

  it('gives one column per layer in a small schema', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    // store | customer | payment, and then the tables with no foreign key at all.
    const columns = new Set(Object.values(layout).map((pos) => pos.x));
    expect(columns.size).toBe(4);
    expect(layout['store'].y).toBe(layout['customer'].y);
  });

  it('keeps the tables with no foreign key out of the flow entirely', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    // `isolated_log` has an in-degree of zero like `store` does, so it used to share layer 0
    // with it and stretch a column the real root tables had no reason to be in. Asserted as
    // "outside the flow's box" rather than "to the right of it", because which side the
    // packing puts it on is not the point.
    const flow = boxOf(layout, ['store', 'customer', 'payment']);
    const alone = boxOf(layout, ['isolated_log']);
    expect(overlaps(flow, alone)).toBe(false);
  });

  it('breaks a circular reference instead of letting a table outrun its parents', () => {
    // Two tables referencing each other have no valid layering. The old code coped by
    // admitting a child before its parents whenever the next layer was small, which also
    // created backwards edges in schemas that had no cycle at all.
    const cyclic: ERRelationship[] = [
      ...mockRelationships,
      {
        id: 'store.manager_staff_id->customer.customer_id',
        sourceTable: 'store',
        sourceColumn: 'manager_staff_id',
        targetTable: 'payment',
        targetColumn: 'payment_id',
      },
    ];
    const layout = computeAutoLayout(mockTables, cyclic, 'full');
    expect(Object.keys(layout)).toHaveLength(mockTables.length);
    const spots = new Set(Object.values(layout).map((pos) => `${pos.x},${pos.y}`));
    expect(spots.size).toBe(mockTables.length);
  });

  it('lays out each module as its own block, layered inside it', () => {
    // Two disjoint chains of three. They are two modules, so they get two blocks — and the
    // left-to-right reading has to hold INSIDE each one.
    const tables: ERTable[] = [];
    const rels: ERRelationship[] = [];
    for (const group of ['a', 'b']) {
      for (let i = 0; i < 3; i++) {
        tables.push({
          id: `${group}${i}`,
          name: `${group}${i}`,
          columns: [{ name: 'id', type: 'int', isPrimaryKey: true, isForeignKey: false }],
        });
        if (i > 0) {
          rels.push({
            id: `${group}${i}_fk`,
            sourceTable: `${group}${i}`,
            sourceColumn: 'id',
            targetTable: `${group}${i - 1}`,
            targetColumn: 'id',
          });
        }
      }
    }

    const layout = computeAutoLayout(tables, rels, 'full');

    // Layered within a block: each table sits right of the one it references.
    expect(layout['a0'].x).toBeLessThan(layout['a1'].x);
    expect(layout['a1'].x).toBeLessThan(layout['a2'].x);
    expect(layout['b0'].x).toBeLessThan(layout['b1'].x);
    expect(layout['b1'].x).toBeLessThan(layout['b2'].x);

    // And the two blocks do not interleave — that is the whole point of a block.
    const a = boxOf(layout, ['a0', 'a1', 'a2']);
    const b = boxOf(layout, ['b0', 'b1', 'b2']);
    expect(overlaps(a, b)).toBe(false);
  });

  it('computes correct column socket positions', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    const socket = getColumnSocketPosition(
      layout['customer'],
      mockTables[0],
      'store_id',
      'right',
      'full'
    );

    expect(socket.x).toBe(layout['customer'].x + layout['customer'].width);
    expect(socket.y).toBe(layout['customer'].y + 74);
  });

  it('resolves a socket row case-insensitively, and per detail level', () => {
    // The row lookup is memoized per (table, detail level) because the canvas asks for both
    // sockets of every visible connector on every frame. These are the three answers the
    // memoized version has to keep giving.
    const pos = { x: 0, y: 0, width: 260, height: 400 };
    const table = mockTables[0];
    const column = table.columns[table.columns.length - 1];

    const exact = getColumnSocketPosition(pos, table, column.name, 'right', 'full');
    const shouty = getColumnSocketPosition(pos, table, column.name.toUpperCase(), 'right', 'full');
    expect(shouty.y).toBe(exact.y);
    // Its row is the last one, not the fallback.
    expect(exact.y).toBe(HEADER_HEIGHT + (table.columns.length - 1) * ROW_HEIGHT + ROW_HEIGHT / 2);

    // A column the level does not show anchors on the FIRST row rather than off the card, and
    // the same name can therefore resolve differently per level — which is why the memo is
    // keyed by both.
    const firstRowY = HEADER_HEIGHT + ROW_HEIGHT / 2;
    expect(getColumnSocketPosition(pos, table, 'nope', 'right', 'full').y).toBe(firstRowY);
    const keysOnly = getColumnSocketPosition(pos, table, column.name, 'right', 'keys_only');
    expect(keysOnly.y).toBeLessThanOrEqual(exact.y);

    // A collapsed card has no rows at all: every socket meets the header.
    const collapsed = getColumnSocketPosition(
      { ...pos, isCollapsed: true },
      table,
      column.name,
      'left',
      'full'
    );
    expect(collapsed).toEqual({ x: pos.x, y: pos.y + HEADER_HEIGHT / 2 });
  });

  it('picks the connector sides from where the two cards actually are', () => {
    const left = { x: 0, y: 0, width: 260, height: 200 };
    const right = { x: 500, y: 0, width: 260, height: 200 };
    const rel = mockRelationships[0];

    // Source left of target: leaves the right edge, arrives at the left one.
    const forward = connectorSockets(rel, mockTables[1], mockTables[0], left, right, 'full');
    expect(forward.source.x).toBe(260);
    expect(forward.target.x).toBe(500);

    // Reversed, so both flip.
    const backward = connectorSockets(rel, mockTables[1], mockTables[0], right, left, 'full');
    expect(backward.source.x).toBe(500);
    expect(backward.target.x).toBe(260);

    // Overlapping horizontally: both leave the right edge rather than crossing the cards.
    const overlap = { x: 40, y: 400, width: 260, height: 200 };
    const stacked = connectorSockets(rel, mockTables[1], mockTables[0], left, overlap, 'full');
    expect(stacked.source.x).toBe(260);
    expect(stacked.target.x).toBe(300);
  });

  it('computes valid Cubic Bezier SVG path', () => {
    const path = computeBezierPath({ x: 100, y: 150 }, { x: 400, y: 250 });
    expect(path).toMatch(/^M 100 150 C \d+ \d+, \d+ \d+, 400 250$/);
  });

  it('spells the same curve as control points for the canvas renderer', () => {
    // The painter strokes `bezierCurveTo` and the export writes the path string. Both come from
    // one function, so a diagram can never be exported with a different shape than it had on
    // screen — see `computeBezierControls`.
    const source = { x: 100, y: 150 };
    const target = { x: 400, y: 250 };
    const b = computeBezierControls(source, target);
    expect(computeBezierPath(source, target)).toBe(
      `M ${b.x1} ${b.y1} C ${b.cx1} ${b.cy1}, ${b.cx2} ${b.cy2}, ${b.x2} ${b.y2}`
    );
    // The curve leaves its source sideways and arrives sideways, which is what puts the arrow
    // head flat against the card edge rather than at an angle.
    expect(b.cy1).toBe(source.y);
    expect(b.cy2).toBe(target.y);
    expect(b.cx1).toBeGreaterThan(source.x);
    expect(b.cx2).toBeLessThan(target.x);
  });

  it('calculates bounding box of diagram correctly', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    const bounds = computeDiagramBounds(layout);

    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.minX).toBe(60);
  });
});

describe('erExportHelper', () => {
  it('exports valid Mermaid ER diagram syntax', () => {
    const mermaid = exportToMermaid(mockTables, mockRelationships);
    expect(mermaid).toContain('erDiagram');
    expect(mermaid).toContain('store ||--o{ customer : "fk_customer_store"');
    expect(mermaid).toContain('customer ||--o{ payment : "fk_payment_customer"');
    expect(mermaid).toContain('customer {');
    expect(mermaid).toContain('int customer_id PK');
    expect(mermaid).toContain('int store_id FK');
  });

  it('exports valid DBML format', () => {
    const dbml = exportToDbml(mockTables, mockRelationships);
    expect(dbml).toContain('Table customer {');
    expect(dbml).toContain('customer_id int [pk]');
    expect(dbml).toContain('Ref: payment.customer_id > customer.customer_id');
    expect(dbml).toContain('Ref: customer.store_id > store.store_id');
  });

  it('exports valid DDL SQL with foreign key constraints', () => {
    const sql = exportToSql(mockTables, mockRelationships);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `customer`');
    expect(sql).toContain('PRIMARY KEY (`customer_id`)');
    expect(sql).toContain('ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_customer` FOREIGN KEY (`customer_id`) REFERENCES `customer` (`customer_id`);');
  });

  it('generates complete standalone SVG diagram with tables and relationship paths', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    const { svgString, width, height } = generateFullDiagramSvg(mockTables, mockRelationships, layout, 'full', 'dark');

    // Against the diagram it is exporting, not against a number: the previous thresholds
    // happened to hold for one particular layout and broke the moment it improved.
    const bounds = computeDiagramBounds(layout);
    expect(width).toBeGreaterThanOrEqual(bounds.width);
    expect(height).toBeGreaterThanOrEqual(bounds.height);
    expect(svgString).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svgString).toContain('customer');
    expect(svgString).toContain('payment');
    expect(svgString).toContain('store');
    expect(svgString).toContain('customer_id');
    expect(svgString).toContain('marker id="er-export-arrow"');
    expect(svgString).toContain('<path d="M');
  });

  it('handles empty tables for SVG generation gracefully', () => {
    const { svgString, width, height } = generateFullDiagramSvg([], [], {}, 'full', 'dark');
    expect(width).toBe(600);
    expect(height).toBe(400);
    expect(svgString).toContain('No tables to display');
  });
});
