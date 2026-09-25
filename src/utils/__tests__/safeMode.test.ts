import { describe, expect, it, beforeEach } from 'vitest';
// `?raw` rather than node:fs — the app tsconfig types `vite/client`, not node, and Vite inlines the
// text at transform time, so this reads the real source without pulling in @types/node.
import dbHelperSource from '../dbHelper.ts?raw';
import {
  COMMAND_KINDS,
  commandKind,
  isReadStatement,
  registerConnection,
  resetSafeModeState,
  sqlHasWrite,
  statementHead,
  summarizeSql,
  describeCommand,
  getSafeMode,
  getSafeModeForKey,
  setSafeModeForKey,
  STATEMENT_PREVIEW_CAP,
  approveCommand,
  approveJob,
  approveJobForServer,
  openJobDoor,
  runApproved,
  setSafeModeConfirmer,
  type SafeModeRequest,
} from '../safeMode';
import { connKey } from '../connKey';
import type { DbConnectionConfig } from '../dbHelper';

// Vitest runs with `environment: 'node'`, which has no localStorage — `safeMode` degrades to
// "nothing stored" there (same shape as the i18n detector no-oping without `window`). The storage
// tests need a real one, so install the smallest thing that behaves like it.
const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: (i: number) => [...memory.keys()][i] ?? null,
  get length() {
    return memory.size;
  },
} satisfies Storage;

/** Every command name `dbHelper` invokes, straight from its source. */
function invokedCommands(): string[] {
  const names = new Set<string>();
  for (const m of dbHelperSource.matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-z0-9_]+)'/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

describe('COMMAND_KINDS is the twin of dbHelper', () => {
  // The whole point of the table: an unclassified command counts as a write, so forgetting one
  // costs a needless prompt rather than a silent bypass. This test turns "needless prompt" into
  // "the build tells you", which is the only reason the table stays trustworthy.
  it('classifies every command dbHelper invokes', () => {
    const missing = invokedCommands().filter((cmd) => !(cmd in COMMAND_KINDS));
    expect(missing).toEqual([]);
  });

  it('has no entry for a command dbHelper no longer invokes', () => {
    const live = new Set(invokedCommands());
    const stale = Object.keys(COMMAND_KINDS).filter((cmd) => !live.has(cmd));
    expect(stale).toEqual([]);
  });

  it('treats an unknown command as a write', () => {
    expect(commandKind('some_new_command_nobody_classified')).toBe('write');
  });

  it('never marks a SQL-carrying command as internal', () => {
    for (const cmd of ['execute_query', 'execute_multi_query', 'execute_query_stream']) {
      expect(COMMAND_KINDS[cmd]).toBe('sql');
    }
  });

  it('keeps the paths that build SQL in Rust on the write side', () => {
    for (const cmd of [
      'commit_changes',
      'drop_table',
      'truncate_table',
      'alter_table_schema',
      'restore_backup',
      'generate_data',
      'rename_table',
      'import_chunk',
    ]) {
      expect(COMMAND_KINDS[cmd]).toBe('write');
    }
  });
});

describe('statement classification', () => {
  it('reads the first keyword past comments, parens and whitespace', () => {
    expect(statementHead('  SELECT 1')).toBe('SELECT');
    expect(statementHead('/* note */ select 1')).toBe('SELECT');
    expect(statementHead('(SELECT 1) UNION (SELECT 2)')).toBe('SELECT');
    expect(statementHead('-- drop table x\nUPDATE t SET a = 1')).toBe('UPDATE');
  });

  it('counts only plain reads as reads', () => {
    expect(isReadStatement('SELECT * FROM t')).toBe(true);
    expect(isReadStatement('EXPLAIN SELECT 1')).toBe(true);
    expect(isReadStatement('SHOW TABLES')).toBe(true);
    expect(isReadStatement('DESCRIBE users')).toBe(true);
    expect(isReadStatement('UPDATE t SET a = 1')).toBe(false);
    expect(isReadStatement('CREATE TABLE t (id int)')).toBe(false);
  });

  it('treats WITH and anything unrecognised as a write', () => {
    // Postgres allows `WITH ... DELETE`, so the head alone cannot clear it.
    expect(isReadStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false);
    expect(isReadStatement('CALL do_something()')).toBe(false);
    expect(isReadStatement('¿qué?')).toBe(false);
  });

  it('ignores keywords inside strings and comments', () => {
    expect(sqlHasWrite("SELECT * FROM t WHERE note = 'delete from x'")).toBe(false);
    expect(sqlHasWrite('SELECT 1; -- DELETE FROM t')).toBe(false);
    expect(sqlHasWrite('SELECT 1; DELETE FROM t WHERE id = 1')).toBe(true);
  });

  it('says no write for empty or comment-only text', () => {
    expect(sqlHasWrite('')).toBe(false);
    expect(sqlHasWrite('   -- nothing here\n')).toBe(false);
  });
});

describe('summarizeSql', () => {
  it('counts every statement but previews only the first few', () => {
    const sql = Array.from({ length: STATEMENT_PREVIEW_CAP + 7 }, (_, i) => `UPDATE t SET a = ${i} WHERE id = ${i}`).join(';\n');
    const s = summarizeSql(sql);
    expect(s.total).toBe(STATEMENT_PREVIEW_CAP + 7);
    expect(s.preview).toHaveLength(STATEMENT_PREVIEW_CAP);
    expect(s.counts).toEqual({ UPDATE: STATEMENT_PREVIEW_CAP + 7 });
  });

  it('groups counts by leading keyword', () => {
    const s = summarizeSql('SELECT 1; UPDATE t SET a=1 WHERE id=1; UPDATE t SET a=2 WHERE id=2; DELETE FROM t WHERE id=3');
    expect(s.counts).toEqual({ SELECT: 1, UPDATE: 2, DELETE: 1 });
  });

  it('carries the SQL editor’s unsafe shapes through', () => {
    const s = summarizeSql('DELETE FROM users');
    expect(s.unsafe.map((u) => u.kind)).toEqual(['deleteNoWhere']);
  });
});

describe('mode storage', () => {
  const pgConfig = { type: 'postgres', host: 'prod.db', port: 5432 } as unknown as DbConnectionConfig;
  const localConfig = { type: 'postgres', host: 'localhost', port: 5432 } as unknown as DbConnectionConfig;

  beforeEach(() => {
    localStorage.clear();
    resetSafeModeState();
  });

  it('defaults to silent so nothing changes for an existing user', () => {
    registerConnection('c1', pgConfig);
    expect(getSafeMode('c1')).toBe('silent');
  });

  it('stores per server, not per connection id', () => {
    registerConnection('c1', pgConfig);
    registerConnection('c2', pgConfig);
    registerConnection('c3', localConfig);
    setSafeModeForKey(connKey(pgConfig), 'writes');
    // Same host:port -> same policy, even though it is a different connection.
    expect(getSafeMode('c1')).toBe('writes');
    expect(getSafeMode('c2')).toBe('writes');
    expect(getSafeMode('c3')).toBe('silent');
  });

  it('falls back to the strictest configured mode for an unregistered id', () => {
    setSafeModeForKey(connKey(pgConfig), 'all');
    expect(getSafeMode('unknown-id')).toBe('all');
  });

  it('ignores a write with no key — nothing to store it under', () => {
    setSafeModeForKey('', 'all');
    expect(getSafeModeForKey('')).toBe('silent');
  });

  it('keeps Redis on its own server key, not on whatever connection is active', () => {
    // Redis is a registry entry with its own conn id now, so it resolves through the SAME
    // id -> server map as SQL. The property under test is unchanged — a Redis write must never be
    // judged by an unrelated SQL server's policy — but it no longer needs a prefix special case,
    // and unlike the old single `redisServerKey` this also holds for two Redis servers at once.
    const redisConfig = { type: 'redis', host: 'cache.local', port: 6379 } as unknown as DbConnectionConfig;
    const redis2 = { type: 'redis', host: 'other.local', port: 6379 } as unknown as DbConnectionConfig;
    registerConnection('c1', pgConfig);
    setSafeModeForKey(connKey(pgConfig), 'all');
    registerConnection('r1', redisConfig);
    registerConnection('r2', redis2);
    expect(getSafeMode('r1')).toBe('silent');
    setSafeModeForKey(connKey(redisConfig), 'writes');
    expect(getSafeMode('r1')).toBe('writes');
    // The second Redis server keeps its own policy — impossible with one global Redis key.
    expect(getSafeMode('r2')).toBe('silent');
    expect(getSafeMode('c1')).toBe('all');
  });
});

describe('runApproved asks once for a whole action', () => {
  const redisConfig = { type: 'redis', host: 'cache.local', port: 6379 } as unknown as DbConnectionConfig;
  let asked: SafeModeRequest[];

  beforeEach(() => {
    memory.clear();
    resetSafeModeState();
    asked = [];
    setSafeModeConfirmer(async (req) => { asked.push(req); return true; });
    registerConnection('r1', redisConfig);
    setSafeModeForKey(connKey(redisConfig), 'writes');
  });

  // Why this function exists: importing 10,000 keys is 50 batches, and after 50 dialogs the user switches Safe Mode off.
  it('prompts once even though the action runs the command many times', async () => {
    await runApproved('redis_restore_keys', 'r1', 'nhập 10.000 key', async () => {
      for (let i = 0; i < 50; i += 1) {
        expect(await approveCommand('redis_restore_keys', { connId: 'r1' })).toBe(true);
      }
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].detail).toBe('nhập 10.000 key');
    expect(asked[0].command).toBe('redis_restore_keys');
  });

  // A narrow door: an approved import must not carry another command through, nor the same command on another connection.
  it('opens the door for that command on that connection only', async () => {
    registerConnection('r2', { type: 'redis', host: 'other.local', port: 6379 } as unknown as DbConnectionConfig);
    setSafeModeForKey(connKey({ type: 'redis', host: 'other.local', port: 6379 } as unknown as DbConnectionConfig), 'writes');

    await runApproved('redis_restore_keys', 'r1', 'nhập', async () => {
      await approveCommand('redis_flush_db', { connId: 'r1' });
      await approveCommand('redis_restore_keys', { connId: 'r2' });
    });
    // Once for the action, plus twice for the two commands OUTSIDE what was approved.
    expect(asked.map((r) => r.command)).toEqual([
      'redis_restore_keys', 'redis_flush_db', 'redis_restore_keys',
    ]);
  });

  it('closes the door when the action throws', async () => {
    await expect(
      runApproved('redis_restore_keys', 'r1', 'nhập', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(await approveCommand('redis_restore_keys', { connId: 'r1' })).toBe(true);
    expect(asked).toHaveLength(2); // one for the action, one for the stray command after it
  });

  it('keeps the door open for the outer action when a nested one ends', async () => {
    await runApproved('redis_restore_keys', 'r1', 'ngoài', async () => {
      await runApproved('redis_restore_keys', 'r1', 'trong', async () => {});
      // The outer run's door has to stay open — this is why it counts depth instead of holding a flag.
      expect(await approveCommand('redis_restore_keys', { connId: 'r1' })).toBe(true);
    });
    expect(asked).toHaveLength(1);
  });

  it('declining throws and runs nothing', async () => {
    setSafeModeConfirmer(async () => false);
    let ran = false;
    await expect(
      runApproved('redis_restore_keys', 'r1', 'nhập', async () => { ran = true; }),
    ).rejects.toBeDefined();
    expect(ran).toBe(false);
  });

  it('does not prompt at all when the server is on silent', async () => {
    setSafeModeForKey(connKey(redisConfig), 'silent');
    let ran = false;
    await runApproved('redis_restore_keys', 'r1', 'nhập', async () => { ran = true; });
    expect(ran).toBe(true);
    expect(asked).toEqual([]);
  });
});

// A background job is asked about when it is SUBMITTED, and its writes then go through on the job's
// own connection id without a second question — never on any other id.
describe('approveJob asks at submit and opens a door on the job connection only', () => {
  const pgConfig = { type: 'postgres', host: 'db.local', port: 5432 } as unknown as DbConnectionConfig;
  let asked: SafeModeRequest[];

  beforeEach(() => {
    memory.clear();
    resetSafeModeState();
    asked = [];
    setSafeModeConfirmer(async (req) => { asked.push(req); return true; });
    registerConnection('user1', pgConfig);
    setSafeModeForKey(connKey(pgConfig), 'writes');
  });

  it('asks once, up front, with the description the caller gave', async () => {
    await approveJob('restore_backup', 'user1', 'restore into sakila');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ command: 'restore_backup', detail: 'restore into sakila' });
  });

  it('lets the approved command through on the job id, and only there', async () => {
    const approval = await approveJob('restore_backup', 'user1', 'x');
    // The job's id inherits the server, like `openJobConnection` records it.
    registerConnection('job1', pgConfig);
    const close = openJobDoor(approval, 'job1');
    expect(await approveCommand('restore_backup', { connId: 'job1' })).toBe(true);
    // The user's own connection is not covered, nor is another command on the job's id.
    await approveCommand('restore_backup', { connId: 'user1' });
    await approveCommand('drop_table', { connId: 'job1' });
    expect(asked.map((r) => [r.command, r.connId])).toEqual([
      ['restore_backup', 'user1'],
      ['restore_backup', 'user1'],
      ['drop_table', 'job1'],
    ]);
    close();
    close(); // idempotent: a second close must not close someone else's door
    await approveCommand('restore_backup', { connId: 'job1' });
    expect(asked).toHaveLength(4);
  });

  it('throws when the user declines, so the job is never queued', async () => {
    setSafeModeConfirmer(async () => false);
    await expect(approveJob('restore_backup', 'user1', 'x')).rejects.toBeDefined();
  });

  it('asks by server key when no connection exists yet', async () => {
    await approveJobForServer('restore_backup', connKey(pgConfig), 'from the form');
    expect(asked).toHaveLength(1);
    await approveJobForServer('restore_backup', 'sqlite:C:/other.db', 'silent server');
    expect(asked).toHaveLength(1);
  });

  it('does not ask for a server on silent', async () => {
    setSafeModeForKey(connKey(pgConfig), 'silent');
    await approveJob('restore_backup', 'user1', 'x');
    expect(asked).toEqual([]);
  });
});

// The grid's Save calls `commit_changes` twice: once with `preview: true` to show the preview list,
// and once to write. Asking about both shows the user a dialog that "refuses to close", and the first
// one asks about an operation that writes nothing at all.
describe('a dry-run commit does not prompt', () => {
  const pgConfig = { type: 'postgres', host: 'db.local', port: 5432 } as unknown as DbConnectionConfig;
  let asked: SafeModeRequest[];

  beforeEach(() => {
    memory.clear();
    resetSafeModeState();
    asked = [];
    setSafeModeConfirmer(async (req) => { asked.push(req); return true; });
    registerConnection('c1', pgConfig);
    setSafeModeForKey(connKey(pgConfig), 'writes');
  });

  it('passes a preview through and still asks about the real write', async () => {
    const changes = { tableName: 't', changes: [], primaryKey: 'id' };
    expect(await approveCommand('commit_changes', { connId: 'c1', payload: { ...changes, preview: true } })).toBe(true);
    expect(asked).toEqual([]);

    expect(await approveCommand('commit_changes', { connId: 'c1', payload: { ...changes, preview: false } })).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it('asks when the flag is missing or not a real true', async () => {
    await approveCommand('commit_changes', { connId: 'c1', payload: { tableName: 't' } });
    await approveCommand('commit_changes', { connId: 'c1', payload: { preview: 'true' } });
    await approveCommand('commit_changes', { connId: 'c1' });
    expect(asked).toHaveLength(3);
  });
});

// The dialog used to say only "this writes to the database" plus the Rust function name — true, but
// no answer, because the real question is "how many rows, into which table". Every number below comes
// from the command's own args.
describe('describeCommand', () => {
  it('counts the grid changes by kind and names the table', () => {
    const t = describeCommand('commit_changes', {
      connId: 'c1',
      payload: {
        tableName: 'film',
        changes: [
          { type: 'update', rowId: 1 },
          { type: 'update', rowId: 2 },
          { type: 'delete', rowId: 3 },
        ],
      },
    });
    expect(t.name).toBe('film');
    expect(t.changes).toEqual({ inserts: 0, updates: 2, deletes: 1 });
    // The overall count must not be set alongside them: a "3 items" line next to "2 edits · 1 delete" says it twice.
    expect(t.count).toBeUndefined();
  });

  it('reads the target name by convention, whatever the argument is called', () => {
    expect(describeCommand('drop_table', { name: 'actor' }).name).toBe('actor');
    expect(describeCommand('rename_table', { tableName: 'city' }).name).toBe('city');
    expect(describeCommand('redis_delete_by_pattern', { pattern: 'session:*' }).name).toBe('session:*');
  });

  it('counts a list of items for the commands that take one', () => {
    expect(describeCommand('redis_delete_keys', { keys: ['a', 'b', 'c'] }).count).toBe(3);
    expect(describeCommand('import_chunk', { rows: [[1], [2]] }).count).toBe(2);
  });

  it('returns nothing rather than inventing a name', () => {
    expect(describeCommand('restore_backup', { connId: 'c1' })).toEqual({ name: undefined });
    // An empty or whitespace string is not a name.
    expect(describeCommand('drop_table', { name: '   ' }).name).toBeUndefined();
  });
});
