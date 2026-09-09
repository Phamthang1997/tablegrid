import { describe, it, expect } from 'vitest';
import {
  buildFlatConnectorPath,
  computeAutoLayout,
  calculateNodeDimensions,
  connectorSockets,
  getColumnSocketPosition,
  computeBezierPath,
  computeDiagramBounds,
} from '../erLayoutEngine';
import { exportToMermaid, exportToDbml, exportToSql, generateFullDiagramSvg } from '../erExportHelper';
import type { ERTable, ERRelationship } from '../erTypes';

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

  it('does not wrap a small schema, so one layer stays one column', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    const columns = new Set(Object.values(layout).map((pos) => pos.x));
    // store | customer | payment, and then the tables with no foreign key at all.
    expect(columns.size).toBe(4);
  });

  it('packs the tables with no foreign key after the flow, not into it', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    // `isolated_log` has an in-degree of zero like `store` does, so it used to share layer 0
    // with it and push the real root tables down a column they had no reason to be long.
    expect(layout['isolated_log'].x).toBeGreaterThan(layout['payment'].x);
    expect(layout['store'].y).toBe(layout['customer'].y);
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

  it('keeps a module together and orders the layer by its neighbours', () => {
    // Two disjoint chains of three. Whatever order the tables arrive in, each chain has to
    // come out contiguous rather than interleaved with the other one.
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
    // Each chain is three layers deep, so the two heads share the first column, and so on.
    expect(layout['a0'].x).toBe(layout['b0'].x);
    expect(layout['a1'].x).toBe(layout['b1'].x);
    expect(layout['a0'].x).toBeLessThan(layout['a1'].x);
    expect(layout['a1'].x).toBeLessThan(layout['a2'].x);
    // And a chain keeps the same side of its column in every layer, which is what "the
    // module stays together" means once the layers are columns.
    const aSide = layout['a0'].y < layout['b0'].y;
    expect(layout['a1'].y < layout['b1'].y).toBe(aSide);
    expect(layout['a2'].y < layout['b2'].y).toBe(aSide);
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

  it('flattens every connector into one path, skipping the ones it cannot place', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    const tableMap = new Map(mockTables.map((table) => [table.name, table]));

    const d = buildFlatConnectorPath(mockRelationships, layout, tableMap, 'full');
    // One `M ... L ...` per relationship, and straight segments only.
    expect(d.match(/M /g)).toHaveLength(mockRelationships.length);
    expect(d.match(/L /g)).toHaveLength(mockRelationships.length);
    expect(d).not.toContain('C ');

    // Endpoints agree with the per-connector geometry, so lines cannot jump when the level of
    // detail crosses the threshold between the two renderers.
    const first = mockRelationships[0];
    const sockets = connectorSockets(
      first,
      tableMap.get(first.sourceTable)!,
      tableMap.get(first.targetTable)!,
      layout[first.sourceTable],
      layout[first.targetTable],
      'full'
    );
    expect(d).toContain(`M ${sockets.source.x} ${sockets.source.y}`);

    // A relationship naming a table that is not in the diagram is dropped, not drawn to 0,0.
    const dangling = buildFlatConnectorPath(
      [{ ...first, id: 'x', targetTable: 'not_here' }],
      layout,
      tableMap,
      'full'
    );
    expect(dangling).toBe('');
  });

  it('computes valid Cubic Bezier SVG path', () => {
    const path = computeBezierPath({ x: 100, y: 150 }, { x: 400, y: 250 });
    expect(path).toMatch(/^M 100 150 C \d+ \d+, \d+ \d+, 400 250$/);
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
