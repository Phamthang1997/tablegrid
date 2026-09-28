import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en';
import {
  columnChangeKey,
  describeColumn,
  describeForeignKey,
  describeIndex,
  filterTableDiffs,
  formatCell,
  hasRunnableSql,
  joinSyncSql,
  statusLabelKey,
  statusTone,
  syncSqlFileName,
  totalDiffCount,
  type ColumnMeta,
  type DiffStatus,
  type SchemaCompareSummary,
  type TableDiff,
} from '../compareHelper';

/** Resolves a `compare.x` key against the en dictionary so a typo fails the test. */
const resolve = (key: string) => {
  const [ns, leaf] = key.split('.');
  return (en as any)[ns]?.[leaf];
};

const col = (over: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name: 'id',
  type: 'int',
  nullable: false,
  default: null,
  autoIncrement: false,
  comment: null,
  position: 1,
  ...over,
});

const table = (name: string, status: DiffStatus, diffCount = 0): TableDiff => ({
  name,
  kind: 'table',
  status,
  changes: [],
  diffCount,
  columns: [],
  indexes: [],
  foreignKeys: [],
  primaryKey: { source: [], target: [], differs: false },
  viewDefinitionDiffers: false,
});

describe('statusTone', () => {
  it('gives each side its own tone so A and B are never confused', () => {
    expect(statusTone('onlySource')).toBe('ok');
    expect(statusTone('onlyTarget')).toBe('danger');
    expect(statusTone('different')).toBe('warn');
    expect(statusTone('differentCount')).toBe('warn');
    expect(statusTone('identical')).toBe('muted');
    expect(statusTone('sameCount')).toBe('muted');
  });
});

describe('translation keys', () => {
  it('every status maps to a key that exists in en', () => {
    const statuses = [
      'onlySource',
      'onlyTarget',
      'different',
      'identical',
      'sameCount',
      'differentCount',
    ] as const;
    for (const s of statuses) {
      expect(resolve(statusLabelKey(s)), `missing key for ${s}`).toBeTruthy();
    }
  });

  it('every change name the backend can emit maps to a key that exists in en', () => {
    // Mirrors column_changes / index_changes / fk_changes and the table-level `changes`.
    const changes = [
      'type',
      'nullable',
      'default',
      'autoIncrement',
      'comment',
      'position',
      'columns',
      'unique',
      'refTable',
      'refColumns',
      'onDelete',
      'onUpdate',
      'exists',
      'primaryKey',
      'viewDefinition',
      'kind',
      'definition',
    ];
    for (const c of changes) {
      expect(resolve(columnChangeKey(c)), `missing key for ${c}`).toBeTruthy();
    }
  });

  it('falls back to a real key for an unknown change name', () => {
    expect(columnChangeKey('somethingNew')).toBe('compare.changeOther');
    expect(resolve('compare.changeOther')).toBeTruthy();
  });
});

describe('filterTableDiffs', () => {
  const tables = [
    table('users', 'different', 2),
    table('orders', 'onlySource', 1),
    table('legacy_logs', 'onlyTarget', 1),
    table('countries', 'identical'),
  ];

  it('shows everything when no status is selected', () => {
    expect(filterTableDiffs(tables, { statuses: new Set(), search: '' })).toHaveLength(4);
  });

  it('filters by status', () => {
    const out = filterTableDiffs(tables, { statuses: new Set<DiffStatus>(['onlySource', 'onlyTarget']), search: '' });
    expect(out.map((t) => t.name)).toEqual(['orders', 'legacy_logs']);
  });

  it('filters by name, case-insensitively, and combines with the status filter', () => {
    expect(filterTableDiffs(tables, { statuses: new Set(), search: 'LOG' }).map((t) => t.name)).toEqual([
      'legacy_logs',
    ]);
    expect(
      filterTableDiffs(tables, { statuses: new Set<DiffStatus>(['identical']), search: 'log' }),
    ).toEqual([]);
  });

  it('ignores surrounding whitespace in the search box', () => {
    expect(filterTableDiffs(tables, { statuses: new Set(), search: '  users  ' })).toHaveLength(1);
  });
});

describe('totalDiffCount', () => {
  it('counts only the tables that need syncing, not the identical ones', () => {
    const summary: SchemaCompareSummary = {
      tablesOnlySource: 2,
      tablesOnlyTarget: 1,
      tablesDifferent: 3,
      tablesIdentical: 40,
      columnsOnlySource: 5,
      columnsOnlyTarget: 0,
      columnsDifferent: 2,
      indexDiffs: 1,
      foreignKeyDiffs: 0,
    };
    expect(totalDiffCount(summary)).toBe(6);
  });
});

describe('describeColumn', () => {
  it('renders the parts that matter for a diff', () => {
    expect(describeColumn(col({ type: 'varchar(50)', nullable: true }))).toBe('varchar(50) · NULL');
    expect(describeColumn(col({ autoIncrement: true }))).toBe('int · NOT NULL · AUTO_INCREMENT');
    expect(describeColumn(col({ default: '0' }))).toBe('int · NOT NULL · DEFAULT 0');
  });

  it('renders a missing column as a dash rather than an empty string', () => {
    expect(describeColumn(null)).toBe('—');
  });

  it('does not print an empty DEFAULT clause', () => {
    expect(describeColumn(col({ default: '' }))).toBe('int · NOT NULL');
  });
});

describe('describeIndex / describeForeignKey', () => {
  it('marks uniqueness and keeps the column order', () => {
    expect(describeIndex({ name: 'ix', columns: ['a', 'b'], unique: true })).toBe('UNIQUE (a, b)');
    // A Postgres index describes itself by its USING tail, so an HNSW index and a btree differ.
    expect(describeIndex({ name: 'ix', columns: ['e'], unique: false, using: ' USING hnsw (e vector_cosine_ops)' })).toBe('USING hnsw (e vector_cosine_ops)');
    expect(describeIndex({ name: 'ix', columns: ['b', 'a'], unique: false })).toBe('(b, a)');
    expect(describeIndex(null)).toBe('—');
  });

  it('shows the reference and only the rules that are not the default', () => {
    expect(
      describeForeignKey({
        name: 'fk',
        columns: ['user_id'],
        refTable: 'users',
        refColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      }),
    ).toBe('(user_id) → users(id) · ON DELETE CASCADE');
    expect(
      describeForeignKey({
        name: 'fk',
        columns: ['user_id'],
        refTable: 'users',
        refColumns: ['id'],
        onDelete: null,
        onUpdate: null,
      }),
    ).toBe('(user_id) → users(id)');
    expect(describeForeignKey(null)).toBe('—');
  });
});

describe('formatCell', () => {
  it('makes NULL and empty string distinguishable', () => {
    expect(formatCell(null)).toBe('(NULL)');
    expect(formatCell(undefined)).toBe('(NULL)');
    expect(formatCell('')).toBe('(empty)');
  });

  it('keeps a 0 and a false visible', () => {
    expect(formatCell(0)).toBe('0');
    expect(formatCell(false)).toBe('false');
  });

  it('serialises an object/array cell', () => {
    expect(formatCell([1, 2])).toBe('[1,2]');
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });
});

describe('sync SQL helpers', () => {
  it('joins the statement list with newlines', () => {
    expect(joinSyncSql(['-- a', 'SELECT 1;'])).toBe('-- a\nSELECT 1;');
  });

  it('treats a comment-only script as having nothing to run', () => {
    // This is what "include drops = off" produces when every statement is destructive.
    expect(hasRunnableSql(['-- DROP TABLE x;', '', '   '])).toBe(false);
    expect(hasRunnableSql(['-- note', 'ALTER TABLE t ADD COLUMN c int;'])).toBe(true);
    expect(hasRunnableSql([])).toBe(false);
  });

  it('builds a file name that is safe on disk', () => {
    expect(syncSqlFileName('schema', 'my db/prod')).toBe('sync_schema_my_db_prod.sql');
    expect(syncSqlFileName('data', '')).toBe('sync_data_db.sql');
  });
});
