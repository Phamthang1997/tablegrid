import { describe, it, expect } from 'vitest';
import { parseExplainOutput, type ExplainNode, type ExplainResult } from '../explainHelper';
import {
  comparePlans, planOutline, predicateAtoms, suggestIndexes, toTsv, SUGGEST_MIN_ROWS,
} from '../explainAdvisor';

const mysqlJson = (plan: unknown) => parseExplainOutput([{ EXPLAIN: JSON.stringify(plan) }], 'mysql');
const pgJson = (plan: unknown) => parseExplainOutput([{ 'QUERY PLAN': JSON.stringify([{ Plan: plan }]) }], 'postgres');

describe('predicateAtoms', () => {
  it('reads equality, range, prefix LIKE and IN on bare or qualified columns', () => {
    const atoms = predicateAtoms("((`sakila`.`f`.`rating` = 'G') and (f.length > 100) and (title like 'AB%') and (id in (1,2)))");
    expect(atoms.map(a => [a.qualifier, a.column, a.kind])).toEqual([
      ['f', 'rating', 'eq'],
      ['f', 'length', 'range'],
      [undefined, 'title', 'range'],
      [undefined, 'id', 'eq'],
    ]);
  });

  it('tells a join equality from a literal one, and unwraps a Postgres cast', () => {
    expect(predicateAtoms('(fc.film_id = f.film_id)')[0].kind).toBe('join');
    expect(predicateAtoms("((f.rating)::text = 'G'::text)")[0]).toMatchObject({ qualifier: 'f', column: 'rating', kind: 'eq' });
  });

  it('refuses what an index on the column cannot serve', () => {
    // A function around the column: an index on `email` does not serve lower(email).
    expect(predicateAtoms("(lower(u.email) = 'a@b.c')")).toEqual([]);
    // A leading wildcard cannot walk an index.
    expect(predicateAtoms("(title like '%war%')")).toEqual([]);
    // Neither index alone serves an OR.
    expect(predicateAtoms('((a = 1) or (b = 2))')).toEqual([]);
    expect(predicateAtoms('(a <> 1)')).toEqual([]);
  });
});

describe('suggestIndexes', () => {
  const scanWith = (table: Record<string, unknown>) => mysqlJson({
    query_block: {
      table: { table_name: 'f', access_type: 'ALL', rows_examined_per_scan: 1000, ...table },
    },
  }).rootNode;

  it('suggests an index on the filtered columns of a big full scan, equality before range', () => {
    const [s] = suggestIndexes(
      scanWith({ attached_condition: "((`sakila`.`f`.`length` > 100) and (`sakila`.`f`.`rating` = 'G'))" }),
      'SELECT * FROM film f WHERE f.length > 100 AND f.rating = \'G\'',
      'mysql',
    );
    expect(s.table).toBe('film');
    expect(s.alias).toBe('f');
    expect(s.columns).toEqual([{ name: 'rating', kind: 'eq' }, { name: 'length', kind: 'range' }]);
    expect(s.sql).toBe('CREATE INDEX `idx_film_rating_length` ON `film` (`rating`, `length`);');
  });

  it('stays silent when an index would not help or the plan does not say enough', () => {
    const sql = 'SELECT * FROM film f';
    // Small table: a full scan is the right plan.
    expect(suggestIndexes(scanWith({ rows_examined_per_scan: SUGGEST_MIN_ROWS - 1, attached_condition: '(f.a = 1)' }), sql, 'mysql')).toEqual([]);
    // No predicate on the table: nothing to index.
    expect(suggestIndexes(scanWith({}), sql, 'mysql')).toEqual([]);
    // The optimiser had a candidate and declined it — another index on it would be declined too.
    expect(suggestIndexes(scanWith({ possible_keys: ['idx_rating'], attached_condition: "(f.rating = 'G')" }), sql, 'mysql')).toEqual([]);
    // A derived table is not something CREATE INDEX can target.
    expect(suggestIndexes(scanWith({ table_name: '<derived2>', attached_condition: '(x = 1)' }), sql, 'mysql')).toEqual([]);
  });

  it('uses a join equality only on the inner side, where an index turns each probe into a lookup', () => {
    const root = mysqlJson({
      query_block: {
        nested_loop: [
          { table: { table_name: 'a', access_type: 'ALL', rows_examined_per_scan: 2000 } },
          { table: {
            table_name: 'b', access_type: 'ALL', rows_examined_per_scan: 5000, using_join_buffer: 'hash join',
            attached_condition: '(`db`.`b`.`a_id` = `db`.`a`.`id`)',
          } },
        ],
      },
    }).rootNode;
    const out = suggestIndexes(root, 'SELECT * FROM a JOIN b ON b.a_id = a.id', 'mysql');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ table: 'b', columns: [{ name: 'a_id', kind: 'eq' }] });
  });

  it('reads Postgres Seq Scan filters and quotes for the dialect', () => {
    const root = pgJson({
      'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 80000, 'Total Cost': 1500,
      Filter: "((status)::text = 'open'::text)",
    }).rootNode;
    const [s] = suggestIndexes(root, "SELECT * FROM orders WHERE status = 'open'", 'postgres');
    expect(s.sql).toBe('CREATE INDEX "idx_orders_status" ON "orders" ("status");');
  });

  it('reads the MySQL tree format, where the predicate sits in the Filter step\'s title', () => {
    const res = parseExplainOutput([{ EXPLAIN: [
      '-> Filter: (f.rental_rate > 2.99)  (cost=103 rows=333)',
      '    -> Table scan on f  (cost=103 rows=1000)',
    ].join('\n') }], 'mysql');
    const [s] = suggestIndexes(res.rootNode, 'SELECT * FROM film f WHERE f.rental_rate > 2.99', 'mysql');
    expect(s).toMatchObject({ table: 'film', columns: [{ name: 'rental_rate', kind: 'range' }] });
  });
});

describe('comparePlans', () => {
  const plan = (cost: number, table: Record<string, unknown>): ExplainResult => mysqlJson({
    query_block: {
      cost_info: { query_cost: String(cost) },
      table: { table_name: 'film', rows_examined_per_scan: 1000, ...table },
    },
  });

  it('reports the cost change and which table reads got better', () => {
    const before = plan(103, { access_type: 'ALL', cost_info: { read_cost: '100', eval_cost: '3' } });
    const after = plan(4, { access_type: 'ref', key: 'idx_rating', rows_examined_per_scan: 20, cost_info: { read_cost: '2', eval_cost: '2' } });
    const cmp = comparePlans(before, after);
    expect(cmp.identical).toBe(false);
    expect(cmp.costDeltaPct).toBeCloseTo(((4 - 103) / 103) * 100, 6);
    expect(cmp.tables).toEqual([expect.objectContaining({ table: 'film', verdict: 'better' })]);
    expect(cmp.tables[0].after!.index).toBe('idx_rating');
    expect(cmp.flags).toEqual([{ flag: 'fullTableScan', before: 1, after: 0 }]);
  });

  it('calls a drift of a few percent the same, and says when the plan did not change at all', () => {
    const a = plan(100, { access_type: 'ALL', cost_info: { read_cost: '100', eval_cost: '0' } });
    const b = plan(102, { access_type: 'ALL', cost_info: { read_cost: '102', eval_cost: '0' } });
    expect(comparePlans(a, b).tables[0].verdict).toBe('same');
    expect(comparePlans(a, a).identical).toBe(true);
  });

  it('lists tables that only one of the plans reads', () => {
    const one = plan(10, { access_type: 'ALL' });
    const two = mysqlJson({ query_block: { table: { table_name: 'actor', access_type: 'ALL', rows_examined_per_scan: 5 } } });
    expect(comparePlans(one, two).tables.map(d => [d.table, d.verdict])).toEqual([
      ['film', 'removed'],
      ['actor', 'added'],
    ]);
  });
});

describe('copy helpers', () => {
  it('writes TSV with tabs and newlines inside cells flattened', () => {
    expect(toTsv(['a', 'b'], [['x\ty', 1], [undefined, 'l1\nl2']])).toBe('a\tb\nx y\t1\n\tl1 l2');
  });

  it('writes the plan as an indented outline', () => {
    const root: ExplainNode = { id: 'r', type: 'Join', children: [{ id: 'a', type: 'Scan a' }, { id: 'b', type: 'Scan b' }] };
    expect(planOutline(root, n => n.type)).toBe('-> Join\n  -> Scan a\n  -> Scan b');
  });
});
