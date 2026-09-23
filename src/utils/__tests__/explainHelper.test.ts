import { describe, it, expect } from 'vitest';
import {
  buildExplainQuery, explainJsonLabel, flagSeverity, parseExplainOutput, summarizePlan, supportsJsonExplain,
  type ExplainNode,
} from '../explainHelper';

describe('buildExplainQuery', () => {
  const sql = 'SELECT 1;';

  it('gives the json variant something the plain one does not, per dialect', () => {
    // Postgres answers JSON for every variant, so `json` has to differ or the menu entry lies.
    expect(buildExplainQuery(sql, 'postgres', 'explain')).toBe('EXPLAIN (FORMAT JSON) SELECT 1;');
    expect(buildExplainQuery(sql, 'postgres', 'json')).toBe('EXPLAIN (FORMAT JSON, VERBOSE, SETTINGS) SELECT 1;');
    expect(buildExplainQuery(sql, 'postgres', 'json')).not.toBe(buildExplainQuery(sql, 'postgres', 'explain'));

    expect(buildExplainQuery(sql, 'mysql', 'explain')).toBe('EXPLAIN SELECT 1;');
    expect(buildExplainQuery(sql, 'mysql', 'json')).toBe('EXPLAIN FORMAT=JSON SELECT 1;');
  });

  it('has nothing extra to offer on SQLite, so the entry is hidden there', () => {
    expect(supportsJsonExplain('sqlite')).toBe(false);
    expect(supportsJsonExplain('mysql')).toBe(true);
    expect(supportsJsonExplain('postgres')).toBe(true);
    // Every SQLite variant collapses to the same statement.
    expect(buildExplainQuery(sql, 'sqlite', 'json')).toBe(buildExplainQuery(sql, 'sqlite', 'explain'));
  });

  it('labels the menu entry with the statement it will run', () => {
    expect(explainJsonLabel('mysql')).toBe('EXPLAIN FORMAT=JSON');
    expect(explainJsonLabel('postgres')).toBe('EXPLAIN (FORMAT JSON, VERBOSE, SETTINGS)');
    // The label must stay a prefix of the real statement, or it is documenting fiction.
    for (const db of ['mysql', 'postgres']) {
      expect(buildExplainQuery(sql, db, 'json')).toBe(`${explainJsonLabel(db)} ${sql}`);
    }
  });
});

// A sakila-shaped MySQL `EXPLAIN FORMAT=JSON`: filesort over a 3-table nested loop, where the
// driving table carries a residual predicate.
function mysqlJsonPlan(attachedCondition: string) {
  return {
    query_block: {
      select_id: 1,
      cost_info: { query_cost: '201.488798948022' },
      ordering_operation: {
        using_filesort: true,
        nested_loop: [
          {
            table: {
              table_name: 'a',
              access_type: 'ALL',
              rows_examined_per_scan: 200,
              rows_produced_per_join: 200,
              filtered: '100.00',
              attached_condition: attachedCondition,
              cost_info: { read_cost: '20.50', eval_cost: '2.00', prefix_cost: '22.50' },
            },
          },
          {
            table: {
              table_name: 'fa',
              access_type: 'ref',
              key: 'idx_fk_actor_id',
              used_key_parts: ['actor_id'],
              ref: ['sakila.a.actor_id'],
              rows_examined_per_scan: 27,
              rows_produced_per_join: 5462,
              filtered: '100.00',
              cost_info: { read_cost: '100.00', eval_cost: '54.00', prefix_cost: '176.50' },
            },
          },
          {
            table: {
              table_name: 'f',
              access_type: 'eq_ref',
              key: 'PRIMARY',
              rows_examined_per_scan: 1,
              rows_produced_per_join: 18,
              filtered: '100.00',
              cost_info: { read_cost: '20.00', eval_cost: '4.98', prefix_cost: '201.48' },
            },
          },
        ],
      },
    },
  };
}

function rowsFor(plan: unknown) {
  return [{ EXPLAIN: JSON.stringify(plan) }];
}

function flatten(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.children || []).flatMap(flatten)];
}

function byTable(node: ExplainNode, table: string): ExplainNode {
  const hit = flatten(node).find(n => n.table === table);
  if (!hit) throw new Error(`no node for table ${table}`);
  return hit;
}

describe('parseExplainOutput — MySQL FORMAT=JSON', () => {
  const res = parseExplainOutput(rowsFor(mysqlJsonPlan("(`sakila`.`a`.`last_name` like 'A%')")), 'mysql');
  const root = res.rootNode!;

  it('keeps query_cost verbatim so the header loses no precision', () => {
    expect(res.totalCostText).toBe('201.488798948022');
    expect(res.totalCost).toBeCloseTo(201.4888, 4);
  });

  it('names the operator without folding the table name into it', () => {
    expect(root.type).toBe('Sort (Filesort)');
    expect(byTable(root, 'a').type).toBe('Table Scan');
    expect(byTable(root, 'fa').type).toBe('Index Lookup');
    expect(byTable(root, 'f').type).toBe('Unique Index Lookup');
    // The table name lives in its own field; `type` no longer carries the old "a [ALL]" shape.
    expect(byTable(root, 'a').type).not.toMatch(/[[\]]/);
    expect(byTable(root, 'a').table).toBe('a');
  });

  it('splits the residual predicate into its own cost-free Filter step', () => {
    const filter = flatten(root).find(n => n.type === 'Filter')!;
    expect(filter.filter).toContain('last_name');
    expect(filter.children?.[0].table).toBe('a');
    // Giving the Filter the table's prefix_cost would steal cost from the joined tables.
    expect(filter.selfCost).toBe(0);
  });

  it('derives self cost per operator, and the badges add up to 100%', () => {
    // MySQL table nodes expose read_cost + eval_cost, which already is the self cost.
    expect(byTable(root, 'a').selfCost).toBeCloseTo(22.5, 6);
    expect(byTable(root, 'fa').selfCost).toBeCloseTo(154, 6);
    expect(byTable(root, 'f').selfCost).toBeCloseTo(24.98, 6);

    // Containers only keep what is left after their children — never the cumulative total.
    for (const join of flatten(root).filter(n => n.type === 'Nested Loop Join')) {
      expect(join.selfCost).toBe(0);
    }
    // The block's residual moved onto Stream, so the Sort above it accounts for nothing itself.
    const stream = flatten(root).find(n => n.type === 'Stream')!;
    expect(stream.selfCost).toBeCloseTo(201.488798948022 - 201.48, 6);
    expect(root.selfCost).toBe(0);

    const pctSum = flatten(root)
      .reduce((sum, n) => sum + ((n.selfCost || 0) / res.totalSelfCost!) * 100, 0);
    expect(pctSum).toBeCloseTo(100, 6);
  });

  it('splits the flat nested_loop array into one binary join per step', () => {
    // 3 tables joined => 2 Nested Loop nodes, left-deep, so the diagram grows wider not taller.
    const joins = flatten(root).filter(n => n.type === 'Nested Loop Join');
    expect(joins).toHaveLength(2);
    for (const join of joins) {
      expect(join.children).toHaveLength(2);
    }
    // children[0] is the accumulated join, so the deepest chain runs along the diagram's top row.
    const outer = joins.find(j => j.id === 'n0.0.0')!;
    expect(outer.children![0].type).toBe('Nested Loop Join');
    expect(outer.children![1].table).toBe('f');
    // Cumulative cost of a join step is the prefix_cost of the table it brings in.
    expect(outer.cost!.total).toBeCloseTo(201.48, 6);
  });

  it('says which tables each join step combines, and on what', () => {
    const inner = flatten(root).find(j => j.id === 'n0.0.0.0')!;
    const outer = flatten(root).find(j => j.id === 'n0.0.0')!;

    // The inner step joins the driving table to fa; the outer one adds f on top of both.
    expect(inner.joinTables).toEqual({ left: ['a'], right: 'fa' });
    expect(outer.joinTables).toEqual({ left: ['a', 'fa'], right: 'f' });

    // Built from the right table's `used_key_parts` and `ref` — the server's own words.
    expect(inner.joinFilter).toBe('fa.actor_id = sakila.a.actor_id');
  });

  it('claims no join condition when the other side is not a column', () => {
    const constRef = parseExplainOutput(
      rowsFor({
        query_block: {
          select_id: 1,
          nested_loop: [
            { table: { table_name: 'a', access_type: 'ALL', rows_examined_per_scan: 5 } },
            { table: { table_name: 'f', access_type: 'eq_ref', key: 'PRIMARY', used_key_parts: ['film_id'], ref: ['const'], rows_examined_per_scan: 1 } },
          ],
        },
      }),
      'mysql',
    );
    const join = flatten(constRef.rootNode!).find(n => n.type === 'Nested Loop Join')!;
    expect(join.joinTables).toEqual({ left: ['a'], right: 'f' });
    expect(join.joinFilter).toBeUndefined();
  });

  it('puts the block residual in its own Stream step, between the sort and the join', () => {
    expect(root.type).toBe('Sort (Filesort)');
    const stream = root.children![0];
    expect(stream.type).toBe('Stream');
    expect(stream.children![0].type).toBe('Nested Loop Join');
    // The residual is real: query_cost minus what the join below accounts for.
    expect(stream.details!.residual_cost).toBeCloseTo(201.488798948022 - 201.48, 6);
  });

  it('labels arrows with rows handed upwards, not rows read per scan', () => {
    const joins = flatten(root).filter(n => n.type === 'Nested Loop Join');
    const inner = joins.find(j => j.id === 'n0.0.0.0')!;
    const outer = joins.find(j => j.id === 'n0.0.0')!;

    // The driving table emits everything it produces...
    expect(byTable(root, 'a').rowsOut).toBe(200);
    // ...while rows_produced_per_join of a joined table describes the join step, not the table:
    // it is cumulative over the whole prefix.
    expect(inner.rowsOut).toBe(5462);
    expect(outer.rowsOut).toBe(18);
    // An inner-loop table only hands up its own per-scan rows (examined × filtered).
    expect(byTable(root, 'fa').rowsOut).toBe(27);
    expect(byTable(root, 'f').rowsOut).toBe(1);
    // `rows` keeps meaning "read per scan" for the detail panel.
    expect(byTable(root, 'fa').rows).toBe(27);
  });

  it('gives every node an id derived from its position in the tree', () => {
    expect(flatten(root).map(n => n.id)).toEqual([
      'n0', 'n0.0', 'n0.0.0', 'n0.0.0.0', 'n0.0.0.0.0', 'n0.0.0.0.0.0', 'n0.0.0.0.1', 'n0.0.0.1',
    ]);
    // Same input parsed twice must produce the same ids, or the diagram remounts on every parse.
    const again = parseExplainOutput(rowsFor(mysqlJsonPlan('(1 = 1)')), 'mysql');
    expect(flatten(again.rootNode!).map(n => n.id)).toEqual(flatten(root).map(n => n.id));
  });

  it('does not mistake a JSON path operator in a predicate for a text plan', () => {
    // `->` used to route the whole JSON document into the EXPLAIN ANALYZE text parser.
    const withJsonPath = parseExplainOutput(
      rowsFor(mysqlJsonPlan("(json_unquote(`a`.`meta`->'$.tier') = 'gold')")),
      'mysql',
    );
    expect(withJsonPath.rootNode!.type).toBe('Sort (Filesort)');
    expect(withJsonPath.totalCostText).toBe('201.488798948022');
  });
});

describe('parseExplainOutput — index attribution and signals', () => {
  it('never reports a candidate index as the one that was chosen', () => {
    const res = parseExplainOutput(
      rowsFor({
        query_block: {
          select_id: 1,
          table: {
            table_name: 's',
            access_type: 'ALL',
            possible_keys: ['PRIMARY', 'idx_fk_address_id'],
            key: null,
            rows_examined_per_scan: 2,
            cost_info: { read_cost: '0.25', eval_cost: '0.20', prefix_cost: '0.45' },
          },
        },
      }),
      'mysql',
    );
    const node = res.rootNode!;
    // The old code fell back to possible_keys here and rendered "no index used" as a chosen index.
    expect(node.indexName).toBeUndefined();
    expect(node.candidateIndexes).toEqual(['PRIMARY', 'idx_fk_address_id']);
    expect(node.flags).toContain('fullTableScan');
  });

  it('reads the signals MySQL only reports as flags', () => {
    const res = parseExplainOutput(
      rowsFor({
        query_block: {
          select_id: 1,
          table: {
            table_name: 'fa',
            access_type: 'ref',
            key: 'idx_fk_film_id',
            using_index: true,
            index_condition: '(`fa`.`film_id` = 1)',
            using_join_buffer: 'hash join',
            rows_examined_per_scan: 5,
            cost_info: { read_cost: '1.00', eval_cost: '0.50', prefix_cost: '1.50' },
          },
        },
      }),
      'mysql',
    );
    expect(res.rootNode!.flags).toEqual(
      expect.arrayContaining(['coveringIndex', 'indexCondition', 'joinBuffer']),
    );
    expect(res.rootNode!.flags).not.toContain('fullTableScan');
  });

  it('keeps UNION branches in the tree instead of dropping them', () => {
    const branch = (name: string) => ({
      query_block: {
        select_id: 1,
        table: { table_name: name, access_type: 'ALL', rows_examined_per_scan: 3 },
      },
    });
    const res = parseExplainOutput(
      rowsFor({ query_block: { union_result: { using_temporary_table: true, query_specifications: [branch('a'), branch('b')] } } }),
      'mysql',
    );
    expect(res.rootNode!.type).toBe('Union');
    expect(res.rootNode!.children!.map(c => c.table)).toEqual(['a', 'b']);
  });

  it('pulls a materialised subquery into the diagram', () => {
    const res = parseExplainOutput(
      rowsFor({
        query_block: {
          select_id: 1,
          table: {
            table_name: 'derived2',
            access_type: 'ALL',
            rows_examined_per_scan: 10,
            materialized_from_subquery: {
              query_block: { select_id: 2, table: { table_name: 'film', access_type: 'ALL', rows_examined_per_scan: 1000 } },
            },
          },
        },
      }),
      'mysql',
    );
    expect(res.rootNode!.children![0].table).toBe('film');
  });
});

describe('parseExplainOutput — EXPLAIN ANALYZE actuals', () => {
  const res = parseExplainOutput(
    [{
      EXPLAIN: [
        '-> Nested loop inner join  (cost=100.00 rows=200) (actual time=0.10..5.00 rows=180 loops=1)',
        '    -> Table scan on a  (cost=20.00 rows=200) (actual time=0.05..1.00 rows=200 loops=1)',
        '    -> Index lookup on fa using idx (cost=0.40 rows=2) (actual time=0.01..0.02 rows=90 loops=200)',
        '    -> Index lookup on skipped using PRIMARY (cost=0.30 rows=1) (never executed)',
      ].join('\n'),
    }],
    'mysql',
  );
  const nodes = flatten(res.rootNode!);

  it('captures loops, because the reported rows are per loop', () => {
    const inner = nodes.find(n => n.table === 'fa')!;
    expect(inner.actualRows).toBe(90);
    expect(inner.actualLoops).toBe(200);
    // 90 per loop × 200 loops. Reporting 90 made an 18,000-row operator look tiny.
    expect(inner.actualRowsTotal).toBe(18000);
  });

  it('flags an estimate that is far off the measurement', () => {
    const inner = nodes.find(n => n.table === 'fa')!;
    expect(inner.estimateRatio).toBeCloseTo(45, 6);
    expect(inner.flags).toContain('rowsMisestimated');

    // 200 estimated vs 200 measured — nothing to flag.
    const driving = nodes.find(n => n.table === 'a')!;
    expect(driving.estimateRatio).toBe(1);
    expect(driving.flags ?? []).not.toContain('rowsMisestimated');
  });

  it('marks a branch that never ran', () => {
    const skipped = nodes.find(n => n.table === 'skipped')!;
    expect(skipped.flags).toContain('neverExecuted');
    expect(skipped.estimateRatio).toBeUndefined();
  });
});

describe('parseExplainOutput — MySQL tabular EXPLAIN', () => {
  const res = parseExplainOutput(
    [
      { id: 1, select_type: 'SIMPLE', table: 'a', type: 'ALL', key: null, rows: 200, Extra: 'Using where' },
      { id: 1, select_type: 'DERIVED', table: 'fa', type: 'ref', key: 'idx_fk_actor_id', rows: 27, Extra: null },
    ],
    'mysql',
  );

  it('reports no cost, which is what drives the FORMAT=JSON hint', () => {
    expect(res.totalCostText).toBeUndefined();
    expect(res.totalSelfCost).toBe(0);
  });

  it('maps access types to operator names and qualifies non-SIMPLE selects', () => {
    const nodes = flatten(res.rootNode!);
    expect(nodes.find(n => n.table === 'a')!.type).toBe('Table Scan');
    expect(nodes.find(n => n.table === 'fa')!.type).toBe('Index Lookup (DERIVED)');
  });
});

describe('parseExplainOutput — PostgreSQL FORMAT JSON', () => {
  const res = parseExplainOutput(
    [{
      'QUERY PLAN': JSON.stringify([{
        Plan: {
          'Node Type': 'Hash Join',
          'Startup Cost': 1.5,
          'Total Cost': 100,
          'Plan Rows': 42,
          Plans: [
            { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Startup Cost': 0, 'Total Cost': 60, 'Plan Rows': 1000 },
            { 'Node Type': 'Hash', 'Startup Cost': 0, 'Total Cost': 25, 'Plan Rows': 30 },
          ],
        },
        'Planning Time': 0.2,
        'Execution Time': 12.5,
      }]),
    }],
    'postgres',
  );

  it('takes the total cost from the root plan node', () => {
    expect(res.totalCost).toBe(100);
    expect(res.totalCostText).toBe('100');
    expect(res.planningTimeMs).toBe(0.2);
    expect(res.executionTimeMs).toBe(12.5);
  });

  it('subtracts children, because PostgreSQL Total Cost is cumulative', () => {
    const root = res.rootNode!;
    expect(root.selfCost).toBeCloseTo(100 - 85, 6);
    expect(flatten(root).find(n => n.table === 'orders')!.selfCost).toBe(60);
    expect(res.totalSelfCost).toBeCloseTo(100, 6);
  });
});

describe('cartesianJoin — a join step with nothing to join on', () => {
  it('reads MySQL\'s own "(no condition)" out of a tree/ANALYZE plan', () => {
    const res = parseExplainOutput([{ EXPLAIN: [
      '-> Inner hash join (no condition)  (cost=20084 rows=99000)',
      '    -> Filter: (f.film_id < 100)  (cost=10.2 rows=99)',
      '        -> Index range scan on F using PRIMARY over (film_id < 100)  (cost=10.2 rows=99)',
      '    -> Hash',
      '        -> Inner hash join (fc.category_id = category.category_id)  (cost=350 rows=1000)',
    ].join('\n') }], 'mysql');
    const joins = flatten(res.rootNode!).filter(n => /hash join/i.test(n.type));
    expect(joins[0].flags).toContain('cartesianJoin');
    // A hash join that names its condition is an ordinary join.
    expect(joins[1].flags ?? []).not.toContain('cartesianJoin');
  });

  const twoTables = (right: Record<string, unknown>) => parseExplainOutput(rowsFor({
    query_block: {
      nested_loop: [
        { table: { table_name: 'a', access_type: 'ALL', rows_examined_per_scan: 100 } },
        { table: { table_name: 'b', rows_examined_per_scan: 50, ...right } },
      ],
    },
  }), 'mysql').rootNode!;

  it('flags a MySQL JSON step whose right table is read with no ref and no attached condition', () => {
    const join = twoTables({ access_type: 'ALL', using_join_buffer: 'hash join' });
    expect(join.type).toBe('Nested Loop Join');
    expect(join.flags).toContain('cartesianJoin');
  });

  it('stays silent whenever something could be joining the two sides', () => {
    expect(twoTables({ access_type: 'ALL', attached_condition: '(b.a_id = a.id)' }).flags ?? []).not.toContain('cartesianJoin');
    expect(twoTables({ access_type: 'ref', ref: ['db.a.id'], used_key_parts: ['a_id'] }).flags ?? []).not.toContain('cartesianJoin');
    expect(twoTables({ access_type: 'eq_ref', key: 'PRIMARY' }).flags ?? []).not.toContain('cartesianJoin');
    expect(twoTables({ access_type: 'ALL', range_checked_for_each_record: 'index map: 0x1' }).flags ?? []).not.toContain('cartesianJoin');
    // One row multiplies nothing.
    expect(twoTables({ access_type: 'ALL', rows_examined_per_scan: 1 }).flags ?? []).not.toContain('cartesianJoin');
  });

  const pgLoop = (inner: Record<string, unknown>, joinFilter?: string) => parseExplainOutput([{
    'QUERY PLAN': JSON.stringify([{ Plan: {
      'Node Type': 'Nested Loop', 'Total Cost': 10, ...(joinFilter ? { 'Join Filter': joinFilter } : {}),
      Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'a', 'Total Cost': 1 }, inner],
    } }]),
  }], 'postgres').rootNode!;

  it('flags a Postgres Nested Loop that rescans an unparameterised inner side', () => {
    expect(pgLoop({ 'Node Type': 'Materialize', 'Total Cost': 2 }).flags).toContain('cartesianJoin');
    expect(pgLoop({ 'Node Type': 'Seq Scan', 'Relation Name': 'b', 'Total Cost': 2 }).flags).toContain('cartesianJoin');
  });

  it('leaves a Postgres Nested Loop alone when a condition or an index can join it', () => {
    expect(pgLoop({ 'Node Type': 'Materialize' }, '(a.id = b.a_id)').flags ?? []).not.toContain('cartesianJoin');
    expect(pgLoop({ 'Node Type': 'Index Scan', 'Index Cond': '(b.a_id = a.id)' }).flags ?? []).not.toContain('cartesianJoin');
    // A Filter on the inner scan may reference the outer row, so it is not provably a cross join.
    expect(pgLoop({ 'Node Type': 'Seq Scan', Filter: '(b.a_id = a.id)' }).flags ?? []).not.toContain('cartesianJoin');
  });

  it('outranks every other warning', () => {
    expect(flagSeverity(['fullTableScan', 'cartesianJoin'])).toBe('danger');
    expect(flagSeverity(['fullTableScan'])).toBe('warn');
    expect(flagSeverity(['coveringIndex'])).toBe('good');
    expect(flagSeverity(['subqueriesHidden'])).toBe('muted');
  });
});

describe('summarizePlan', () => {
  const node = (id: string, extra: Partial<ExplainNode>, children: ExplainNode[] = []): ExplainNode =>
    ({ id, type: id, children, ...extra });

  it('names the costliest operator and lists warning kinds worst first, with where they start', () => {
    const root = node('root', { selfCost: 5, rowsOut: 10 }, [
      node('scan1', { selfCost: 20, rowsOut: 900, flags: ['fullTableScan'] }),
      node('join', { selfCost: 70, rowsOut: 99000, flags: ['cartesianJoin', 'joinBuffer'] }, [
        node('scan2', { selfCost: 5, flags: ['fullTableScan', 'coveringIndex'] }),
      ]),
    ]);
    const s = summarizePlan(root, 100);
    expect(s.hottest).toEqual({ id: 'join', type: 'join', pct: 70 });
    expect(s.issues).toEqual([
      { flag: 'cartesianJoin', count: 1, firstId: 'join' },
      { flag: 'fullTableScan', count: 2, firstId: 'scan1' },
      { flag: 'joinBuffer', count: 1, firstId: 'join' },
    ]);
    expect(s.maxRows).toBe(99000);
  });

  it('claims no hot spot for a plan without cost', () => {
    const s = summarizePlan(node('root', {}, [node('a', { rows: 3 })]), 0);
    expect(s.hottest).toBeUndefined();
    expect(s.issues).toEqual([]);
    expect(s.maxRows).toBe(3);
  });
});
