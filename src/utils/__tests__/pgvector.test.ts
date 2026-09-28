import { describe, expect, it } from 'vitest';
import {
  buildKnnSql,
  declaredDim,
  indexFor,
  parseVectorText,
  planUsesIndex,
  recallOf,
  toVectorText,
  vectorKindOf,
  vectorStats,
  type VectorIndex,
} from '../pgvector';

describe('vectorKindOf / declaredDim', () => {
  it('reads format_type() spellings', () => {
    expect(vectorKindOf('vector(1536)')).toBe('vector');
    expect(vectorKindOf('halfvec')).toBe('halfvec');
    expect(vectorKindOf('extensions.sparsevec(30000)')).toBe('sparsevec');
    expect(declaredDim('vector(1536)')).toBe(1536);
    expect(declaredDim('vector')).toBeNull();
  });

  it('is not fooled by look-alikes', () => {
    expect(vectorKindOf('tsvector')).toBeNull();
    expect(vectorKindOf('vector(3)[]')).toBeNull();
    expect(vectorKindOf('int2vector')).toBeNull();
    expect(vectorKindOf(null)).toBeNull();
  });
});

describe('parseVectorText', () => {
  it('reads both text forms the backend produces', () => {
    expect(parseVectorText('[1,2,3]')).toEqual({ sparse: false, dim: 3, indices: [0, 1, 2], values: [1, 2, 3] });
    expect(parseVectorText(' [0.1, -0.25, 1e-7] ')!.values).toEqual([0.1, -0.25, 1e-7]);
    expect(parseVectorText('{1:1.5,3:2}/5')).toEqual({ sparse: true, dim: 5, indices: [0, 2], values: [1.5, 2] });
    expect(parseVectorText('{}/5')).toEqual({ sparse: true, dim: 5, indices: [], values: [] });
    expect(parseVectorText('[]')!.dim).toBe(0);
  });

  it('refuses rather than guesses', () => {
    expect(parseVectorText('[1,,2]')).toBeNull();
    expect(parseVectorText('[1,2')).toBeNull();
    expect(parseVectorText('[1,abc]')).toBeNull();
    expect(parseVectorText('[1,NaN]')).toBeNull();
    expect(parseVectorText('{6:1}/5')).toBeNull(); // index past dim
    expect(parseVectorText('{0:1}/5')).toBeNull(); // 1-based
    expect(parseVectorText('{2:1,2:3}/5')).toBeNull(); // repeated index
    expect(parseVectorText('1,2,3')).toBeNull();
  });
});

describe('toVectorText', () => {
  it('converts between dense and sparse for the target column', () => {
    const d = parseVectorText('[0,1.5,0,2]')!;
    expect(toVectorText(d, 'sparsevec')).toBe('{2:1.5,4:2}/4');
    const s = parseVectorText('{2:1.5,4:2}/4')!;
    expect(toVectorText(s, 'vector')).toBe('[0,1.5,0,2]');
    expect(toVectorText(s, 'halfvec')).toBe('[0,1.5,0,2]');
  });
});

describe('vectorStats', () => {
  it('counts the implicit zeros of a sparse vector', () => {
    const st = vectorStats(parseVectorText('{1:3,3:4}/5')!);
    expect(st).toMatchObject({ dim: 5, nonZero: 2, norm: 5, min: 0, max: 4 });
    expect(st.mean).toBeCloseTo(1.4);
  });

  it('dense', () => {
    const st = vectorStats(parseVectorText('[-1,2,2]')!);
    expect(st).toMatchObject({ dim: 3, nonZero: 3, norm: 3, min: -1, max: 2, mean: 1 });
  });

  it('empty', () => {
    expect(vectorStats(parseVectorText('[]')!)).toMatchObject({ dim: 0, norm: 0, min: 0, max: 0, mean: 0 });
  });
});

describe('buildKnnSql', () => {
  it('binds the vector and casts it to the column type', () => {
    const sql = buildKnnSql({ schema: 'app', table: 'items', column: 'embedding', kind: 'halfvec', metric: 'cosine', k: 10 });
    expect(sql).toBe(
      'SELECT "embedding" <=> $1::halfvec AS "_distance", *\nFROM "app"."items"\nWHERE "embedding" IS NOT NULL\nORDER BY "embedding" <=> $1::halfvec\nLIMIT 10',
    );
  });

  it('flips the sign of <#> for display, but not for ordering', () => {
    const sql = buildKnnSql({ table: 'items', column: 'e', kind: 'vector', metric: 'ip', k: 5 });
    expect(sql).toContain('("e" <#> $1::vector) * -1 AS "_inner_product"');
    expect(sql).toContain('ORDER BY "e" <#> $1::vector\n');
    expect(sql).toContain('FROM "items"');
  });

  it('quotes identifiers and clamps k', () => {
    const sql = buildKnnSql({ table: 'we"ird', column: 'My Col', kind: 'vector', metric: 'l1', k: 99999 });
    expect(sql).toContain('FROM "we""ird"');
    expect(sql).toContain('"My Col" <+> $1::vector');
    expect(sql).toMatch(/LIMIT 1000$/);
    expect(buildKnnSql({ table: 't', column: 'c', kind: 'vector', metric: 'l2', k: 0 })).toMatch(/LIMIT 1$/);
  });
});

describe('indexFor / planUsesIndex', () => {
  const idx: VectorIndex[] = [
    { name: 'items_embedding_idx', method: 'hnsw', key: 'embedding', opclass: 'vector_cosine_ops' },
    { name: 'items_l2', method: 'hnsw', key: 'embedding', opclass: 'vector_l2_ops' },
    { name: 'odd', method: 'ivfflat', key: '"My Col"', opclass: 'halfvec_ip_ops' },
  ];

  it('matches column, type and metric', () => {
    expect(indexFor(idx, 'embedding', 'vector', 'cosine')?.name).toBe('items_embedding_idx');
    expect(indexFor(idx, 'embedding', 'vector', 'l2')?.name).toBe('items_l2');
    expect(indexFor(idx, 'embedding', 'vector', 'ip')).toBeNull();
    expect(indexFor(idx, 'embedding', 'halfvec', 'cosine')).toBeNull();
    expect(indexFor(idx, 'My Col', 'halfvec', 'ip')?.name).toBe('odd');
  });

  it('reads an EXPLAIN plan', () => {
    const plan = 'Limit  (cost=…)\n  ->  Index Scan using items_embedding_idx on items  (cost=…)\n        Order By: (embedding <=> $1)';
    expect(planUsesIndex(plan, 'items_embedding_idx')).toBe(true);
    expect(planUsesIndex(plan, 'items_l2')).toBe(false);
    expect(planUsesIndex('Limit\n  ->  Sort\n        ->  Seq Scan on items', 'items_embedding_idx')).toBe(false);
  });
});

describe('exact search and recall', () => {
  it('orders by an expression no index can serve', () => {
    const sql = buildKnnSql({ table: 't', column: 'e', kind: 'vector', metric: 'cosine', k: 10, exact: true });
    expect(sql).toContain('ORDER BY ("e" <=> $1::vector) + 0\n');
    // The score column is the same expression either way.
    expect(sql).toContain('SELECT "e" <=> $1::vector AS "_distance"');
  });

  it('counts the exact rows the index returned, ignoring the score column', () => {
    const cols = ['_distance', 'id', 'label'];
    const exact = [{ _distance: 0, id: 2, label: 'b' }, { _distance: 0.6, id: 7, label: 'x' }, { _distance: 0.7, id: 9, label: 'y' }];
    // Same rows, the score off in the last digit: still a hit.
    const approx = [{ _distance: 0.6000001, id: 7, label: 'x' }, { _distance: 0.7, id: 9, label: 'y' }, { _distance: 0.8, id: 4, label: 'z' }];
    expect(recallOf(cols, approx, exact)).toEqual({ found: 2, total: 3, missed: [0] });
    expect(recallOf(cols, exact, exact)).toEqual({ found: 3, total: 3, missed: [] });
    expect(recallOf(cols, [], [])).toEqual({ found: 0, total: 0, missed: [] });
  });

  it('matches duplicate rows one for one', () => {
    const cols = ['_distance', 'v'];
    const exact = [{ _distance: 0, v: 1 }, { _distance: 0, v: 1 }];
    expect(recallOf(cols, [{ _distance: 0, v: 1 }], exact)).toEqual({ found: 1, total: 2, missed: [1] });
  });
});
