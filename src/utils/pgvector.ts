/**
 * pgvector on the frontend: reading a cell, describing it, and building a k-NN query.
 *
 * Pure — no React, no `@tauri-apps/api` — so it is tested under `__tests__/pgvector.test.ts`.
 * A cell arrives in pgvector's own text syntax (`[1,2,3]`, `{1:1.5,3:2}/5`), which the backend
 * produces from the binary wire format (`src-tauri/src/database/pgvector.rs`).
 */
import { quoteIdent } from './exportHelper';

export type VectorKind = 'vector' | 'halfvec' | 'sparsevec';

/**
 * Which pgvector type a column is, from `ColumnInfo.type` — Postgres' `format_type()`, so
 * `vector(1536)`, `halfvec`, or `ext.sparsevec(30000)` when the extension lives in another schema.
 * An array of vectors (`vector[]`) is not a vector.
 */
export function vectorKindOf(colType: string | null | undefined): VectorKind | null {
  const m = /^(?:[\w$]+\.)?(vector|halfvec|sparsevec)(?:\(\d+\))?$/i.exec((colType ?? '').trim());
  return m ? (m[1].toLowerCase() as VectorKind) : null;
}

/** The dimension a column is declared with (`vector(3)` -> 3), or null when unconstrained. */
export function declaredDim(colType: string | null | undefined): number | null {
  const m = /\((\d+)\)\s*$/.exec(colType ?? '');
  return m ? Number(m[1]) : null;
}

/** A parsed vector. `indices` are 0-based and ascending; a dense vector lists every position. */
export interface ParsedVector {
  sparse: boolean;
  dim: number;
  indices: number[];
  values: number[];
}

/**
 * Read either text form. Returns null for anything that is not one, rather than a best guess:
 * the playground refuses to run a query it would have to invent part of.
 */
export function parseVectorText(text: string): ParsedVector | null {
  const s = text.trim();
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) return null;
    const body = s.slice(1, -1).trim();
    const parts = body === '' ? [] : body.split(',');
    const values = parts.map(num);
    if (values.some((v) => v === null)) return null;
    return { sparse: false, dim: values.length, indices: values.map((_, i) => i), values: values as number[] };
  }
  const m = /^\{([^}]*)\}\s*\/\s*(\d+)$/.exec(s);
  if (!m) return null;
  const dim = Number(m[2]);
  const pairs = m[1].trim() === '' ? [] : m[1].split(',');
  const entries: [number, number][] = [];
  for (const p of pairs) {
    const [i, v] = p.split(':');
    const idx = Number((i ?? '').trim());
    const val = num(v ?? '');
    // Written 1-based, like pgvector's own output.
    if (!Number.isInteger(idx) || idx < 1 || idx > dim || val === null) return null;
    entries.push([idx - 1, val]);
  }
  entries.sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < entries.length; k++) if (entries[k][0] === entries[k - 1][0]) return null;
  return { sparse: true, dim, indices: entries.map((e) => e[0]), values: entries.map((e) => e[1]) };
}

function num(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Back to the text form for a given column kind — what is bound as the query parameter. */
export function toVectorText(v: ParsedVector, kind: VectorKind): string {
  if (kind === 'sparsevec') {
    const body = v.indices.map((i, k) => `${i + 1}:${v.values[k]}`).filter((_, k) => v.values[k] !== 0);
    return `{${body.join(',')}}/${v.dim}`;
  }
  const dense = new Array<number>(v.dim).fill(0);
  v.indices.forEach((i, k) => { dense[i] = v.values[k]; });
  return `[${dense.join(',')}]`;
}

export interface VectorStats {
  dim: number;
  /** Non-zero components. */
  nonZero: number;
  norm: number;
  min: number;
  max: number;
  mean: number;
}

/** Over all `dim` components — for a sparse vector the implicit zeros count too. */
export function vectorStats(v: ParsedVector): VectorStats {
  let sq = 0;
  let sum = 0;
  let nonZero = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const x of v.values) {
    sq += x * x;
    sum += x;
    if (x !== 0) nonZero++;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (v.values.length < v.dim) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (v.dim === 0) min = max = 0;
  return { dim: v.dim, nonZero, norm: Math.sqrt(sq), min, max, mean: v.dim ? sum / v.dim : 0 };
}

export type VectorMetric = 'l2' | 'cosine' | 'ip' | 'l1';

/**
 * The four distance operators and the opclass suffix an index needs to serve each. `<#>` returns
 * the NEGATIVE inner product (so that ascending order is nearest first); the query flips it back
 * for display, otherwise the most similar row would read as the smallest number.
 */
export const VECTOR_METRICS: { id: VectorMetric; op: string; opclass: string }[] = [
  { id: 'cosine', op: '<=>', opclass: 'cosine_ops' },
  { id: 'l2', op: '<->', opclass: 'l2_ops' },
  { id: 'ip', op: '<#>', opclass: 'ip_ops' },
  { id: 'l1', op: '<+>', opclass: 'l1_ops' },
];

export function metricOp(metric: VectorMetric): string {
  return VECTOR_METRICS.find((m) => m.id === metric)!.op;
}

/** Name of the score column the k-NN query adds; the grid shows it first. */
export const KNN_SCORE_COLUMN = '_distance';
export const KNN_SIMILARITY_COLUMN = '_inner_product';

/**
 * The k-NN query. The vector is `$1`, bound by the driver — never spliced into the text — and cast
 * to the column's own type. ORDER BY repeats the operator expression rather than the alias, which
 * is the shape pgvector's index scan documentation gives.
 */
export function buildKnnSql(o: {
  schema?: string | null;
  table: string;
  column: string;
  kind: VectorKind;
  metric: VectorMetric;
  k: number;
  /**
   * Order by `(expr) + 0`: the same distances, but no longer the operator expression an index can
   * serve, so the planner scans every row. The ground truth `recallOf` compares the index against.
   */
  exact?: boolean;
}): string {
  const tbl = (o.schema ? `${quoteIdent(o.schema, 'postgres')}.` : '') + quoteIdent(o.table, 'postgres');
  const col = quoteIdent(o.column, 'postgres');
  const expr = `${col} ${metricOp(o.metric)} $1::${o.kind}`;
  const score = o.metric === 'ip'
    ? `(${expr}) * -1 AS ${quoteIdent(KNN_SIMILARITY_COLUMN, 'postgres')}`
    : `${expr} AS ${quoteIdent(KNN_SCORE_COLUMN, 'postgres')}`;
  const k = Math.max(1, Math.min(1000, Math.floor(o.k) || 1));
  const order = o.exact ? `(${expr}) + 0` : expr;
  return `SELECT ${score}, *\nFROM ${tbl}\nWHERE ${col} IS NOT NULL\nORDER BY ${order}\nLIMIT ${k}`;
}

/** How many of the exact nearest rows the index returned. */
export interface Recall {
  found: number;
  total: number;
  /** Positions (in the exact result) of the rows the index missed. */
  missed: number[];
}

/**
 * Recall@k of an index scan against the exact answer. Rows are compared by every column EXCEPT the
 * score (column 0), so no primary key is needed, and a score that differs in the last float digit
 * between the two plans cannot count as a miss. Duplicates are matched one for one.
 */
export function recallOf(columns: string[], approx: Record<string, unknown>[], exact: Record<string, unknown>[]): Recall {
  const keyOf = (r: Record<string, unknown>) => JSON.stringify(columns.slice(1).map((c) => r[c] ?? null));
  const pool = new Map<string, number>();
  for (const r of approx) {
    const k = keyOf(r);
    pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  const missed: number[] = [];
  exact.forEach((r, i) => {
    const k = keyOf(r);
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else missed.push(i);
  });
  return { found: exact.length - missed.length, total: exact.length, missed };
}

/** Qualified name as text, for `to_regclass($1)`. */
export function regclassName(schema: string | null | undefined, table: string): string {
  return (schema ? `${quoteIdent(schema, 'postgres')}.` : '') + quoteIdent(table, 'postgres');
}

/**
 * HNSW / IVFFlat indexes on a table with the opclass of their first key — a vector index has one
 * key. Bound with the table's qualified name.
 */
export const VECTOR_INDEX_SQL = `SELECT i.relname AS name, am.amname AS method,
       pg_get_indexdef(ix.indexrelid, 1, true) AS key, opc.opcname AS opclass
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_am am ON am.oid = i.relam
JOIN pg_opclass opc ON opc.oid = ix.indclass[0]
WHERE ix.indrelid = to_regclass($1) AND am.amname IN ('hnsw', 'ivfflat')
ORDER BY i.relname`;

export interface VectorIndex {
  name: string;
  method: string;
  key: string;
  opclass: string;
}

/**
 * The index that can serve this column + metric, if any. The key is compared unquoted or quoted,
 * since `pg_get_indexdef` quotes a column name only when it has to.
 */
export function indexFor(indexes: VectorIndex[], column: string, kind: VectorKind, metric: VectorMetric): VectorIndex | null {
  const suffix = VECTOR_METRICS.find((m) => m.id === metric)!.opclass;
  const keys = new Set([column, quoteIdent(column, 'postgres')]);
  return indexes.find((ix) => keys.has(ix.key) && ix.opclass === `${kind}_${suffix}`) ?? null;
}

/** Whether an EXPLAIN plan (its lines joined) reads through the given index. */
export function planUsesIndex(plan: string, indexName: string): boolean {
  const q = quoteIdent(indexName, 'postgres');
  return plan.split('\n').some((l) => /Index (Only )?Scan using/.test(l) && (l.includes(` ${indexName} `) || l.includes(` ${q} `)));
}
