import { describe, it, expect } from 'vitest';
import {
  autoMap,
  mappedColumns,
  missingRequired,
  newTableColumnType,
  tableNameFromFile,
  typeFamily,
  type TargetColumn,
} from '../tableImport';

// Reading the file and converting values are tested in Rust (`src-tauri/src/import_file/`), where
// they now live: the CSV/JSON/Excel readers, `coerce_cell` and the type guess for a new table.

const col = (name: string, type: string, over: Partial<TargetColumn> = {}): TargetColumn => ({
  name,
  type,
  nullable: true,
  hasDefault: false,
  ...over,
});

describe('typeFamily', () => {
  it.each([
    ['int(11)', 'integer'],
    ['bigint unsigned', 'integer'],
    ['serial', 'integer'],
    ['tinyint(1)', 'boolean'],
    ['boolean', 'boolean'],
    ['numeric(10,2)', 'decimal'],
    ['double precision', 'float'],
    ['timestamp without time zone', 'datetime'],
    ['datetime', 'datetime'],
    ['date', 'date'],
    ['time', 'time'],
    ['jsonb', 'json'],
    ['uuid', 'uuid'],
    ['character varying(50)', 'text'],
    ["enum('a','b')", 'text'],
    ['bytea', 'other'],
  ])('%s → %s', (type, fam) => {
    expect(typeFamily(type)).toBe(fam);
  });
});

describe('autoMap', () => {
  const targets = [col('id', 'int'), col('first_name', 'text'), col('Email', 'text'), col('total', 'int', { generated: true })];

  it('matches exactly, then ignoring case, spaces and underscores', () => {
    expect(autoMap(['First Name', 'id', 'EMAIL', 'total'], targets)).toEqual([1, 0, 2, null]);
  });

  it('uses each source column once, and prefers an exact match', () => {
    expect(autoMap(['firstname', 'first_name'], [col('first_name', 'text'), col('firstName', 'text')])).toEqual([1, 0]);
  });

  it('never maps a generated column', () => {
    expect(autoMap(['total'], [col('total', 'int', { generated: true })])).toEqual([null]);
  });
});

describe('missingRequired / mappedColumns', () => {
  const targets = [
    col('id', 'int', { nullable: false, hasDefault: true }),
    col('name', 'text', { nullable: false }),
    col('note', 'text'),
    col('calc', 'int', { nullable: false, generated: true }),
  ];

  it('names NOT NULL columns with no default that nothing feeds', () => {
    expect(missingRequired(targets, [null, null, null, null])).toEqual(['name']);
    expect(missingRequired(targets, [null, 0, null, null])).toEqual([]);
  });

  it('sends only the fed, writable columns, in target order', () => {
    expect(mappedColumns(targets, [2, 0, null, 1])).toEqual([
      { target: { name: 'id', type: 'int', nullable: false }, source: 2 },
      { target: { name: 'name', type: 'text', nullable: false }, source: 0 },
    ]);
  });
});

describe('a new table', () => {
  it('types each guessed family in the dialect, in types the conversion reads back', () => {
    expect(newTableColumnType('integer', 'postgres')).toBe('BIGINT');
    expect(newTableColumnType('integer', 'sqlite')).toBe('INTEGER');
    expect(newTableColumnType('float', 'postgres')).toBe('DOUBLE PRECISION');
    expect(newTableColumnType('float', 'mysql')).toBe('DOUBLE');
    expect(newTableColumnType('boolean', 'mysql')).toBe('TINYINT(1)');
    expect(newTableColumnType('datetime', 'postgres')).toBe('TIMESTAMP');
    expect(newTableColumnType('text', 'mysql')).toBe('TEXT');
    // Each type maps back to the family it was made from — what the import converts by.
    for (const db of ['postgres', 'mysql', 'sqlite']) {
      for (const fam of ['integer', 'float', 'boolean', 'date', 'datetime', 'text'] as const) {
        expect(typeFamily(newTableColumnType(fam, db))).toBe(fam);
      }
    }
  });

  it('names the table after the file', () => {
    expect(tableNameFromFile('C:\\data\\Orders 2026.csv.gz')).toBe('orders_2026');
    expect(tableNameFromFile('/tmp/Đơn hàng.xlsx')).toBe('don_hang');
    expect(tableNameFromFile('2026-sales.json')).toBe('t_2026_sales');
    expect(tableNameFromFile('---.csv')).toBe('imported');
  });
});
