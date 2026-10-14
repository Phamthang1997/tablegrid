import { describe, expect, it } from 'vitest';
import { attachFileSql, dbCaps, duckReaderFor, isFileDb, viewNameForFile } from '../dbCaps';

describe('dbCaps', () => {
  it('treats SQLite and DuckDB as file databases', () => {
    expect(isFileDb('sqlite')).toBe(true);
    expect(isFileDb('duckdb')).toBe(true);
    expect(isFileDb('postgres')).toBe(false);
    expect(isFileDb(undefined)).toBe(false);
  });

  it('keeps DuckDB read-mostly and off MCP', () => {
    const d = dbCaps('duckdb');
    expect(d.write || d.tx || d.dump || d.compare || d.dataGen || d.mcp).toBe(false);
    expect(d.attachFiles).toBe(true);
    expect(dbCaps('postgres').write).toBe(true);
    expect(dbCaps('postgres').attachFiles).toBe(false);
    expect(dbCaps('sqlite').processMonitor).toBe(false);
  });
});

describe('attaching data files', () => {
  it('picks the reader by extension, case-insensitively', () => {
    expect(duckReaderFor('C:\\data\\Sales.PARQUET')).toBe("read_parquet('C:/data/Sales.PARQUET')");
    expect(duckReaderFor('/x/a.csv')).toBe("read_csv_auto('/x/a.csv')");
    expect(duckReaderFor('/x/a.tsv')).toBe("read_csv_auto('/x/a.tsv')");
    expect(duckReaderFor('/x/a.ndjson')).toBe("read_json_auto('/x/a.ndjson')");
    expect(duckReaderFor('/x/a.xlsx')).toBeNull();
    expect(duckReaderFor('/x/noext')).toBeNull();
  });

  it('escapes a quote in the path', () => {
    expect(duckReaderFor("/x/o'brien.csv")).toBe("read_csv_auto('/x/o''brien.csv')");
  });

  it('names the view after the file, plainly and uniquely', () => {
    expect(viewNameForFile('C:\\data\\Sales 2024-Q1.parquet', [])).toBe('sales_2024_q1');
    expect(viewNameForFile('/x/2024.csv', [])).toBe('f_2024');
    expect(viewNameForFile('/x/---.csv', [])).toBe('file');
    expect(viewNameForFile('/x/sales.csv', ['Sales', 'sales_2'])).toBe('sales_3');
    expect(viewNameForFile('/x/Đơn hàng.csv', [])).toBe('don_hang');
    expect(viewNameForFile('/x/Khách-Hàng.parquet', [])).toBe('khach_hang');
  });

  it('builds the CREATE VIEW', () => {
    expect(attachFileSql('sales', '/x/s.parquet')).toBe(`CREATE VIEW "sales" AS SELECT * FROM read_parquet('/x/s.parquet')`);
    expect(attachFileSql('x', '/x/s.xlsx')).toBeNull();
  });
});
