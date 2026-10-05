import { describe, expect, it } from 'vitest';
import { analyzeIndexes, dropIndexSql, unquoteIdent, type IndexFact, type IndexFacts } from '../indexAnalysis';

const ix = (name: string, columns: string[], over: Partial<IndexFact> = {}): IndexFact => ({
  table: 'film',
  name,
  columns,
  flavors: columns.map(() => ''),
  unique: false,
  primary: false,
  constraint: false,
  method: 'btree',
  predicate: null,
  valid: true,
  sizeBytes: 8192,
  scans: 10,
  ...over,
});

const facts = (indexes: IndexFact[], over: Partial<IndexFacts> = {}): IndexFacts => ({
  dialect: 'postgres',
  schema: 'public',
  indexes,
  foreignKeys: [],
  usageAvailable: true,
  sizesAvailable: true,
  statsReset: null,
  serverStarted: '2026-10-01 00:00:00',
  ...over,
});

const issues = (r: ReturnType<typeof analyzeIndexes>) => Object.fromEntries(r.findings.map((f) => [f.index, f.issues]));

describe('analyzeIndexes — duplicates and redundancy', () => {
  it('flags an identical index and keeps the one the schema depends on', () => {
    const r = analyzeIndexes(facts([
      ix('film_pkey', ['film_id'], { primary: true, unique: true, constraint: true }),
      ix('idx_film_id', ['film_id']),
      ix('idx_title', ['title']),
    ]));
    // A plain index on the primary key's column is the same key: the primary key already serves it.
    expect(issues(r)).toEqual({ idx_film_id: ['duplicate'] });
    expect(r.findings[0].duplicateOf).toBe('film_pkey');
  });

  it('flags (a) as covered by (a, b), but never a UNIQUE (a)', () => {
    const r = analyzeIndexes(facts([
      ix('idx_a', ['language_id']),
      ix('idx_ab', ['language_id', 'title']),
      ix('uq_a', ['release_year'], { unique: true }),
      ix('idx_a2', ['release_year', 'rating']),
    ]));
    expect(issues(r)).toEqual({ idx_a: ['redundant'] });
    expect(r.findings[0].coveredBy).toBe('idx_ab');
  });

  it('does not compare across methods, predicates or column flavors', () => {
    const r = analyzeIndexes(facts([
      ix('idx_title', ['title']),
      ix('idx_title_hash', ['title'], { method: 'hash' }),
      ix('idx_title_partial', ['title'], { predicate: '(rating = \'G\')' }),
      ix('idx_title_pattern', ['title'], { flavors: ['3126::'] }),
      ix('idx_title_desc', ['title', 'film_id'], { flavors: ['1:3:', ''] }),
    ]));
    expect(r.findings).toEqual([]);
  });

  it('does not let a partial longer index cover a full one', () => {
    const r = analyzeIndexes(facts([ix('idx_a', ['a']), ix('idx_ab_partial', ['a', 'b'], { predicate: '(b > 0)' })]));
    expect(r.findings).toEqual([]);
  });

  it('never flags a column order that is not a prefix', () => {
    const r = analyzeIndexes(facts([ix('idx_b', ['b']), ix('idx_ab', ['a', 'b'])]));
    expect(r.findings).toEqual([]);
  });

  it('keeps comparisons inside one table', () => {
    const r = analyzeIndexes(facts([ix('idx_a', ['a']), ix('idx_ab', ['a', 'b'], { table: 'other' })]));
    expect(r.findings).toEqual([]);
  });
});

describe('analyzeIndexes — unused and invalid', () => {
  it('flags an index with zero scans, but never a key, a unique or a constraint index', () => {
    const r = analyzeIndexes(facts([
      ix('pk', ['id'], { primary: true, unique: true, constraint: true, scans: 0 }),
      ix('uq', ['code'], { unique: true, scans: 0 }),
      ix('idx_cold', ['note'], { scans: 0 }),
      ix('idx_hot', ['title'], { scans: 900 }),
    ]));
    expect(issues(r)).toEqual({ idx_cold: ['unused'] });
  });

  it('says nothing about usage when the server keeps no counters', () => {
    const r = analyzeIndexes(facts([ix('idx_cold', ['note'], { scans: null })], { usageAvailable: false }));
    expect(r.findings).toEqual([]);
  });

  it('reports an invalid index first', () => {
    const r = analyzeIndexes(facts([ix('idx_broken', ['x'], { valid: false, scans: 0 })]));
    expect(issues(r)).toEqual({ idx_broken: ['invalid', 'unused'] });
  });
});

describe('analyzeIndexes — foreign keys and DROP statements', () => {
  it('marks the only index an FK can use, and refuses a MySQL DROP for it', () => {
    const mysql = analyzeIndexes(facts([ix('idx_fk_lang', ['language_id'], { scans: 0 })], {
      dialect: 'mysql', schema: null, foreignKeys: [{ table: 'film', columns: ['language_id'] }],
    }));
    expect(mysql.findings[0].backsForeignKey).toBe(true);
    expect(mysql.findings[0].dropSql).toBeNull();
    expect(mysql.reclaimableBytes).toBe(0);

    const pg = analyzeIndexes(facts([ix('idx_fk_lang', ['"language_id"'], { scans: 0 })], {
      foreignKeys: [{ table: 'film', columns: ['language_id'] }],
    }));
    expect(pg.findings[0].backsForeignKey).toBe(true);
    expect(pg.findings[0].dropSql).toBe('DROP INDEX "public"."idx_fk_lang";');
  });

  it('does not worry about the FK when the covering index stays', () => {
    const r = analyzeIndexes(facts([ix('idx_a', ['language_id']), ix('idx_ab', ['language_id', 'title'])], {
      dialect: 'mysql', schema: null, foreignKeys: [{ table: 'film', columns: ['language_id'] }],
    }));
    expect(r.findings[0].backsForeignKey).toBe(false);
    expect(r.findings[0].dropSql).toBe('DROP INDEX `idx_a` ON `film`;');
  });

  it('when every index an FK could use has a finding, warns on the one to keep — not on the covered one', () => {
    const r = analyzeIndexes(facts([
      ix('idx_parent', ['parent_id'], { scans: 0 }),
      ix('idx_parent_code', ['parent_id', 'code'], { scans: 0 }),
    ], { foreignKeys: [{ table: 'film', columns: ['parent_id'] }] }));
    const byName = Object.fromEntries(r.findings.map((f) => [f.index, f]));
    expect(byName.idx_parent.issues).toEqual(['redundant', 'unused']);
    expect(byName.idx_parent.backsForeignKey).toBe(false);
    expect(byName.idx_parent_code.backsForeignKey).toBe(true);
  });

  it('a duplicate whose kept twin is itself covered is reported as covered by that index', () => {
    const r = analyzeIndexes(facts([
      ix('idx_code', ['code'], { scans: 5 }),
      ix('idx_code_dup', ['code'], { scans: 0 }),
      ix('uq_code_id', ['code', 'id'], { unique: true }),
    ]));
    const byName = Object.fromEntries(r.findings.map((f) => [f.index, f]));
    expect(byName.idx_code.issues).toEqual(['redundant']);
    expect(byName.idx_code.coveredBy).toBe('uq_code_id');
    expect(byName.idx_code_dup.issues).toEqual(['redundant', 'unused']);
    expect(byName.idx_code_dup.coveredBy).toBe('uq_code_id');
    expect(byName.idx_code_dup.duplicateOf).toBeUndefined();
  });

  it('adds up what dropping would reclaim, largest first, or null without sizes', () => {
    const r = analyzeIndexes(facts([
      ix('small', ['x'], { scans: 0, sizeBytes: 100 }),
      ix('big', ['y'], { scans: 0, sizeBytes: 5000 }),
    ]));
    expect(r.findings.map((f) => f.index)).toEqual(['big', 'small']);
    expect(r.reclaimableBytes).toBe(5100);
    expect(analyzeIndexes(facts([ix('a', ['x'], { scans: 0 })], { sizesAvailable: false })).reclaimableBytes).toBeNull();
  });

  it('quotes names per dialect', () => {
    expect(dropIndexSql('sqlite', { table: 't', name: 'my"idx' }, null)).toBe('DROP INDEX "my""idx";');
    expect(dropIndexSql('mysql', { table: 'a`b', name: 'i' }, null)).toBe('DROP INDEX `i` ON `a``b`;');
    expect(unquoteIdent('"Weird ""Name"""')).toBe('Weird "Name"');
    expect(unquoteIdent('plain')).toBe('plain');
  });
});
