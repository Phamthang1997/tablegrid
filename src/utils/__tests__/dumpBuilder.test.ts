import { describe, it, expect } from 'vitest';
import { EXPORT_PAGE_SIZE, buildDump, writeDump, type DumpReader, type DumpSpec } from '../dumpBuilder';
import { parseDumpObjects, parseDumpTableNames } from '../dumpPreview';
import { splitStatements } from '../../sql/statements';

// A fake reader: enough to build a dump without a backend. This is exactly why buildDump takes its
// reader as a parameter instead of importing dbHelper — it is what makes the statement order testable.
function fakeReader(over: Partial<DumpReader> = {}): DumpReader {
  return {
    getTableDefinition: async (name) => ({ success: true, sql: `CREATE TABLE \`${name}\` (id int)` }),
    getTableSchema: async () => ({ columns: [{ name: 'id' } as any], indexes: [], foreignKeys: [] }),
    getTableData: async () => ({ rows: [{ id: 1 }], totalCount: 1 }),
    getObjectDefinition: async (name, kind) => ({
      success: true,
      sql:
        kind === 'function'
          ? `CREATE DEFINER=\`root\`@\`localhost\` FUNCTION \`${name}\`() RETURNS int RETURN 1`
          : `CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE \`${name}\`() BEGIN SELECT 1; END`,
    }),
    getTableDdlExtras: async () => ({
      sequences: [],
      indexes: [],
      constraints: [],
      comments: [],
      sequenceValues: [],
    }),
    getAllTriggers: async () => [
      {
        name: 'ins_film',
        table: 'film',
        statement: 'CREATE TRIGGER `ins_film` AFTER INSERT ON `film` FOR EACH ROW BEGIN SET @a = 1; END',
      },
    ],
    ...over,
  };
}

const spec = (over: Partial<DumpSpec> = {}): DumpSpec => ({
  dbType: 'mysql',
  tables: ['actor_info', 'film'],
  views: ['actor_info'],
  routines: [{ name: 'get_balance', kind: 'function' }, { name: 'film_in_stock', kind: 'procedure' }],
  triggers: ['ins_film'],
  sqlOptions: { dropTable: true, includeStructure: true, includeContent: true },
  ...over,
});

/** Where a string first appears in the dump (-1 when it does not). */
const at = (dump: string, needle: string) => dump.indexOf(needle);

describe('writeDump — streaming to a sink', () => {
  /** A table of `n` rows served in pages, the way `get_table_data` pages. */
  const pagedReader = (n: number, pageCalls: number[] = []) =>
    fakeReader({
      getTableData: async (_t, page = 1, size = EXPORT_PAGE_SIZE) => {
        pageCalls.push(page);
        const start = (page - 1) * size;
        const rows = Array.from({ length: Math.max(0, Math.min(size, n - start)) }, (_, i) => ({ id: start + i + 1 }));
        return { rows, totalCount: n };
      },
    });
  const tableOnly = spec({ tables: ['film'], views: [], routines: [], triggers: [] });
  /** Two builds differ only in the header's timestamp. */
  const undated = (dump: string) => dump.replace(/^-- Date: .*$/m, '');

  it('emits exactly what buildDump returns, plus the trailing newline', async () => {
    const chunks: string[] = [];
    await writeDump(spec(), fakeReader(), (c) => { chunks.push(c); });
    expect(undated(chunks.join(''))).toBe(undated((await buildDump(spec(), fakeReader())) + '\n'));
  });

  it('writes a large table one page at a time, never holding it whole', async () => {
    const n = EXPORT_PAGE_SIZE * 2 + 7;
    const chunks: string[] = [];
    await writeDump(tableOnly, pagedReader(n), (c) => { chunks.push(c); });
    // One chunk per page of data, each carrying only its own rows.
    const dataChunks = chunks.filter((c) => c.includes('INSERT INTO `film`'));
    expect(dataChunks).toHaveLength(3);
    const idsIn = (c: string) => [...c.matchAll(/\((\d+)\)/g)].length;
    expect(dataChunks.map(idsIn)).toEqual([EXPORT_PAGE_SIZE, EXPORT_PAGE_SIZE, 7]);
    // The row-count comment rides in the first data chunk and carries the backend's count, since
    // the rows of the later pages have not been read when it is written.
    expect(dataChunks[0]).toContain(String(n));
  });

  it('every chunk ends between statements, so each can go to disk as is', async () => {
    const chunks: string[] = [];
    await writeDump(tableOnly, pagedReader(EXPORT_PAGE_SIZE + 1), (c) => { chunks.push(c); });
    for (const c of chunks) {
      expect(c.endsWith('\n')).toBe(true);
      // Re-splitting a chunk on its own gives only whole statements: nothing is cut mid-INSERT.
      for (const st of splitStatements(c)) {
        if (/^INSERT/i.test(st.text.trim())) expect(st.text.trim()).toMatch(/\);?$/);
      }
    }
    // And the concatenation replays the same rows as the single-string build.
    expect(undated(chunks.join(''))).toBe(undated((await buildDump(tableOnly, pagedReader(EXPORT_PAGE_SIZE + 1))) + '\n'));
  });

  it('waits for the sink before reading the next page', async () => {
    const calls: number[] = [];
    const order: string[] = [];
    await writeDump(tableOnly, pagedReader(EXPORT_PAGE_SIZE * 2, calls), async (c) => {
      order.push(`write@${calls.length}`);
      await new Promise((r) => setTimeout(r, 0));
      if (c.includes('INSERT')) order.push('written');
    });
    // The second page is not requested until the first page's chunk has been written.
    const firstData = order.indexOf('written');
    expect(order[firstData - 1]).toBe('write@1');
    expect(calls).toEqual([1, 2]);
  });

  it('stops between pages when onProgress throws (a cancelled job)', async () => {
    const chunks: string[] = [];
    let reports = 0;
    const cancelling = spec({
      ...tableOnly,
      onProgress: () => {
        reports++;
        if (reports > 3) throw new Error('cancelled');
      },
    });
    await expect(
      writeDump(cancelling, pagedReader(EXPORT_PAGE_SIZE * 5), (c) => { chunks.push(c); }),
    ).rejects.toThrow('cancelled');
    expect(chunks.join('')).not.toContain('SET FOREIGN_KEY_CHECKS = 1');
  });
});

describe('buildDump — thứ tự câu lệnh', () => {
  it('bảng -> view -> routine -> trigger, dù danh sách vào theo alphabet', async () => {
    // `actor_info` is a view and comes BEFORE the `film` table it reads — exactly the situation that
    // broke re-importing sakila (MySQL 1146).
    const dump = await buildDump(spec(), fakeReader());

    expect(at(dump, 'CREATE TABLE `film`')).toBeGreaterThan(-1);
    expect(at(dump, 'CREATE TABLE `film`')).toBeLessThan(at(dump, '-- Structure for view `actor_info`'));
    expect(at(dump, '-- Structure for view `actor_info`')).toBeLessThan(at(dump, '-- Routines and triggers'));
    expect(at(dump, 'FUNCTION `get_balance`')).toBeLessThan(at(dump, 'TRIGGER `ins_film`'));
  });

  it('view không xuất dữ liệu, bảng thì có', async () => {
    const dump = await buildDump(spec(), fakeReader());
    expect(dump).toContain('INSERT INTO `film`');
    expect(dump).not.toContain('INSERT INTO `actor_info`');
  });

  it('bỏ "kèm cấu trúc" thì không còn view/routine/trigger, và cũng không có DROP mồ côi', async () => {
    const dump = await buildDump(
      spec({ sqlOptions: { dropTable: true, includeStructure: false, includeContent: true } }),
      fakeReader()
    );
    expect(dump).not.toContain('CREATE');
    expect(dump).not.toContain('DROP VIEW');
    expect(dump).not.toContain('DROP TRIGGER');
    expect(dump).toContain('INSERT INTO `film`');
  });
});

// The header and footer are not for the app's Import button (restore_backup handles encoding and
// foreign keys itself) but so the file runs under `mysql <` / `psql -f` / `sqlite3 <` outside it.
describe('buildDump — header/footer cấp phiên', () => {
  const bare = (dbType: string) =>
    spec({ dbType, tables: ['film'], views: [], routines: [], triggers: [] });

  it('MySQL: tắt kiểm tra khoá ngoại ở đầu và bật lại ở cuối', async () => {
    const dump = await buildDump(bare('mysql'), fakeReader());
    expect(dump).toContain('SET NAMES utf8mb4;');
    expect(dump).toContain('SET FOREIGN_KEY_CHECKS = 0;');
    expect(dump).toContain("SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';");
    // Re-enabling has to be the LAST line, after all the data.
    expect(dump.trimEnd().endsWith('SET FOREIGN_KEY_CHECKS = 1;')).toBe(true);
    expect(at(dump, 'SET FOREIGN_KEY_CHECKS = 0;')).toBeLessThan(at(dump, 'CREATE TABLE'));
  });

  it('Postgres: khai báo standard_conforming_strings (literal bytea phụ thuộc vào nó)', async () => {
    const dump = await buildDump(bare('postgres'), fakeReader());
    expect(dump).toContain("SET client_encoding = 'UTF8';");
    expect(dump).toContain('SET standard_conforming_strings = on;');
    // Postgres needs no FK disabling: the FKs were moved to the end as ADD CONSTRAINT.
    expect(dump).not.toContain('FOREIGN_KEY_CHECKS');
  });

  it('SQLite: PRAGMA foreign_keys OFF/ON bọc hai đầu', async () => {
    const dump = await buildDump(bare('sqlite'), fakeReader());
    expect(at(dump, 'PRAGMA foreign_keys = OFF;')).toBeLessThan(at(dump, 'CREATE TABLE'));
    expect(dump.trimEnd().endsWith('PRAGMA foreign_keys = ON;')).toBe(true);
  });

  it('Postgres: schema khác public thì header tạo schema rồi đặt search_path', async () => {
    const dump = await buildDump({ ...bare('postgres'), schema: 'sales' }, fakeReader());
    expect(dump).toContain('CREATE SCHEMA IF NOT EXISTS "sales";');
    expect(dump).toContain('SET search_path TO "sales";');
    // It has to precede every DDL, or the first table has already landed in another schema.
    expect(at(dump, 'SET search_path TO "sales";')).toBeLessThan(at(dump, 'CREATE TABLE'));
    // And CREATE SCHEMA has to precede the SET, because pointing search_path at a schema that does not exist is meaningless.
    expect(at(dump, 'CREATE SCHEMA IF NOT EXISTS "sales";'))
      .toBeLessThan(at(dump, 'SET search_path TO "sales";'));
  });

  it('Postgres: public (hoặc không truyền) không thêm dòng nào — dump giữ nguyên như cũ', async () => {
    for (const schema of [undefined, null, 'public', '  ']) {
      const dump = await buildDump({ ...bare('postgres'), schema }, fakeReader());
      expect(dump).not.toContain('CREATE SCHEMA');
      expect(dump).not.toContain('search_path');
    }
  });

  it('MySQL/SQLite bỏ qua schema: cả hai không có khái niệm này', async () => {
    for (const dbType of ['mysql', 'sqlite']) {
      const dump = await buildDump({ ...bare(dbType), schema: 'sales' }, fakeReader());
      expect(dump).not.toContain('CREATE SCHEMA');
      expect(dump).not.toContain('search_path');
    }
  });

  it('tên schema có dấu nháy kép vẫn ra định danh hợp lệ', async () => {
    const dump = await buildDump({ ...bare('postgres'), schema: 'we"ird' }, fakeReader());
    expect(dump).toContain('CREATE SCHEMA IF NOT EXISTS "we""ird";');
    expect(dump).toContain('SET search_path TO "we""ird";');
  });

  it('hai dòng schema là câu lệnh riêng, và restore_backup luôn chạy chúng', async () => {
    const dump = await buildDump({ ...bare('postgres'), schema: 'sales' }, fakeReader());
    const stmts = splitStatements(dump).map((s) => s.text);
    expect(stmts).toContain('CREATE SCHEMA IF NOT EXISTS "sales"');
    expect(stmts).toContain('SET search_path TO "sales"');
    // The twin of `is_session_level_stmt` (database.rs): anything beginning with SET / CREATE SCHEMA
    // is allowed to run even when the user selected only a few tables. These two lines name no table,
    // so writing them differently would get them dropped by the per-table filter and the dump would
    // import into the wrong schema.
    for (const s of ['CREATE SCHEMA IF NOT EXISTS "sales"', 'SET search_path TO "sales"']) {
      expect(/^(SET |CREATE SCHEMA)/.test(s.toUpperCase())).toBe(true);
    }
  });

  it('header là câu lệnh hợp lệ, không lẫn vào câu lệnh đầu tiên', async () => {
    const dump = await buildDump(bare('mysql'), fakeReader());
    const stmts = splitStatements(dump).map((s) => s.text);
    // The first statement still carries the file's two opening comment lines — exactly what the
    // splitter does (Rust has `strip_leading_comments`), as long as each SET remains its own statement.
    expect(stmts[0].endsWith('SET NAMES utf8mb4')).toBe(true);
    expect(stmts[1]).toBe('SET FOREIGN_KEY_CHECKS = 0');
    expect(stmts[2]).toBe("SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'");
  });
});

describe('buildDump — theo dialect', () => {
  it('MySQL bọc routine/trigger trong DELIMITER và bỏ DEFINER', async () => {
    const dump = await buildDump(spec(), fakeReader());
    expect(dump).toContain('DELIMITER $$');
    expect(dump).toContain('DELIMITER ;');
    expect(dump).not.toContain('DEFINER=');
    // Re-splitting has to yield EXACTLY one statement for the procedure (its body has ';' of its own).
    const stmts = splitStatements(dump).map((s) => s.text);
    const proc = stmts.filter((s) => s.includes('PROCEDURE `film_in_stock`'));
    expect(proc).toHaveLength(1);
    expect(proc[0]).toContain('SELECT 1;');
  });

  it('Postgres: không DROP FUNCTION, DROP TRIGGER có kèm ON <table>, không có DELIMITER', async () => {
    const dump = await buildDump(
      spec({
        dbType: 'postgres',
        tables: ['film'],
        views: [],
        routines: [{ name: 'f', kind: 'function' }],
        triggers: ['trg'],
      }),
      fakeReader({
        getObjectDefinition: async (name) => ({
          success: true,
          sql: `CREATE OR REPLACE FUNCTION "${name}"() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql`,
        }),
        getAllTriggers: async () => [
          { name: 'trg', table: 'film', statement: 'CREATE TRIGGER trg AFTER INSERT ON film EXECUTE FUNCTION f()' },
        ],
      })
    );
    expect(dump).not.toContain('DELIMITER');
    expect(dump).not.toContain('DROP FUNCTION');
    expect(dump).toContain('DROP TRIGGER IF EXISTS "trg" ON "film";');
    expect(dump).not.toContain('DROP VIEW'); // no view was selected -> there must be no DROP VIEW
  });

  it('SQLite: trigger BEGIN...END vẫn đọc lại được thành một câu', async () => {
    const dump = await buildDump(
      spec({ dbType: 'sqlite', tables: ['film'], views: [], routines: [], triggers: ['trg'] }),
      fakeReader({
        getTableDefinition: async (name) => ({ success: true, sql: `CREATE TABLE "${name}" (id integer)` }),
        getAllTriggers: async () => [
          {
            name: 'trg',
            table: 'film',
            statement: 'CREATE TRIGGER trg AFTER INSERT ON film BEGIN UPDATE stat SET n = n + 1; END',
          },
        ],
      })
    );
    const trg = splitStatements(dump).map((s) => s.text).filter((s) => s.includes('CREATE TRIGGER'));
    expect(trg).toHaveLength(1);
    expect(trg[0]).toContain('UPDATE stat SET n = n + 1;');
  });
});

// The things that belong to a table but are not in that dialect's CREATE TABLE (SQLite's indexes;
// Postgres' indexes, FKs, comments and sequences). Where they are placed is the part easily got wrong.
describe('buildDump — phần đi kèm bảng', () => {
  const extrasReader = (over: Record<string, string[]> = {}) =>
    fakeReader({
      getTableDdlExtras: async (table) => ({
        sequences: [`CREATE SEQUENCE IF NOT EXISTS ${table}_id_seq;`],
        indexes: [`CREATE INDEX idx_${table}_a ON ${table} (a);`],
        constraints: [`ALTER TABLE ${table} ADD CONSTRAINT fk_${table} FOREIGN KEY (b) REFERENCES other (id);`],
        comments: [`COMMENT ON TABLE ${table} IS 'x';`],
        sequenceValues: [`SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM ${table}), 1), true);`],
        ...over,
      }),
    });

  it('sequence trước CREATE TABLE, index/comment ngay sau, FK sau MỌI bảng, setval sau dữ liệu', async () => {
    const dump = await buildDump(
      spec({ dbType: 'postgres', tables: ['a_tbl', 'z_tbl'], views: [], routines: [], triggers: [] }),
      extrasReader()
    );
    expect(at(dump, 'CREATE SEQUENCE IF NOT EXISTS a_tbl_id_seq;')).toBeLessThan(at(dump, 'CREATE TABLE `a_tbl`'));
    expect(at(dump, 'CREATE TABLE `a_tbl`')).toBeLessThan(at(dump, 'CREATE INDEX idx_a_tbl_a'));
    expect(at(dump, 'CREATE INDEX idx_a_tbl_a')).toBeLessThan(at(dump, 'COMMENT ON TABLE a_tbl'));
    // The FIRST table's FK has to come after the LAST table's CREATE TABLE, or the referenced table
    // does not exist when the foreign key is attached.
    expect(at(dump, 'CREATE TABLE `z_tbl`')).toBeLessThan(at(dump, 'ADD CONSTRAINT fk_a_tbl'));
    // setval reads MAX(), so it has to come after the INSERTs.
    expect(at(dump, 'INSERT INTO `z_tbl`')).toBeLessThan(at(dump, "setval('a_tbl_id_seq'"));
  });

  it('tắt "kèm cấu trúc" thì không hỏi phần đi kèm và không sinh câu nào', async () => {
    let called = 0;
    const dump = await buildDump(
      spec({
        tables: ['film'],
        views: [],
        routines: [],
        triggers: [],
        sqlOptions: { dropTable: false, includeStructure: false, includeContent: true },
      }),
      fakeReader({
        getTableDdlExtras: async () => {
          called++;
          return { sequences: [], indexes: [], constraints: [], comments: [], sequenceValues: [] };
        },
      })
    );
    expect(called).toBe(0);
    expect(dump).not.toContain('-- Constraints');
    expect(dump).not.toContain('-- Sequence values');
  });

  it('MySQL/SQLite không có phần nào thì dump không thừa tiêu đề rỗng', async () => {
    const dump = await buildDump(spec({ triggers: [] }), fakeReader());
    expect(dump).not.toContain('-- Constraints');
    expect(dump).not.toContain('-- Sequence values');
  });
});

describe('buildDump — dữ liệu trung thực', () => {
  it('cột generated không nằm trong INSERT', async () => {
    const dump = await buildDump(
      spec({ tables: ['film'], views: [], routines: [], triggers: [] }),
      fakeReader({
        getTableSchema: async () => ({
          columns: [
            { name: 'id' },
            { name: 'title' },
            // MySQL 3105 if this column is written to.
            { name: 'title_upper', generated: true },
          ] as any,
          indexes: [],
          foreignKeys: [],
        }),
        getTableData: async () => ({ rows: [{ id: 1, title: 'a', title_upper: 'A' }], totalCount: 1 }),
      })
    );
    expect(dump).toContain('INSERT INTO `film` (`id`, `title`)');
    expect(dump).not.toContain('title_upper');
  });

  it('cột identity vẫn nằm trong INSERT, kèm OVERRIDING SYSTEM VALUE', async () => {
    // Leaving the identity column out makes Postgres renumber -> every foreign key pointing at this table is wrong.
    const dump = await buildDump(
      spec({ dbType: 'postgres', tables: ['film'], views: [], routines: [], triggers: [] }),
      fakeReader({
        getTableSchema: async () => ({
          columns: [{ name: 'id', identityAlways: true }, { name: 'title' }] as any,
          indexes: [],
          foreignKeys: [],
        }),
        getTableData: async () => ({ rows: [{ id: 7, title: 'a' }], totalCount: 1 }),
      })
    );
    expect(dump).toContain('INSERT INTO "film" ("id", "title") OVERRIDING SYSTEM VALUE VALUES');
    expect(dump).toContain('(7, \'a\')');
  });

  it('cột BLOB ra literal hex chứ không phải mảng số', async () => {
    const dump = await buildDump(
      spec({ tables: ['file'], views: [], routines: [], triggers: [] }),
      fakeReader({
        getTableSchema: async () => ({
          columns: [{ name: 'id', type: 'int' }, { name: 'data', type: 'longblob' }] as any,
          indexes: [],
          foreignKeys: [],
        }),
        getTableData: async () => ({ rows: [{ id: 1, data: [137, 80, 78, 71] }], totalCount: 1 }),
      })
    );
    expect(dump).toContain("X'89504e47'");
    expect(dump).not.toContain('[137,80,78,71]');
  });
});

describe('buildDump — event và materialized view', () => {
  it('MySQL event nằm chung khối DELIMITER với routine, có DROP EVENT', async () => {
    const dump = await buildDump(
      spec({ tables: ['film'], views: [], routines: [], triggers: [], events: ['nightly_purge'] }),
      fakeReader({
        getObjectDefinition: async (name, kind) => ({
          success: true,
          sql:
            kind === 'event'
              ? `CREATE DEFINER=\`root\`@\`localhost\` EVENT \`${name}\` ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM log; END`
              : 'CREATE FUNCTION f() RETURNS int RETURN 1',
        }),
      })
    );
    expect(dump).toContain('DROP EVENT IF EXISTS `nightly_purge`;');
    expect(dump).toContain('DELIMITER $$');
    expect(dump).not.toContain('DEFINER=');
    // An event body has ';' of its own -> re-splitting must yield exactly ONE statement.
    const evt = splitStatements(dump).map((s) => s.text).filter((s) => s.includes('EVENT `nightly_purge`'));
    expect(evt).toHaveLength(1);
    expect(evt[0]).toContain('DELETE FROM log;');
  });

  it('materialized view dùng DROP MATERIALIZED VIEW, không phải DROP VIEW', async () => {
    const dump = await buildDump(
      spec({ dbType: 'postgres', tables: ['mv_stats'], views: ['mv_stats'], routines: [], triggers: [] }),
      fakeReader({
        getTableDefinition: async (name) => ({
          success: true,
          sql: `CREATE MATERIALIZED VIEW "${name}" AS\n SELECT 1;`,
        }),
      })
    );
    expect(dump).toContain('DROP MATERIALIZED VIEW IF EXISTS "mv_stats" CASCADE;');
    expect(dump).not.toContain('DROP VIEW IF EXISTS');
    // A matview comes after the tables, so CREATE … WITH DATA (the default) already has data to read.
    expect(dump).toContain('CREATE MATERIALIZED VIEW "mv_stats"');
  });
});

describe('buildDump — đọc lại được bằng chính bộ dò của popup Nhập', () => {
  it('parseDumpObjects nhận ra đủ bảng/view/routine/trigger', async () => {
    const dump = await buildDump(spec(), fakeReader());
    const objs = parseDumpObjects(dump);
    // The fake reader returns `CREATE TABLE` for views too, so a view sits in `tables` here — what is
    // being checked is that every object can be detected again, not how the reader classifies them.
    expect(objs.tables).toEqual(['film', 'actor_info']);
    expect(objs.views).toEqual([]);
    expect(objs.functions).toEqual(['get_balance']);
    expect(objs.procedures).toEqual(['film_in_stock']);
    expect(objs.triggers).toEqual(['ins_film']);
  });

  it('header schema không bị nhận nhầm thành một bảng để chọn', async () => {
    // `parseDumpTableNames` both builds the list the user ticks and is the filter sent down to
    // `restore_backup`. A ghost "sales" entry in it is both confusing and causes the real table's
    // statements to be dropped when only it is selected.
    const dump = await buildDump(
      { ...spec({ dbType: 'postgres', tables: ['film'], views: [], routines: [], triggers: [] }), schema: 'sales' },
      fakeReader()
    );
    expect(dump).toContain('SET search_path TO "sales";');
    expect(parseDumpTableNames(dump)).toEqual(['film']);
  });
});

describe('buildDump — lỗi đọc định nghĩa', () => {
  it('ghi chú thích lỗi thay vì làm hỏng cả lần xuất', async () => {
    const dump = await buildDump(
      spec({ tables: ['film'], views: [], routines: [], triggers: [] }),
      fakeReader({ getTableDefinition: async () => ({ success: false, error: 'boom' }) })
    );
    expect(dump).toContain('boom');
    expect(dump).toContain('INSERT INTO `film`');
  });
});
