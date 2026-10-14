import { describe, it, expect } from 'vitest';
import {
  parseCreateTable,
  parseInsert,
  plannedFromScan,
  parseCopy,
  fileBaseName,
  buildDropStatements,
  stripLeadingSqlComments,
  type DumpObjects,
} from '../dumpPreview';

// What `scan_dump_file` reads from a sakila-like dump — pinned by
// `a_sakila_like_dump_lists_every_object_kind` in dump_scan.rs.
const SAKILA_OBJECTS: DumpObjects = {
  tables: ['actor', 'film_text'],
  views: ['customer_list', 'actor_info'],
  triggers: ['ins_film'],
  procedures: ['rewards_report'],
  functions: ['get_customer_balance'],
};

describe('stripLeadingSqlComments', () => {
  // A mysqldump file glues a comment directly in front of a statement and the splitter keeps that
  // comment in the statement text -> classification has to strip comments first, or LOCK TABLES slips
  // through and causes MySQL 1100 on the next table.
  const lockStmt = '--\n-- Dumping data for table `store`\n--\n\nLOCK TABLES `store` WRITE';

  it('bỏ comment dòng, comment khối và khoảng trắng ở đầu câu', () => {
    expect(stripLeadingSqlComments(lockStmt)).toBe('LOCK TABLES `store` WRITE');
    expect(stripLeadingSqlComments('/* c1 */ /* c2 */\n# a note\nSELECT 1')).toBe('SELECT 1');
    expect(stripLeadingSqlComments('-- ghi chú tiếng Việt\nSELECT 1')).toBe('SELECT 1');
  });

});

describe('buildDropStatements', () => {
  it('MySQL: xoá theo thứ tự trigger -> view -> routine -> table, quote bằng backtick', () => {
    const stmts = buildDropStatements(SAKILA_OBJECTS, 'mysql');
    expect(stmts).toEqual([
      'DROP TRIGGER IF EXISTS `ins_film`;',
      'DROP VIEW IF EXISTS `customer_list`;',
      'DROP VIEW IF EXISTS `actor_info`;',
      'DROP PROCEDURE IF EXISTS `rewards_report`;',
      'DROP FUNCTION IF EXISTS `get_customer_balance`;',
      'DROP TABLE IF EXISTS `actor`;',
      'DROP TABLE IF EXISTS `film_text`;',
    ]);
  });

  it('Postgres: chỉ view/table kèm CASCADE (trigger cần ON table, function cần chữ ký)', () => {
    const stmts = buildDropStatements(SAKILA_OBJECTS, 'postgres');
    expect(stmts).toEqual([
      'DROP VIEW IF EXISTS "customer_list" CASCADE;',
      'DROP VIEW IF EXISTS "actor_info" CASCADE;',
      'DROP TABLE IF EXISTS "actor" CASCADE;',
      'DROP TABLE IF EXISTS "film_text" CASCADE;',
    ]);
  });

  it('SQLite: không có procedure/function', () => {
    const stmts = buildDropStatements(SAKILA_OBJECTS, 'sqlite');
    expect(stmts.some(s => s.includes('PROCEDURE') || s.includes('FUNCTION'))).toBe(false);
    expect(stmts).toContain('DROP TRIGGER IF EXISTS "ins_film";');
  });
});

describe('parseCreateTable', () => {
  it('đọc cột, kiểu và cờ NOT NULL / PK / auto increment (MySQL)', () => {
    const t = parseCreateTable(
      'CREATE TABLE `users` (\n' +
      '  `id` int(11) NOT NULL AUTO_INCREMENT,\n' +
      '  `email` varchar(255) NOT NULL,\n' +
      "  `note` text DEFAULT 'a, b',\n" +
      '  PRIMARY KEY (`id`),\n' +
      '  UNIQUE KEY `uq_email` (`email`)\n' +
      ') ENGINE=InnoDB'
    );
    expect(t?.name).toBe('users');
    expect(t?.columns.map((c) => c.name)).toEqual(['id', 'email', 'note']);
    expect(t?.columns[0].notNull).toBe(true);
    expect(t?.columns[0].autoIncrement).toBe(true);
    // A table-level PRIMARY KEY has to be marked back onto the column
    expect(t?.columns[0].primaryKey).toBe(true);
    expect(t?.columns[1].primaryKey).toBe(false);
    // A DEFAULT holding a comma inside its string must not split the columns wrongly
    expect(t?.columns[2].defaultValue).toBe("'a, b'");
    expect(t?.constraints.some((c) => c.startsWith('UNIQUE KEY'))).toBe(true);
  });

  it('đọc Postgres với schema, kiểu có tham số và IF NOT EXISTS', () => {
    const t = parseCreateTable(
      'CREATE TABLE IF NOT EXISTS public."Trip" (\n' +
      '  id bigserial PRIMARY KEY,\n' +
      '  price numeric(12, 2) NOT NULL DEFAULT 0,\n' +
      '  created_at timestamp with time zone\n' +
      ')'
    );
    expect(t?.name).toBe('Trip');
    expect(t?.columns.map((c) => c.name)).toEqual(['id', 'price', 'created_at']);
    // numeric(12, 2) holds a comma inside parentheses -> still one column
    expect(t?.columns[1].type).toContain('numeric(12, 2)');
    expect(t?.columns[1].defaultValue).toBe('0');
    expect(t?.columns[0].primaryKey).toBe(true);
    expect(t?.columns[2].notNull).toBe(false);
  });

  it('trả null với câu lệnh không phải CREATE TABLE', () => {
    expect(parseCreateTable('CREATE INDEX idx ON users (email)')).toBeNull();
    expect(parseCreateTable('INSERT INTO users VALUES (1)')).toBeNull();
  });
});

describe('parseInsert', () => {
  it('đọc danh sách cột và nhiều tuple giá trị', () => {
    const r = parseInsert(
      "INSERT INTO `users` (`id`, `email`) VALUES (1, 'a@b.c'), (2, 'x@y.z')"
    );
    expect(r?.table).toBe('users');
    expect(r?.columns).toEqual(['id', 'email']);
    expect(r?.rows).toEqual([
      ['1', 'a@b.c'],
      ['2', 'x@y.z'],
    ]);
  });

  it('giữ nguyên phẩy và nháy escape trong chuỗi', () => {
    const r = parseInsert("INSERT INTO t (a, b) VALUES ('x, y', 'it''s')");
    expect(r?.rows[0]).toEqual(['x, y', "it's"]);
  });

  it('không có danh sách cột thì columns = null', () => {
    const r = parseInsert('INSERT INTO t VALUES (1, NULL)');
    expect(r?.columns).toBeNull();
    expect(r?.rows[0]).toEqual(['1', 'NULL']);
  });

  it('trả null với câu lệnh khác', () => {
    expect(parseInsert('UPDATE t SET a = 1')).toBeNull();
  });

  // Export packs up to 500 rows into one INSERT -> the tuple reader has to be O(n), and has to read them all.
  it('đọc đủ dòng của một INSERT gộp nhiều dòng', () => {
    const tuples = Array.from({ length: 500 }, (_, i) => `(${i}, 'name ${i}')`).join(',\n');
    const r = parseInsert(`INSERT INTO \`t\` (\`id\`, \`name\`) VALUES\n${tuples}`);
    expect(r?.rows).toHaveLength(500);
    expect(r?.rows[0]).toEqual(['0', 'name 0']);
    expect(r?.rows[499]).toEqual(['499', 'name 499']);
  });

  it('không ăn vào phần đuôi sau danh sách tuple', () => {
    const r = parseInsert(
      "INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y') ON DUPLICATE KEY UPDATE b = VALUES(b)"
    );
    expect(r?.rows).toEqual([
      ['1', 'x'],
      ['2', 'y'],
    ]);
  });

  it('ngoặc và phẩy nằm trong chuỗi không cắt sai tuple', () => {
    const r = parseInsert("INSERT INTO t (a) VALUES ('a),(b'), ('c')");
    expect(r?.rows).toEqual([['a),(b'], ['c']]);
  });
});

describe('parseCopy', () => {
  it('reads the column list and the tab-separated data lines of a pg_dump COPY', () => {
    const stmt = 'COPY bookings.flights (flight_id, route_no, note) FROM stdin;\n1\tPG0001\t\\N\n2\tPG0002\ta\\tb\\\\c\n\\.';
    expect(parseCopy(stmt)).toEqual({
      table: 'flights',
      columns: ['flight_id', 'route_no', 'note'],
      rows: [
        ['1', 'PG0001', 'NULL'],
        ['2', 'PG0002', 'a\tb\\c'],
      ],
    });
  });

  it('no column list means columns = null; anything else is not a COPY', () => {
    expect(parseCopy('COPY t FROM stdin;\n1\n\\.')?.columns).toBeNull();
    expect(parseCopy('INSERT INTO t VALUES (1)')).toBeNull();
  });
});

describe('plannedFromScan', () => {
  const plan = { always: 3, byTable: { actor: 10, film: 5, tmp: 2 } };

  it('counts the always-run statements plus those of the selected tables', () => {
    expect(plannedFromScan(plan, ['actor', 'film'], ['film'])).toBe(8);
    expect(plannedFromScan(plan, ['actor', 'film'], [])).toBe(3);
  });

  it('adds the prepended DROP statements', () => {
    expect(plannedFromScan(plan, ['actor', 'film'], ['actor'], 4)).toBe(17);
  });

  it('with no table detected, everything runs', () => {
    expect(plannedFromScan(plan, [], [])).toBe(20);
  });
});

describe('fileBaseName', () => {
  it('takes the last segment for either separator', () => {
    expect(fileBaseName('C:\\dumps\\a.sql.gz')).toBe('a.sql.gz');
    expect(fileBaseName('/home/u/b.sql')).toBe('b.sql');
    expect(fileBaseName('c.sql')).toBe('c.sql');
  });
});
