import { invoke as rawInvoke, Channel } from '@tauri-apps/api/core';
import i18n from '../i18n';
import { translateBackendError, translateResultErrors } from './backendErrors';
import {
  approveCommand,
  forgetConnection,
  inheritConnection,
  registerConnection,
} from './safeMode';
import { getStmtTimeoutForConfig } from './stmtTimeout';
import type {
  CompareSide,
  DataCompareResult,
  DataOverviewResult,
  SchemaCompareResult,
} from './compareHelper';
import type {
  GenPreview,
  GenProgress,
  GenResult,
  GenSpec,
  GenTargets,
} from './dataGenHelper';
import type { ProcessListSummary, KillResult } from './processMonitorTypes';

/**
 * Which backend connection commands act on. Set from `connect()`'s response, cleared by
 * `disconnect()`.
 *
 * **A migration shim, not the design.** `docs/multi-connection-plan.md` §4.1 rules out an ambient
 * "active connection" precisely because a module-level value read here is the race it describes:
 * with two tabs on two connections, whichever one wrote last decides where the other one's query
 * goes. It is safe only while Phase 1 keeps the backend at exactly one connection, and Phase 2's
 * exit condition is that nothing reads it — each tab passes the `connId` it owns instead.
 */
let currentConnId = '';

/** Returns the minted id so `App.tsx` can hand it to the tab that owns the connection (Phase 2). */
export function activeConnId(): string {
  return currentConnId;
}

/**
 * Point every later command at a different open connection. The rail calls this when the user
 * switches; `connect()` sets it for a brand-new connection.
 *
 * Still the ambient shim §4.1 rules out as a *design* — it is honest only while the UI shows one
 * connection at a time. Phase 3 replaces it with each tab passing the `connId` it owns.
 */
export function setActiveConnId(id: string): void {
  currentConnId = id;
}

/** One entry of the backend's connection registry — see `list_connections`. */
export interface OpenConnection {
  connId: string;
  db: string;
  /** `redis` since Redis shares the registry — the rail draws both from one list (§2.3). */
  dialect: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  serverId: string;
  schema: string | null;
  /** WRITE statements waiting to be committed on this connection — the rail's badge (§4.2b). */
  pending: number;
  /** This connection is refusing every write. */
  readOnly: boolean;
  /** Is this connection visible to AI clients through the built-in MCP server? Default false. */
  mcpExposed: boolean;
  /**
   * May an AI client ask to WRITE on it? Default false, and it goes back to false whenever
   * `mcpExposed` does — a permission that came back on its own would be the worst kind.
   */
  mcpWrite: boolean;
}

/** State of the built-in MCP server. `url` is empty while stopped, so no one copies a dead address. */
export interface McpStatus {
  running: boolean;
  port: number;
  url: string;
  /** This app's own executable, for the `--mcp-stdio` client config. */
  exePath: string;
}

/** One request an AI client made. Mirrors `mcp/audit.rs`. */
export interface McpAuditEntry {
  /** Monotonic within one app run — a stable React key for a list that grows at the front. */
  id: number;
  at: string;
  tool: string;
  connId: string | null;
  sql: string | null;
  sqlTruncated: boolean;
  ms: number;
  ok: boolean;
  /**
   * Absent when `ok`. Mirrors `mcp::audit::Denial` — `badOrigin`/`badToken` are the two door layers,
   * refused before any tool runs, so they carry no `connId` or `sql`.
   */
  denial?:
    | 'badOrigin'
    | 'badToken'
    | 'notShared'
    | 'notReadOnly'
    | 'manualTransaction'
    | 'writeNotAllowed'
    | 'notApproved'
    | 'failed';
  /** Which defence layer refused; `0` when the database itself failed. */
  layer?: number;
  message?: string;
}

/**
 * Every backend call goes through here so the Vietnamese error text the Rust side
 * returns is mapped to the active UI language in ONE place — see `backendErrors.ts`.
 * Shadowing the imported name keeps all existing `await invoke(...)` call sites
 * unchanged; a message with no mapping is passed through untouched.
 *
 * The same trick now also supplies `connId` to every connection-bound command, so adding that
 * argument on the Rust side cost zero of the 210 `dbHelper.*` call sites. A command that does not
 * declare it simply ignores the extra field — Tauri deserializes by name.
 */
async function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const merged = { connId: currentConnId, ...args };
  // Safe Mode asks here, in front of every command, because this is the single funnel every
  // `dbHelper.*` call passes through — see `safeMode.ts` for why the gate is not in Rust and why a
  // command missing from its table counts as a write. Declining throws, like a backend error would,
  // so the surrounding `catch` in each method turns it into the usual `{ success: false, error }`.
  if (!(await approveCommand(cmd, merged))) throw i18n.t('safeMode.cancelled');
  try {
    return translateResultErrors(await rawInvoke<T>(cmd, merged));
  } catch (err) {
    // A command that returns Err(String) surfaces here as a thrown *string*, and the
    // catch blocks below interpolate it directly (`${err}`). Rethrow a string, not an
    // Error, so the message does not gain an "Error: " prefix.
    throw typeof err === 'string' ? translateBackendError(err) : err;
  }
}

/**
 * Sets `connId` only when there is a real value.
 *
 * Writing `{ ...args, connId }` directly will not do: `invoke` above merges
 * `{ connId: currentConnId, ...args }`, so an explicit `connId: undefined` **overwrites** the ambient
 * id with `undefined` and every command loses its connection. This is the one place that knows that
 * rule.
 */
function withConnId(args: Record<string, unknown>, connId?: string): Record<string, unknown> {
  return connId ? { ...args, connId } : args;
}

// Messages the backend pushes over the Channel while streaming SQL results (execute_query_stream).
export interface QueryStreamMessage {
  type: 'columns' | 'rows' | 'affected' | 'done' | 'error';
  stmtIndex?: number;
  query?: string;
  columns?: string[];
  rows?: any[];
  affected?: number;
  stmtCount?: number;
  cancelled?: boolean;
  message?: string;
}

// Messages the backend pushes over the Channel for the SSH Terminal (open_ssh_terminal).
export interface SshTerminalMessage {
  type: 'data' | 'exit' | 'closed';
  bytes?: number[];
  code?: number;
}

export interface TriggerInfo {
  name: string;
  timing: string;
  event: string;
  statement: string;
}

export interface SequenceInfo {
  name: string;
  dataType: string;
  startValue: string;
  minVal: string;
  maxVal: string;
  incrementBy: string;
  cycle: boolean;
}

export interface PartitionInfo {
  name: string;
  method: string;
  expression: string;
  description: string;
  tableRows: number;
  dataLength: number;
}

export interface CheckConstraintInfo {
  name: string;
  expression: string;
  enforced: boolean;
}

export interface DbConnectionConfig {
  type: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  sqlitePath?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  dbIndex?: number; // Redis: the database index, 0-15
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key';
  sshPassword?: string;
  sshKeyPath?: string;
  sshKeyContent?: string;
  sshPassphrase?: string;
  sslEnabled?: boolean;
  sslMode?: string;
  sslKeyPath?: string;
  sslCertPath?: string;
  sslCaPath?: string;
  /**
   * The most seconds ONE statement the user runs may take (SQL editor + a page read in the grid).
   * `0`/absent = no limit. Postgres/MySQL only; SQLite skips it (see `stmt_timeout` in
   * `database.rs`).
   */
  statementTimeoutSecs?: number;
  // AWS IAM authentication (RDS/Aurora)
  authMethod?: 'password' | 'aws_iam';
  awsAuthType?: 'access_key' | 'profile';
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  awsProfile?: string;
  awsRegion?: string;
}

/**
 * The state of the current session (`get_connection_status`).
 *
 * Every field describing the session is "best effort" on the Rust side: an old server, or an
 * account without the privilege, gets an empty string back rather than an error, so whatever
 * displays it has to handle empty itself. An empty `cipher`/`tlsVersion` means the session is not
 * encrypted.
 */
export interface ConnectionStatus {
  isConnected: boolean;
  dbType: string;
  connType: 'loc' | 'ssh' | 'ssl' | 'rem';
  host: string;
  latencyMs: number;
  serverVersion: string;
  user: string;
  database: string;
  port: number;
  cipher: string;
  tlsVersion: string;
}

/**
 * Manual transaction state. Rust is the single source of truth: the frontend does NOT parse SQL to
 * guess whether a transaction is still open — see `src-tauri/src/tx_session.rs`. Every time the
 * state moves, the backend emits a `tx-state-changed` event carrying exactly this object.
 */
export interface TxStatus {
  autocommit: boolean;
  open: boolean;
  /** Postgres: one failed statement poisons the whole transaction, leaving only rollback. */
  aborted: boolean;
  /** The number of **write** statements in the transaction. A read (SELECT/SHOW/…) opens the
   *  transaction but is not counted — this number promises "this many changes are waiting". */
  statements: number;
  /** The SQL of exactly those statements, for the "pending changes" dialog to show. */
  pendingSql: string[];
  /** The log hit its size cap -> `pendingSql` holds fewer than `statements`, and that must be said. */
  sqlTruncated: boolean;
  sinceMs: number;
  isolation: string | null;
  readOnly: boolean;
  savepoints: string[];
  /** The statement just run committed by itself (DDL on MySQL) -> the counter reset without the user. */
  implicitCommit: boolean;
  /**
   * The connection this state belongs to. One session per connection, and the backend emits a
   * `tx-state-changed` per session — `TxControl` filters on this field, without which the second
   * connection's event would overwrite what the first one shows.
   *
   * Optional: a backend older than the running window will not send it (`tauri dev` keeps the last
   * binary that built when Rust fails to compile).
   */
  connId?: string;
}

export const TX_EVENT = 'tx-state-changed';

/** The isolation levels each dialect allows — the twin of `isolation_allowed` in tx_session.rs. */
export const TX_ISOLATION_LEVELS: Record<string, string[]> = {
  postgres: ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
  mysql: ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
  // SQLite has no isolation levels; the equivalent is BEGIN's locking mode.
  sqlite: ['DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'],
};

export interface TableItem {
  name: string;
  type: 'table' | 'view';
  /**
   * The schema this object lives in, when it is NOT the connection's current one. Only
   * `getTemporaryTables` fills it, and only on Postgres, where a session-temporary table sits in
   * `pg_temp_N`: every read of such a table has to name that schema or the backend looks for it in
   * `public` and reports a table the sidebar is showing as non-existent. Left undefined everywhere
   * else, which is what keeps the ordinary path byte-identical.
   */
  schema?: string;
  /** True only for a row that came from `getTemporaryTables`. Drives the badge and the drop verb. */
  temporary?: boolean;
}

/**
 * Everything the Properties tab shows about one table, from a single `get_table_properties` call.
 *
 * Almost every field is nullable because almost every field is dialect-specific: `engine` and
 * `rowFormat` are MySQL's, `liveTuples`/`deadTuples`/`lastVacuum` are Postgres', `filePath` is
 * SQLite's. A missing value renders as "-" rather than as 0 — "unknown" and "zero" are different
 * answers, and a size card that reads 0 B for a table it simply could not measure is a bug report.
 */
export interface TableProperties {
  tableName: string;
  schemaName?: string | null;
  dbType: string;
  tableType: string;
  isTemporary: boolean;
  isView: boolean;
  engine?: string | null;
  rowFormat?: string | null;
  collation?: string | null;
  characterSet?: string | null;
  comment?: string | null;
  tablespace?: string | null;
  /** MySQL's CREATE_OPTIONS (`partitioned`, `row_format=DYNAMIC`, …). Null on the other dialects. */
  createOptions?: string | null;
  filePath?: string | null;
  estimatedRows: number;
  /** Whether `estimatedRows` was counted rather than sampled — false hides nothing, it shows a `~`. */
  rowsExact: boolean;
  dataSizeBytes?: number | null;
  indexSizeBytes?: number | null;
  totalSizeBytes?: number | null;
  freeSizeBytes?: number | null;
  avgRowLengthBytes?: number | null;
  autoIncrement?: number | null;
  createTime?: string | null;
  updateTime?: string | null;
  checkTime?: string | null;
  columnCount: number;
  primaryKeys: string[];
  indexCount?: number | null;
  foreignKeyCount?: number | null;
  /** Foreign keys pointing AT this table — the incoming half of the relationship count. */
  referencedByCount?: number | null;
  liveTuples?: number | null;
  deadTuples?: number | null;
  seqScans?: number | null;
  indexScans?: number | null;
  lastVacuum?: string | null;
  lastAnalyze?: string | null;
  ddl?: string | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue: string | null;
  autoIncrement?: boolean;
  comment?: string | null;
  extra?: string | null;
  /**
   * A column the database COMPUTES itself (`GENERATED ALWAYS AS (...)`). Writing to it is an error
   * (MySQL 3105), so a dump has to drop it from the INSERT column list entirely.
   */
  generated?: boolean;
  /**
   * Postgres `GENERATED ALWAYS AS IDENTITY`. Unlike `generated`, this column MUST stay in the
   * INSERT (leaving it out renumbers everything, and every foreign key pointing at it goes wrong
   * with it) — the statement just needs `OVERRIDING SYSTEM VALUE` added.
   */
  identityAlways?: boolean;
  characterSet?: string | null;
  collation?: string | null;
}

export interface SchemaInfo {
  columns: ColumnInfo[];
  indexes: { name: string; columns: string; unique: boolean }[];
  foreignKeys: { name?: string; column: string; refTable: string; refColumn: string }[];
}

export interface GridChange {
  type: 'insert' | 'update' | 'delete';
  rowId: any;
  originalData?: any;
  newData?: any;
}

// ---- Redis types ----
export interface RedisKeyItem {
  key: string;
  type: string; // string | hash | list | set | zset | stream
  ttl: number; // -1 = no expiry, -2 = does not exist
}

export interface RedisValueDetail {
  success: boolean;
  key: string;
  type: string;
  ttl: number;
  memory: number | null;
  /** The collection's element count (HLEN/LLEN/SCARD/ZCARD/XLEN); null for a string. */
  length?: number | null;
  value: any; // the shape depends on kind (see redis_get_key in the backend)
  message?: string;
}

/** The result of one element-editing command (hash/list/set/zset/stream). */
export interface RedisEditResult {
  success: boolean;
  error?: string;
}

/**
 * One element of a collection. `binary` = the original value is not valid UTF-8 and `value` has
 * been lossy-converted -> it must NOT be written back (that would replace the real bytes with
 * U+FFFD). See `is_binary` in `redis_db.rs`.
 */
export interface RedisElement {
  value: string;
  binary?: boolean;
  /** Identity of the element is itself binary (hash field, set/zset member) -> delete is unsafe too. */
  binaryKey?: boolean;
}

/** What the connected server supports, probed once at connect (see `RedisCaps` in Rust). */
export interface RedisCaps {
  version: string;
  major: number;
  minor: number;
  /** Lowercased module names; empty when `MODULE LIST` was refused by ACL. */
  modules: string[];
}

/**
 * One page of a collection. `nextCursor` is **opaque** — its meaning differs per type
 * (SCAN cursor / rank / index / stream id) and only `redis_db.rs` knows which; pass it back
 * unchanged.
 */
export interface RedisElementsPage {
  success: boolean;
  kind: string;
  elements: any[];
  nextCursor: string;
  done: boolean;
  error?: string;
}

export interface RedisSlowLogEntry {
  id: number;
  timestamp: number;
  durationUs: number;
  args: string[];
  clientAddr: string;
  clientName: string;
}

export interface RedisAnalysis {
  success: boolean;
  dbsize: number;
  sampled: number;
  sampledBytes: number;
  estimatedBytes: number | null;
  byType: { name: string; count: number; bytes: number }[];
  byNamespace: { name: string; count: number; bytes: number }[];
  ttlBuckets: { noExpiry: number; under1h: number; under1d: number; under7d: number; over7d: number };
  topKeys: { key: string; bytes: number; type: string }[];
  warnings?: string[];
  cancelled?: boolean;
  error?: string;
}

/**
 * `translateResultErrors` only covers the `message`/`error` fields. The comparison
 * commands also return a `warnings` array of backend strings, so run those through the
 * same table — otherwise an English UI would show Vietnamese notes.
 */
function translateWarnings<T extends { warnings?: string[] }>(res: T): T {
  if (Array.isArray(res?.warnings)) {
    res.warnings = res.warnings.map((w) => (typeof w === 'string' ? translateBackendError(w) : w));
  }
  return res;
}

export const dbHelper = {
  async connect(
    config: DbConnectionConfig,
  ): Promise<{
    success: boolean;
    message: string;
    database?: string;
    schema?: string | null;
    /** The connection id just minted. Redis returns one too, since it shares the registry (§2.3). */
    connId?: string;
  }> {
    // Redis goes through its own redis_* commands, not SQL's connect_db.
    if (config.type === 'redis') {
      try {
        const res: any = await invoke('redis_connect', {
          config: {
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            dbIndex: config.dbIndex ?? 0,
            // TLS: `sslEnabled` is the old switch (profiles from before the SSL tab have only it),
            // while `sslMode` is what actually decides how far the certificate is checked — see
            // redis_ssl_mode in redis_db.rs.
            sslEnabled: config.sslEnabled,
            sslMode: config.sslMode,
            sslKeyPath: config.sslKeyPath,
            sslCertPath: config.sslCertPath,
            sslCaPath: config.sslCaPath,
            useSsh: config.sshEnabled,
            sshHost: config.sshHost,
            sshPort: config.sshPort,
            sshUser: config.sshUser,
            sshAuthType: config.sshAuthType,
            sshPassword: config.sshPassword,
            sshKeyPath: config.sshKeyPath,
            sshKeyContent: config.sshKeyContent,
            sshPassphrase: config.sshPassphrase,
          },
        });
        if (res.success) {
          // Redis is a registry entry like any other now (`redis-ui-unification-plan.md` §2.3), so
          // it mints a `connId` the same way and every later `redis_*` command carries it through
          // the shim above. Setting it BEFORE `registerConnection` matters: Safe Mode keys the
          // server by this id, and that is what replaced the Redis-only key it used to keep.
          currentConnId = res.connId ?? '';
          registerConnection(currentConnId, config);
          return {
            success: true,
            message: i18n.t('db.redisConnected'),
            database: `db${res.dbIndex ?? config.dbIndex ?? 0}`,
            connId: currentConnId,
          };
        }
        return { success: false, message: res.message || i18n.t('db.errRedisConnect') };
      } catch (err: any) {
        return { success: false, message: i18n.t('db.errRedisConnectDetail', { message: String(err) }) };
      }
    }
    try {
      const mappedConfig = {
        dbType: config.type,
        filePath: config.sqlitePath,
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        useSsh: config.sshEnabled,
        sshHost: config.sshHost,
        sshPort: config.sshPort,
        sshUser: config.sshUser,
        sshAuthType: config.sshAuthType,
        sshPassword: config.sshPassword,
        sshKeyPath: config.sshKeyPath,
        sshKeyContent: config.sshKeyContent,
        sshPassphrase: config.sshPassphrase,
        sslEnabled: config.sslEnabled,
        sslMode: config.sslMode,
        sslKeyPath: config.sslKeyPath,
        sslCertPath: config.sslCertPath,
        sslCaPath: config.sslCaPath,
        // The statement time limit is stored per server in localStorage (the Safe Mode popover),
        // not in the profile. It is read here so a freshly opened connection carries the right limit
        // from its very first statement — `setStatementTimeout` is only for changing it mid-session.
        statementTimeoutSecs: getStmtTimeoutForConfig(config),
        authMethod: config.authMethod,
        awsAuthType: config.awsAuthType,
        awsAccessKeyId: config.awsAccessKeyId,
        awsSecretAccessKey: config.awsSecretAccessKey,
        awsSessionToken: config.awsSessionToken,
        awsProfile: config.awsProfile,
        awsRegion: config.awsRegion,
      };

      const res: any = await invoke('connect_db', { config: mappedConfig });
      if (res.success) {
        // The backend mints the id and hands it back; it is never derived from `config`, which
        // carries credentials (multi-connection-plan §4.3). Every later command carries it.
        currentConnId = res.connId ?? '';
        // Safe Mode is stored per server (`connKey`), and the backend never hands the config back,
        // so the id→server mapping has to be recorded at the one place that has both.
        registerConnection(currentConnId, config);
        // `schema` is the schema the connection actually landed in (Postgres `current_schema()`),
        // null on MySQL/SQLite. Callers key per-connection storage on it — see connKey.ts.
        return {
          success: true,
          message: i18n.t('db.connected'),
          database: config.database || config.sqlitePath,
          schema: res.schema ?? null,
          // Handed back like the Redis branch does. A caller that opens a connection of its own
          // (Connection Manager's Backup screen) must address it by this id: reading the ambient
          // `currentConnId` instead is exactly the race §4.1 rules out, and passing the id of the
          // connection the workspace has open would dump the wrong database.
          connId: currentConnId,
        };
      }
      return { success: false, message: res.message || i18n.t('db.errConnect') };
    } catch (err: any) {
      return { success: false, message: i18n.t('db.errBackendUnreachable', { message: String(err) }) };
    }
  },

  /**
   * Closes a connection. Without a `connId` it closes the active one.
   *
   * Passing one explicitly is how the rail closes a connection that is **not** the one being viewed
   * — and in that case `currentConnId` must stay as it is, because the viewed connection was never
   * touched.
   */
  async disconnect(connId?: string): Promise<{ success: boolean }> {
    const target = connId ?? currentConnId;
    try {
      const res: any = await invoke('disconnect_db', { connId: target });
      // Cleared AFTER the call, and only when the active one is what closed: the command needs the
      // id to know which entry to remove. With an empty id every later command fails with the very
      // "not connected" error, because `acquire` cannot resolve it — which is the right answer.
      if (target === currentConnId) currentConnId = '';
      forgetConnection(target);
      return { success: !!res.success };
    } catch {
      if (target === currentConnId) currentConnId = '';
      forgetConnection(target);
      return { success: false };
    }
  },

  async getConnectionStatus(): Promise<ConnectionStatus> {
    try {
      const res: any = await invoke('get_connection_status');
      return {
        isConnected: !!res.is_connected,
        dbType: res.db_type || '',
        connType: res.conn_type || 'loc',
        host: res.host || '',
        latencyMs: res.latency_ms || 0,
        serverVersion: res.server_version || '',
        user: res.user || '',
        database: res.database || '',
        port: res.port || 0,
        cipher: res.cipher || '',
        tlsVersion: res.tls_version || '',
      };
    } catch {
      return {
        isConnected: false,
        dbType: '',
        connType: 'loc',
        host: '',
        latencyMs: 0,
        serverVersion: '',
        user: '',
        database: '',
        port: 0,
        cipher: '',
        tlsVersion: '',
      };
    }
  },

  async getTables(connId: string, ): Promise<TableItem[]> {
    try {
      const res: any = await invoke('get_tables', { connId });
      return res.tables || [];
    } catch {
      return [];
    }
  },

  /**
   * The temp tables/views this session owns, for the sidebar's Temporary section.
   *
   * Returns `[]` — never throws — when the server has no way to answer (an InnoDB build without
   * `INNODB_TEMP_TABLE_INFO`, a connection that just dropped): an empty section and an unanswerable
   * question look the same to the user, and neither is worth an error toast on every refresh.
   */
  async getTemporaryTables(connId: string): Promise<TableItem[]> {
    try {
      const res: any = await invoke('get_temporary_tables', { connId });
      return res.tables || [];
    } catch {
      return [];
    }
  },

  // Fetches the whole catalog (columns+types+PK, FKs per table) in few queries, to warm the completion cache.
  async getFullCatalog(connId: string, ): Promise<{ columns: Record<string, any[]>; foreignKeys: Record<string, any[]> }> {
    try {
      const res: any = await invoke('get_full_catalog', { connId });
      return { columns: res.columns || {}, foreignKeys: res.foreignKeys || {} };
    } catch {
      return { columns: {}, foreignKeys: {} };
    }
  },

  /**
   * One page of a table's data, with the total row count.
   *
   * `countMode` defaults to `'exact'` — every existing caller keeps its behaviour. Do not change
   * that default: the export paths (`dumpBuilder`, `ExportTableDialog`) loop until
   * `rows.length >= totalCount`, so a number that is **too low** there ends the loop early and
   * writes a truncated dump with no error at all. Only the grid's status line — the one place that
   * can show a `~` — asks for `'auto'`/`'skip'`.
   *
   * `totalCount` is `null` when nothing was counted (`'skip'`) or the count failed; `0` only ever
   * means the table is empty. `hasMore` comes from one extra row read in the backend, so it is right
   * even when the count is an estimate.
   *
   * `seekColumn` + `cursor` are keyset pagination: put the previous page's `nextCursor` into
   * `cursor` and the backend seeks instead of using `OFFSET`. Leave both out to fall back to
   * page-number paging. To the frontend `cursor` is an **opaque value** — do not build one by
   * reading the key out of a data row: an i64 key above 2^53 loses digits through `JSON.parse`,
   * while `nextCursor` is written exactly by the backend.
   */
  async getTableData(connId: string,
    tableName: string,
    page: number = 1,
    pageSize: number = 100,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
    filter?: string,
    opts: {
      countMode?: 'exact' | 'auto' | 'skip';
      seekColumn?: string | null;
      cursor?: string | null;
      /** `TableItem.schema` — set only for a Postgres session-temporary table. */
      schema?: string | null;
    } = {}
  ): Promise<{
    rows: any[];
    totalCount: number | null;
    countExact: boolean;
    hasMore: boolean;
    nextCursor: string | null;
    primaryKey?: string;
  }> {
    try {
      const res: any = await invoke('get_table_data', {
        connId,
        name: tableName,
        page,
        limit: pageSize,
        sortBy: sortBy || null,
        sortDir: sortDir || null,
        filter: filter || null,
        countMode: opts.countMode || 'exact',
        seekColumn: opts.seekColumn || null,
        cursor: opts.cursor || null,
        schemaOverride: opts.schema || null,
      });
      const rows = res.data || [];
      return {
        rows,
        totalCount: typeof res.totalCount === 'number' ? res.totalCount : null,
        // An older backend does not send this field; treat it as an exact count, which is what it did.
        countExact: res.countExact !== false,
        // Likewise: with no `hasMore`, infer it from whether the page came back full.
        hasMore: typeof res.hasMore === 'boolean' ? res.hasMore : rows.length >= pageSize,
        nextCursor: typeof res.nextCursor === 'string' ? res.nextCursor : null,
        primaryKey: res.primaryKey,
      };
    } catch (err) {
      console.error(err);
      return { rows: [], totalCount: null, countExact: true, hasMore: false, nextCursor: null };
    }
  },

  /**
   * Changes the statement time limit of an open connection.
   *
   * It takes effect from the next statement, with no reconnect: the backend re-reads the config on
   * every run (see `stmt_timeout` in `database.rs`). The durable store is localStorage, per server
   * (`stmtTimeout.ts`); this command only syncs that value into the running session.
   */
  async setStatementTimeout(connId: string, secs: number): Promise<boolean> {
    try {
      await invoke('set_statement_timeout', { connId, secs });
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  },

  async getDatabaseObjects(connId: string, ): Promise<{
    tables: string[];
    views: string[];
    functions: string[];
    procedures: string[];
    /** MySQL scheduled events; always empty on Postgres/SQLite, which have none. */
    events: string[];
  }> {
    try {
      const res: any = await invoke('get_database_objects', { connId });
      return {
        tables: res.tables || [],
        views: res.views || [],
        functions: res.functions || [],
        procedures: res.procedures || [],
        events: res.events || [],
      };
    } catch (err) {
      // Swallowing the error silently here once made the Export dialog show a list missing its
      // routines with no sign of anything wrong — log it so it can still be traced.
      console.warn('[dbHelper] get_database_objects failed:', err);
      return { tables: [], views: [], functions: [], procedures: [], events: [] };
    }
  },



  async getObjectDefinition(connId: string, name: string, kind: 'view' | 'function' | 'procedure' | 'table' | 'event'): Promise<{ success: boolean; sql?: string; error?: string }> {
    try {
      const res: any = await invoke('get_object_definition', { connId, name, kind });
      return { success: !!res.success, sql: res.sql, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getTableTriggers(connId: string, tableName: string): Promise<TriggerInfo[]> {
    try {
      const res: any = await invoke('get_table_triggers', { connId, tableName });
      return res.triggers || [];
    } catch {
      return [];
    }
  },

  /**
   * Every trigger in the current database, with a re-runnable `CREATE TRIGGER` for each.
   *
   * Unlike `getTableTriggers` (per table, for the Structure tab), this one is for the dump path:
   * one call for the whole database, and it carries the owning table name because Postgres cannot
   * DROP a trigger without `ON <table>`.
   */
  async getAllTriggers(connId: string): Promise<{ name: string; table: string; statement: string }[]> {
    try {
      const res: any = await invoke('get_all_triggers', { connId });
      return res.triggers || [];
    } catch (err) {
      console.warn('[dbHelper] get_all_triggers failed:', err);
      return [];
    }
  },

  /**
   * The statements that belong to a table but are not part of that dialect's CREATE TABLE (indexes,
   * FK/UNIQUE/CHECK, comments, sequences). Grouped by WHERE they have to run — see
   * `get_table_ddl_extras` on the Rust side.
   */
  async getTableDdlExtras(connId: string, tableName: string): Promise<{
    sequences: string[];
    indexes: string[];
    constraints: string[];
    comments: string[];
    sequenceValues: string[];
  }> {
    const empty = { sequences: [], indexes: [], constraints: [], comments: [], sequenceValues: [] };
    try {
      const res: any = await invoke('get_table_ddl_extras', { connId, tableName });
      return {
        sequences: res.sequences || [],
        indexes: res.indexes || [],
        constraints: res.constraints || [],
        comments: res.comments || [],
        sequenceValues: res.sequenceValues || [],
      };
    } catch (err) {
      console.warn('[dbHelper] get_table_ddl_extras failed:', err);
      return empty;
    }
  },

  async saveTrigger(connId: string, statementSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('save_trigger', { connId, statementSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async dropTrigger(connId: string, triggerName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_trigger', { connId, triggerName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async saveRoutineDefinition(connId: string, routineSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('save_routine_definition', { connId, routineSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getSequences(connId: string): Promise<SequenceInfo[]> {
    try {
      const res: any = await invoke('get_sequences', { connId });
      return res.sequences || [];
    } catch {
      return [];
    }
  },

  async alterSequence(connId: string, sequenceSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('alter_sequence', { connId, sequenceSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async dropSequence(connId: string, sequenceName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_sequence', { connId, sequenceName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getTablePartitions(connId: string, tableName: string): Promise<PartitionInfo[]> {
    try {
      const res: any = await invoke('get_table_partitions', { connId, tableName });
      return res.partitions || [];
    } catch {
      return [];
    }
  },

  async getCheckConstraints(connId: string, tableName: string): Promise<CheckConstraintInfo[]> {
    try {
      const res: any = await invoke('get_check_constraints', { connId, tableName });
      return res.constraints || [];
    } catch {
      return [];
    }
  },

  async saveViewDefinition(viewSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('save_view_definition', { viewSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  /** `schema` is `TableItem.schema` — see there; leave it out for an ordinary table. */
  async getTableSchema(connId: string, tableName: string, schema?: string | null): Promise<SchemaInfo> {
    try {
      const res: any = await invoke('get_table_schema', { connId, name: tableName, schemaOverride: schema || null });
      return {
        columns: res.columns || [],
        indexes: res.indexes || [],
        foreignKeys: res.foreignKeys || [],
      };
    } catch {
      return { columns: [], indexes: [], foreignKeys: [] };
    }
  },

  async executeQuery(connId: string, sql: string, params?: any[]): Promise<{ success: boolean; data?: any[]; columns?: string[]; affectedRows?: number; executionTime?: number; error?: string; results?: any[] }> {
    try {
      const res: any = await invoke('execute_query', { connId, sql, params: params ?? null });
      if (res.success && res.results && res.results.length > 0) {
        return {
          success: true,
          data: res.results[0].data || [],
          columns: res.results[0].columns || [],
        };
      }
      return { success: false, error: i18n.t('db.errNoQueryData') };
    } catch (err: any) {
      return { success: false, error: i18n.t('db.errQuery', { message: String(err) }) };
    }
  },

  async executeQueryMulti(connId: string, sql: string): Promise<{ success: boolean; results: { query: string; columns: string[]; data: any[] }[]; error?: string }> {
    try {
      const res: any = await invoke('execute_multi_query', { connId, sql });
      return {
        success: !!res.success,
        results: (res.results || []).map((r: any) => ({
          query: r.query || '',
          columns: r.columns || [],
          data: r.data || [],
        })),
        error: res.message,
      };
    } catch (err: any) {
      return { success: false, results: [], error: i18n.t('db.errQuery', { message: String(err) }) };
    }
  },

  // Runs SQL and receives the results batch by batch over a Channel (streaming) instead of waiting
  // for all of them. The promise resolves when the backend has finished (it has already sent a
  // 'done' or 'error' message). `queryId` is what cancelQuery uses to stop it midway.
  async executeQueryStream(connId: string, 
    sql: string,
    queryId: string,
    onMessage: (msg: QueryStreamMessage) => void,
    params?: any[]
  ): Promise<void> {
    const channel = new Channel<QueryStreamMessage>();
    channel.onmessage = onMessage;
    // params: values already coerced (number/bool/null/string) for the backend to bind at the driver
    // level (a parameterized query, which is what stops SQL injection). Omitted when Query
    // Parameters are not in use.
    await invoke('execute_query_stream', { connId, sql, queryId, channel, params: params ?? null });
  },

  // ---- Manual transactions ----
  // Errors are thrown, not swallowed, because every action here is a button the user pressed
  // directly: a Commit that failed silently is the worst possible failure in this group.

  /**
   * Every connection the backend currently holds — what the left rail lists. The rail shows *open
   * connections*, not every database on the server, so this replaces the `list_databases` query it
   * used to run against the active connection.
   */
  /**
   * Turns read-only mode on or off for ONE connection.
   *
   * The gate is in the backend, inside the three SQL funnels — not in the UI. The SQL editor sends
   * arbitrary text, so a lock in the WebView is a lock on the wrong side of the IPC boundary. This
   * is the same conclusion `src-tauri/src/redis_db.rs` already reached for the Redis console.
   */
  async setConnectionReadOnly(connId: string, enabled: boolean): Promise<boolean> {
    const res = await invoke<{ readOnly: boolean }>('set_connection_read_only', { connId, enabled });
    return !!res.readOnly;
  },

  /**
   * Show one connection to AI clients, or hide it again.
   *
   * Separate from `setConnectionReadOnly` even though the shape matches: "may this be written to"
   * and "may an AI client see it at all" are different questions, and a connection can sensibly be
   * read-only and hidden, or writable and shared.
   */
  async setConnectionMcpExposed(connId: string, enabled: boolean): Promise<boolean> {
    const res = await invoke<{ mcpExposed: boolean }>('set_connection_mcp_exposed', { connId, enabled });
    return !!res.mcpExposed;
  },

  /**
   * Let an AI client ask to write on one connection, or stop letting it.
   *
   * A third switch next to `setConnectionReadOnly` and `setConnectionMcpExposed`, answering the
   * third question: not what the connection may do, nor whether an AI may see it, but whether an
   * AI may propose changing it. The backend refuses this on a connection that is not shared.
   */
  async setConnectionMcpWrite(connId: string, enabled: boolean): Promise<boolean> {
    const res = await invoke<{ mcpWrite: boolean }>('set_connection_mcp_write', { connId, enabled });
    return !!res.mcpWrite;
  },

  async mcpStatus(): Promise<McpStatus> {
    return invoke<McpStatus>('mcp_status');
  },

  async mcpStart(port?: number): Promise<McpStatus> {
    return invoke<McpStatus>('mcp_start', { port });
  },

  async mcpStop(): Promise<McpStatus> {
    return invoke<McpStatus>('mcp_stop');
  },

  async mcpGetToken(): Promise<string> {
    return invoke<string>('mcp_get_token');
  },

  /** Mints a new token. The server restarts if it was running, so every client on the old token stops. */
  async mcpRegenerateToken(): Promise<string> {
    return invoke<string>('mcp_regenerate_token');
  },

  /** Newest first. In memory on the Rust side — it does not survive closing the app. */
  async mcpAuditLog(): Promise<McpAuditEntry[]> {
    return invoke<McpAuditEntry[]>('mcp_audit_log');
  },

  async mcpAuditClear(): Promise<void> {
    await invoke<void>('mcp_audit_clear');
  },

  /**
   * The audit log kept on disk, across runs — encrypted, with the key in the OS keyring.
   *
   * `unreadable` counts lines that failed to decrypt. That is a signal, not a glitch: each line is
   * bound to the previous one, so a removed or reordered line makes the rest fail to open. The UI
   * has to show the number rather than a quietly shorter list.
   */
  async mcpAuditFileRead(): Promise<{ entries: McpAuditEntry[]; unreadable: number; error: string | null }> {
    return invoke<{ entries: McpAuditEntry[]; unreadable: number; error: string | null }>('mcp_audit_file_read');
  },

  /**
   * Answer one parked write request from an AI client.
   *
   * Rejects when the request is no longer pending (it timed out), rather than reporting success
   * for an approval that arrived too late to run anything — see `mcp/approval.rs`.
   */
  async mcpApprovalRespond(requestId: string, approved: boolean): Promise<void> {
    await invoke<void>('mcp_approval_respond', { requestId, approved });
  },

  async listConnections(): Promise<OpenConnection[]> {
    const res = await invoke<{ connections: OpenConnection[] }>('list_connections');
    return res.connections || [];
  },

  /**
   * The latency of every open connection, keyed by `connId`.
   *
   * Separate from `getConnectionStatus`, which also asks for version/user/TLS and so costs 3–5 round
   * trips per connection — see `ping_connections`. Returns a `Map` rather than an array because
   * every caller looks it up by id.
   */
  async pingConnections(): Promise<Map<string, { ok: boolean; latencyMs: number }>> {
    const res = await invoke<{ pings: { connId: string; ok: boolean; latencyMs: number }[] }>(
      'ping_connections',
    );
    return new Map((res.pings || []).map((p) => [p.connId, { ok: p.ok, latencyMs: p.latencyMs }]));
  },

  async txStatus(): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_status');
  },

  /**
   * Is any connection holding uncommitted changes? The window-close guard asks this instead of
   * reading the shown connection's status — closing the window ends every session, so a per-
   * connection answer would silently discard another tab's transaction.
   */
  async txAnyPending(): Promise<boolean> {
    const res = await invoke<{ anyPending: boolean }>('tx_any_pending');
    return !!res.anyPending;
  },

  async txSetAutocommit(enabled: boolean): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_set_autocommit', { enabled });
  },

  async txSetIsolation(level: string | null, readOnly?: boolean): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_set_isolation', { level, readOnly: readOnly ?? null });
  },

  async txCommit(): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_commit');
  },

  async txRollback(): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_rollback');
  },

  async txSavepoint(name: string): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_savepoint', { name });
  },

  async txRollbackTo(name: string): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_rollback_to', { name });
  },

  // Asks a streaming query to stop. A queryId that is no longer running is simply ignored.
  async cancelQuery(queryId: string): Promise<void> {
    try {
      await invoke('cancel_query', { queryId });
    } catch {
      /* skip */
    }
  },

  // ---- The OS secret store ----
  // DB passwords, SSH password/passphrase/private key, AWS secret key… live in Windows Credential
  // Manager / Keychain / Secret Service, not in localStorage.
  // See src-tauri/src/secret_store.rs and src/utils/secretFields.ts.

  // Reads a profile's secrets. A field that was never stored is simply absent from the result.
  async getSecrets(profileId: string, fields: string[]): Promise<Record<string, string>> {
    return await invoke('secret_get_many', { profileId, fields });
  },

  // Writes a profile's secrets. An empty value means delete that field.
  async setSecrets(profileId: string, values: Record<string, string>): Promise<void> {
    await invoke('secret_set_many', { profileId, values });
  },

  // Deletes a profile's secrets (when the profile itself is deleted).
  async deleteSecrets(profileId: string, fields: string[]): Promise<void> {
    await invoke('secret_delete_many', { profileId, fields });
  },

  // ---- SSH Terminal ----
  // Opens an SSH session plus a PTY/shell. The server pushes its output back over a Channel
  // (onMessage).
  async openSshTerminal(
    profileConfig: DbConnectionConfig,
    sessionId: string,
    cols: number,
    rows: number,
    onMessage: (msg: SshTerminalMessage) => void
  ): Promise<void> {
    const channel = new Channel<SshTerminalMessage>();
    channel.onmessage = onMessage;
    await invoke('open_ssh_terminal', {
      profileConfig: {
        sshHost: profileConfig.sshHost,
        sshPort: profileConfig.sshPort,
        sshUser: profileConfig.sshUser,
        sshAuthType: profileConfig.sshAuthType,
        sshPassword: profileConfig.sshPassword,
        sshKeyPath: profileConfig.sshKeyPath,
        sshKeyContent: profileConfig.sshKeyContent,
        sshPassphrase: profileConfig.sshPassphrase,
      },
      sessionId,
      cols,
      rows,
      channel,
    });
  },

  async sendSshInput(sessionId: string, data: string): Promise<void> {
    try {
      await invoke('send_ssh_input', { sessionId, data });
    } catch {
      /* skip */
    }
  },

  async resizeSshTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    try {
      await invoke('resize_ssh_terminal', { sessionId, cols, rows });
    } catch {
      /* skip */
    }
  },

  async closeSshTerminal(sessionId: string): Promise<void> {
    try {
      await invoke('close_ssh_terminal', { sessionId });
    } catch {
      /* skip */
    }
  },

  // ---- Local Terminal (a local shell, no SSH involved) ----
  async openLocalTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    onMessage: (msg: SshTerminalMessage) => void
  ): Promise<void> {
    const channel = new Channel<SshTerminalMessage>();
    channel.onmessage = onMessage;
    await invoke('open_local_terminal', { sessionId, cols, rows, channel });
  },

  async sendLocalInput(sessionId: string, data: string): Promise<void> {
    try {
      await invoke('send_local_input', { sessionId, data });
    } catch {
      /* skip */
    }
  },

  async resizeLocalTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    try {
      await invoke('resize_local_terminal', { sessionId, cols, rows });
    } catch {
      /* skip */
    }
  },

  async closeLocalTerminal(sessionId: string): Promise<void> {
    try {
      await invoke('close_local_terminal', { sessionId });
    } catch {
      /* skip */
    }
  },

  // Finds the DB server's log file paths by asking the database itself, over the open connection.
  // Returns a list of {label, path}, empty when the server logs to stderr/syslog/TABLE and there is
  // no file at all.
  //
  // It returns an `error` too rather than swallowing one: the old try/catch returned an empty array,
  // so every failure (connection lost, missing privilege, driver without support) looked exactly
  // like "there is no log file" — leaving no way to tell why the feature did nothing.
  //
  // Each dialect uses exactly ONE statement; nothing here relies on driver multi-statement support.
  async detectLogPaths(connId: string, 
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis'
  ): Promise<{ paths: { label: string; path: string }[]; error?: string }> {
    const isAbs = (s: string) => /^([/~]|[A-Za-z]:[\\/])/.test(s);
    const paths: { label: string; path: string }[] = [];
    const pick = (row: any, key: string) =>
      String(row?.[key] ?? row?.[key.toLowerCase()] ?? '').trim();

    try {
      if (dbType === 'mysql') {
        const res = await this.executeQuery(
          connId,
          "SHOW VARIABLES WHERE Variable_name IN ('log_error','slow_query_log_file','general_log_file','datadir')"
        );
        if (!res.success) return { paths, error: res.error || i18n.t('db.errShowVariables') };
        for (const row of res.data || []) {
          const name = pick(row, 'Variable_name');
          const val = pick(row, 'Value');
          // MySQL returns 'stderr' when the log does not go to a file -> nothing to tail
          if (name && val && val.toLowerCase() !== 'stderr') {
            paths.push({ label: name, path: val });
          }
        }
      } else if (dbType === 'postgres') {
        const res = await this.executeQuery(
          connId,
          `SELECT 'current_logfile' AS name, pg_current_logfile() AS setting
           UNION ALL
           SELECT name, setting FROM pg_settings
           WHERE name IN ('data_directory','log_directory','log_filename')`
        );
        if (!res.success) return { paths, error: res.error || i18n.t('db.errPgSettings') };
        const map: Record<string, string> = {};
        for (const row of res.data || []) {
          map[pick(row, 'name')] = pick(row, 'setting');
        }
        const dataDir = map['data_directory'] || '';
        const cur = map['current_logfile'];
        const logDir = map['log_directory'];
        if (cur) paths.push({ label: 'current_logfile', path: isAbs(cur) ? cur : `${dataDir}/${cur}` });
        if (logDir) paths.push({ label: 'log_directory', path: isAbs(logDir) ? logDir : `${dataDir}/${logDir}` });
      } else {
        return { paths, error: i18n.t('db.errNoServerLog', { dbType }) };
      }
    } catch (e: any) {
      return { paths, error: String(e?.message || e) };
    }
    return { paths };
  },

  // Turns on logging on the DB server, over the current connection. Needs a high privilege
  // (SUPER/superuser). kind: mysql 'general'|'slow'; postgres 'statements'|'collector'.
  // needsRestart = true means it takes effect only after restarting the server by hand.
  async enableLogging(connId: string, 
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis',
    kind: string
  ): Promise<{ success: boolean; message: string; needsRestart: boolean }> {
    let sql = '';
    let needsRestart = false;
    if (dbType === 'mysql') {
      if (kind === 'general') sql = "SET GLOBAL log_output='FILE'; SET GLOBAL general_log='ON';";
      else sql = "SET GLOBAL slow_query_log='ON'; SET GLOBAL long_query_time=1;";
    } else if (dbType === 'postgres') {
      if (kind === 'collector') { sql = "ALTER SYSTEM SET logging_collector='on';"; needsRestart = true; }
      else sql = "ALTER SYSTEM SET log_statement='all'; SELECT pg_reload_conf();";
    } else {
      return { success: false, message: i18n.t('db.errSqliteNoServerLog'), needsRestart: false };
    }
    const res = await this.executeQueryMulti(connId, sql);
    return { success: res.success, message: res.error || '', needsRestart };
  },

  async disableLogging(connId: string, dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis', kind: string): Promise<{ success: boolean; message: string }> {
    let sql = '';
    if (dbType === 'mysql') {
      sql = kind === 'general' ? "SET GLOBAL general_log='OFF';" : "SET GLOBAL slow_query_log='OFF';";
    } else if (dbType === 'postgres') {
      sql = kind === 'collector'
        ? 'ALTER SYSTEM RESET logging_collector;'
        : 'ALTER SYSTEM RESET log_statement; SELECT pg_reload_conf();';
    } else {
      return { success: false, message: i18n.t('db.errNotForSqlite') };
    }
    const res = await this.executeQueryMulti(connId, sql);
    return { success: res.success, message: res.error || '' };
  },

  async commitChanges(connId: string, 
    tableName: string,
    changes: GridChange[],
    primaryKey?: string,
    preview?: boolean
  ): Promise<{ success: boolean; message?: string; sqls?: string[] }> {
    try {
      const res: any = await invoke('commit_changes', { connId, payload: { tableName, changes, primaryKey, preview: !!preview } });
      return { success: !!res.success, sqls: res.sqls, message: res.message };
    } catch (err: any) {
      return { success: false, message: i18n.t('db.errCommitChanges', { message: String(err) }) };
    }
  },

  async alterTableSchema(connId: string, 
    tableName: string, 
    changes: { 
      added: any[]; 
      dropped: string[]; 
      renamed: any[]; 
      modified: any[];
      addedIndexes?: any[];
      droppedIndexes?: string[];
      addedFKs?: any[];
      droppedFKs?: any[];
    }
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const res: any = await invoke('alter_table_schema', { connId, name: tableName, payload: changes });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: i18n.t('db.errConnection', { message: String(err) }) };
    }
  },

  async previewAlterTableSchema(connId: string, 
    tableName: string, 
    changes: { 
      added: any[]; 
      dropped: string[]; 
      renamed: any[]; 
      modified: any[];
      addedIndexes?: any[];
      droppedIndexes?: string[];
      addedFKs?: any[];
      droppedFKs?: any[];
    }
  ): Promise<{ success: boolean; sqls?: string[]; error?: string }> {
    try {
      const res: any = await invoke('preview_alter_schema', { connId, name: tableName, payload: changes });
      return {
        success: !!res.success,
        sqls: res.sql ? [res.sql] : [],
      };
    } catch (err: any) {
      return { success: false, error: i18n.t('db.errConnection', { message: String(err) }) };
    }
  },

  async askAi(prompt: string, _schemaContext: string): Promise<{ response: string }> {
    try {
      const res: any = await invoke('ai_chat', { message: prompt });
      return { response: res.reply || '' };
    } catch {
      return { response: i18n.t('db.errAiUnreachable') };
    }
  },

  async importNewTable(tableName: string, rows: any[]): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('import_new_table', { tableName, rows });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async renameTable(connId: string, oldName: string, newName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('rename_table', { connId, oldName, newName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // isView/cascade/ignoreFk are the Delete dialog's options. The backend runs the whole group
  // (disable FK checks -> DROP -> enable again) on ONE connection; do not issue the SET here
  // yourself, because each executeQuery takes a different connection out of the pool.
  async dropTable(connId: string, 
    name: string,
    /** `schema` is `TableItem.schema` — set only for a Postgres session-temporary table. */
    opts?: { isView?: boolean; cascade?: boolean; ignoreFk?: boolean; schema?: string | null }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_table', {
        connId,
        name,
        isView: opts?.isView ?? false,
        cascade: opts?.cascade ?? false,
        ignoreFk: opts?.ignoreFk ?? false,
        schemaOverride: opts?.schema ?? null,
      });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async listDatabases(connId: string, ): Promise<{ success: boolean; databases: string[]; error?: string }> {
    try {
      const res: any = await invoke('list_databases', { connId });
      return { success: !!res.success, databases: res.databases || [], error: res.message };
    } catch (err: any) {
      return { success: false, databases: [], error: err.toString() };
    }
  },

  /**
   * Opens another database on the **same server** as a NEW connection (§4.3).
   *
   * Unlike `switchDatabase`, which *replaces* the pool and therefore has to refuse while changes are
   * uncommitted and reset the transaction session, this one *adds* a pool and touches nothing that
   * exists — a transaction open on the current database keeps running while the user works in
   * another one.
   *
   * Idempotent: a database that is already open returns the connection already holding it.
   */
  async openDatabase(
    connId: string,
    name: string,
  ): Promise<{ success: boolean; connId?: string; database?: string; schema?: string | null; error?: string }> {
    try {
      const res: any = await invoke('open_database', { connId, name });
      // Another database on the SAME server, so it inherits that server's Safe Mode.
      if (res.connId) inheritConnection(connId, res.connId);
      return { success: !!res.success, connId: res.connId, database: res.database, schema: res.schema ?? null };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Schemas of the current Postgres connection. Empty on MySQL/SQLite — which is how the caller
   * decides whether to show a schema picker at all.
   *
   * `current` is what the backend will actually use; read it from here rather than from local
   * picker state, since on a fresh connection the user has not chosen anything yet.
   */
  async listSchemas(connId: string, ): Promise<{ success: boolean; schemas: string[]; current?: string | null; error?: string }> {
    try {
      const res: any = await invoke('list_schemas', { connId });
      return {
        success: !!res.success,
        schemas: res.schemas || [],
        current: res.current ?? null,
        error: res.message,
      };
    } catch (err: any) {
      return { success: false, schemas: [], error: err.toString() };
    }
  },

  /** Selects the schema every later command reads and writes through (Postgres only). */
  async setSchema(connId: string, name: string): Promise<{ success: boolean; schema?: string; error?: string }> {
    try {
      const res: any = await invoke('set_current_schema', { connId, name });
      return { success: !!res.success, schema: res.schema, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async createDatabase(connId: string, payload: { name: string; encoding?: string; collation?: string }): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('create_database', { connId, payload });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async dropDatabase(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_database', { name });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async renameDatabase(connId: string, oldName: string, newName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('rename_database', { connId, oldName, newName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getDbCharsets(): Promise<{ success: boolean; encodings: string[]; collations?: string[]; collationsByEncoding?: Record<string, string[]>; error?: string }> {
    try {
      const res: any = await invoke('get_db_charsets');
      return {
        success: !!res.success,
        encodings: res.encodings || [],
        collations: res.collations,
        collationsByEncoding: res.collationsByEncoding,
        error: res.message,
      };
    } catch (err: any) {
      return { success: false, encodings: [], error: err.toString() };
    }
  },

  // See the note on dropTable: restartIdentity/disableFk are handled by the backend on one connection.
  async truncateTable(connId: string, 
    name: string,
    opts?: { restartIdentity?: boolean; disableFk?: boolean; cascade?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('truncate_table', {
        connId,
        name,
        restartIdentity: opts?.restartIdentity ?? false,
        disableFk: opts?.disableFk ?? false,
        cascade: opts?.cascade ?? false,
      });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getTableDefinition(connId: string, name: string): Promise<{ success: boolean; sql?: string; error?: string }> {
    try {
      const res: any = await invoke('get_table_definition', { connId, name });
      return { success: !!res.success, sql: res.sql, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async createTable(
    tableName: string,
    columns?: any[],
    indexes?: any[],
    foreignKeys?: any[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('create_table', {
        payload: { tableName, columns, indexes, foreignKeys },
      });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // onProgress: receives {type:'start'|'progress'|'done', done, total}, which the backend sends over
  // the Channel every ~20 statements, so the UI can draw a real progress bar instead of an
  // indeterminate one.
  async restoreBackup(
    sqlContent: string,
    tables: string[],
    onProgress?: (msg: { type: string; done?: number; total?: number; statementsCount?: number }) => void,
    /** Skip a failing statement and carry on instead of rolling everything back (see `restore_backup`). */
    continueOnError?: boolean,
    /** The target connection, explicitly — the same reason as `generateData`: a background job can sit in the queue. */
    connId?: string,
  ): Promise<{
    success: boolean;
    statementsCount?: number;
    activeDatabase?: string;
    error?: string;
    failedCount?: number;
    failedSamples?: { sql: string; error: string }[];
  }> {
    try {
      // Always create the channel: Rust's onProgress parameter is a required Channel (Channel does
      // not implement Deserialize, so Option<Channel> is not available). With no callback, the
      // messages are simply dropped.
      const channel = new Channel<any>();
      if (onProgress) channel.onmessage = onProgress;
      const res: any = await invoke('restore_backup', withConnId({
        sqlContent,
        tables,
        onProgress: channel,
        continueOnError: !!continueOnError,
      }, connId));
      return {
        success: !!res.success,
        statementsCount: res.statementsCount,
        activeDatabase: res.activeDatabase,
        error: res.message,
        failedCount: res.failedCount || 0,
        failedSamples: res.failedSamples || [],
      };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async importTableData(connId: string, name: string, rows: any[]): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('import_table_data', { connId, name, rows });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getDatabasesList(config: DbConnectionConfig): Promise<{ success: boolean; databases: string[]; error?: string }> {
    try {
      const mappedConfig = {
        dbType: config.type,
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database || '',
        sslEnabled: config.sslEnabled,
        sslMode: config.sslMode,
        sslKeyPath: config.sslKeyPath,
        sslCertPath: config.sslCertPath,
        sslCaPath: config.sslCaPath,
        useSsh: config.sshEnabled,
        sshHost: config.sshHost,
        sshPort: config.sshPort,
        sshUser: config.sshUser,
        sshAuthType: config.sshAuthType,
        sshPassword: config.sshPassword,
        sshKeyPath: config.sshKeyPath,
        sshKeyContent: config.sshKeyContent,
        sshPassphrase: config.sshPassphrase,
      };
      const res: any = await invoke('get_databases_list', { config: mappedConfig });
      return { success: !!res.success, databases: res.databases || [], error: res.message };
    } catch (err: any) {
      return { success: false, databases: [], error: err.toString() };
    }
  },

  async openUrl(url: string): Promise<void> {
    try {
      await invoke('open_url', { url });
    } catch (err) {
      console.error('Failed to open url:', err);
    }
  },

  // ---- Redis ----
  async redisDisconnect(connId?: string): Promise<void> {
    const target = connId ?? currentConnId;
    try { await invoke('redis_disconnect', { connId: target }); } catch { /* skip */ }
    forgetConnection(target);
    if (target === currentConnId) currentConnId = '';
  },

  /**
   * Changing the db index means **opening or switching to another connection**, not mutating the
   * current one's state (`redis-ui-unification-plan.md` §2.1). Returns that db's `connId` — already
   * open and it hands back the same id. The caller must move the workspace onto this id; keeping the
   * old one means still reading the old db.
   */
  async redisSelectDb(
    index: number,
  ): Promise<{ success: boolean; dbIndex?: number; connId?: string; error?: string }> {
    try {
      const res: any = await invoke('redis_select_db', { index });
      return { success: !!res.success, dbIndex: res.dbIndex, connId: res.connId };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisScanKeys(
    pattern: string,
    cursor: number,
    count: number,
    typeFilter?: string
  ): Promise<{ success: boolean; cursor: number; keys: RedisKeyItem[]; error?: string }> {
    try {
      const res: any = await invoke('redis_scan_keys', { pattern, cursor, count, typeFilter: typeFilter || null });
      return { success: !!res.success, cursor: res.cursor ?? 0, keys: res.keys || [] };
    } catch (err: any) {
      return { success: false, cursor: 0, keys: [], error: err.toString() };
    }
  },

  // Streams the key list, receiving batches over a Channel.
  // Messages: {type:'keys',keys[],cursor} | {type:'done',total,cancelled} | {type:'error',message}.
  // `cursor` rides along with every batch so the UI can stop at its cap and resume from exactly the
  // right place (startCursor). Stop it with cancelQuery(queryId).
  async redisScanStream(
    pattern: string,
    count: number,
    queryId: string,
    onMessage: (msg: any) => void,
    startCursor?: number
  ): Promise<void> {
    const channel = new Channel<any>();
    channel.onmessage = onMessage;
    await invoke('redis_scan_stream', { pattern, count, queryId, channel, startCursor: startCursor ?? null });
  },

  async redisGetKey(key: string): Promise<RedisValueDetail> {
    try {
      const res: any = await invoke('redis_get_key', { key });
      return res as RedisValueDetail;
    } catch (err: any) {
      return { success: false, key, type: '', ttl: -1, memory: null, value: null, message: err.toString() };
    }
  },

  async redisSetKey(payload: any): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_set_key', { payload });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Editing one element of a collection at a time. Kept apart from redisSetKey, whose semantics are
  // REPLACE (DEL then rebuild, losing the TTL and rewriting every element) — each function below
  // maps to exactly one Redis command.
  // oldField/oldMember: renaming the "identity" part of an element (write the new one, then delete
  // the old).
  async redisHashSet(key: string, field: string, value: string, oldField?: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_hash_set', { key, field, value, oldField: oldField ?? null });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisHashDel(key: string, field: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_hash_del', { key, field });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisListSet(key: string, index: number, value: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_list_set', { key, index, value });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisListPush(key: string, value: string, atHead = false): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_list_push', { key, value, atHead });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisListDel(key: string, index: number): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_list_del', { key, index });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisSetMember(key: string, member: string, oldMember?: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_set_member', { key, member, oldMember: oldMember ?? null });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisSetDelMember(key: string, member: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_set_del_member', { key, member });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisZsetAdd(key: string, member: string, score: number, oldMember?: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_zset_add', { key, member, score, oldMember: oldMember ?? null });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisZsetDel(key: string, member: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_zset_del', { key, member });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // An empty id means '*' (the server generates the next id itself).
  async redisStreamAdd(
    key: string,
    id: string,
    fields: { field: string; value: string }[]
  ): Promise<RedisEditResult & { id?: string }> {
    try {
      const res: any = await invoke('redis_stream_add', { key, id, fields });
      return { success: !!res.success, id: res.id };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisStreamDel(key: string, id: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_stream_del', { key, id });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisDeleteKeys(keys: string[]): Promise<{ success: boolean; deleted?: number; error?: string }> {
    try {
      const res: any = await invoke('redis_delete_keys', { keys });
      return { success: !!res.success, deleted: res.deleted };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisSetTtl(key: string, ttl: number): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_set_ttl', { key, ttl });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisRenameKey(oldKey: string, newKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_rename_key', { oldKey, newKey });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisFlushDb(): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_flush_db');
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisInfo(): Promise<{ success: boolean; info?: any; raw?: string; error?: string }> {
    try {
      const res: any = await invoke('redis_info');
      return { success: !!res.success, info: res.info, raw: res.raw };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // `switchDb` is set when the command was a `SELECT n`. The backend does **not** move this
  // connection to that database — one `conn_id` is one db index (§2.1) — it resolves the
  // connection FOR that index and reports it. The caller must switch the workspace to
  // `switchDb.connId`; ignoring it leaves the console showing a db it is not talking to.
  // `selectedDb` is kept alongside for the console's own status line.
  async redisExecuteCmd(command: string): Promise<{
    success: boolean;
    result?: any;
    selectedDb?: number;
    switchDb?: { dbIndex: number; connId: string };
    error?: string;
  }> {
    try {
      const res: any = await invoke('redis_execute_cmd', { command });
      return {
        success: !!res.success,
        result: res.result,
        selectedDb: res.selectedDb,
        switchDb: res.switchDb ?? undefined,
        error: res.message,
      };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Mirrors the app's read-only toggle into the backend, which is where writes are refused.
   *
   * Since Phase 0 this flag **is** the connection's read-only flag in the registry — the same flag
   * the production label and the rail button write. Callers must pass the OR of those two sources,
   * not the global switch alone: writing `false` when the switch goes off would also clear the
   * read-only flag of a production connection.
   */
  async redisSetReadOnly(flag: boolean, connId?: string): Promise<void> {
    try {
      await invoke('redis_set_read_only', { flag, connId: connId ?? currentConnId });
    } catch { /* skip */ }
  },

  async redisGetElements(
    key: string,
    kind: string,
    cursor: string,
    count?: number,
    filter?: string
  ): Promise<RedisElementsPage> {
    try {
      const res: any = await invoke('redis_get_elements', {
        key, kind, cursor, count: count ?? null, filter: filter || null,
      });
      return {
        success: !!res.success,
        kind: res.kind ?? kind,
        elements: res.elements || [],
        nextCursor: res.nextCursor ?? '',
        done: !!res.done,
      };
    } catch (err: any) {
      return { success: false, kind, elements: [], nextCursor: cursor, done: true, error: err.toString() };
    }
  },

  // Delete by pattern: {type:'progress',scanned,deleted} | {type:'done',...} | {type:'error',message}.
  // Stop it with cancelQuery(queryId).
  async redisDeleteByPattern(
    pattern: string,
    typeFilter: string | undefined,
    queryId: string,
    onMessage: (msg: any) => void
  ): Promise<void> {
    const channel = new Channel<any>();
    channel.onmessage = onMessage;
    await invoke('redis_delete_by_pattern', {
      pattern, typeFilter: typeFilter || null, queryId, channel,
    });
  },

  async redisSlowlogGet(count?: number): Promise<{
    success: boolean;
    entries: RedisSlowLogEntry[];
    len: number;
    thresholdUs?: string | null;
    maxLen?: string | null;
    error?: string;
  }> {
    try {
      const res: any = await invoke('redis_slowlog_get', { count: count ?? null });
      return {
        success: !!res.success,
        entries: res.entries || [],
        len: res.len ?? 0,
        thresholdUs: res.thresholdUs,
        maxLen: res.maxLen,
      };
    } catch (err: any) {
      return { success: false, entries: [], len: 0, error: err.toString() };
    }
  },

  async redisSlowlogReset(): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_slowlog_reset');
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisSlowlogConfig(
    thresholdUs?: number,
    maxLen?: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_slowlog_config', {
        thresholdUs: thresholdUs ?? null, maxLen: maxLen ?? null,
      });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Pub/Sub on a DEDICATED connection in Rust: {type:'message',channel,pattern,payload,binary} | {type:'stopped',total}.
  async redisPubsubStart(
    channels: string[],
    patterns: string[],
    queryId: string,
    onMessage: (msg: any) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const channel = new Channel<any>();
      channel.onmessage = onMessage;
      await invoke('redis_pubsub_start', { channels, patterns, queryId, channel });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisPublish(
    channelName: string,
    payload: string
  ): Promise<{ success: boolean; receivers?: number; error?: string }> {
    try {
      const res: any = await invoke('redis_publish', { channelName, payload });
      return { success: !!res.success, receivers: res.receivers };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Profiler (MONITOR) — stops itself at the backend's limit: {type:'line',line} | {type:'stopped',reason,total}.
  async redisMonitorStart(
    queryId: string,
    onMessage: (msg: any) => void
  ): Promise<{ success: boolean; maxLines?: number; maxSecs?: number; error?: string }> {
    try {
      const channel = new Channel<any>();
      channel.onmessage = onMessage;
      const res: any = await invoke('redis_monitor_start', { queryId, channel });
      return { success: true, maxLines: res?.maxLines, maxSecs: res?.maxSecs };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisJsonGet(
    key: string,
    path?: string
  ): Promise<{ success: boolean; path?: string; json?: string | null; error?: string }> {
    try {
      const res: any = await invoke('redis_json_get', { key, path: path || null });
      return { success: !!res.success, path: res.path, json: res.json };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisJsonSet(key: string, path: string, value: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_json_set', { key, path, value });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisJsonDel(key: string, path: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_json_del', { key, path });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  /** Writes a string value from raw bytes — the only way to edit a binary value (the HEX editor). */
  async redisSetKeyBytes(key: string, bytes: number[]): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_set_key_bytes', { key, bytes });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisStreamGroups(key: string): Promise<{ success: boolean; groups: any[]; error?: string }> {
    try {
      const res: any = await invoke('redis_stream_groups', { key });
      return { success: !!res.success, groups: res.groups || [] };
    } catch (err: any) {
      return { success: false, groups: [], error: err.toString() };
    }
  },

  async redisStreamConsumers(
    key: string,
    group: string
  ): Promise<{ success: boolean; consumers: any[]; error?: string }> {
    try {
      const res: any = await invoke('redis_stream_consumers', { key, group });
      return { success: !!res.success, consumers: res.consumers || [] };
    } catch (err: any) {
      return { success: false, consumers: [], error: err.toString() };
    }
  },

  async redisStreamPending(
    key: string,
    group: string,
    count?: number
  ): Promise<{ success: boolean; pending: any[]; error?: string }> {
    try {
      const res: any = await invoke('redis_stream_pending', { key, group, count: count ?? null });
      return { success: !!res.success, pending: res.pending || [] };
    } catch (err: any) {
      return { success: false, pending: [], error: err.toString() };
    }
  },

  async redisStreamAck(key: string, group: string, ids: string[]): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_stream_ack', { key, group, ids });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisStreamClaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    ids: string[]
  ): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_stream_claim', { key, group, consumer, minIdleMs, ids });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Analyses the DB by sampling ≤10k keys. Progress over a Channel; cancel with cancelQuery(queryId).
  async redisAnalyzeDb(
    sample: number | undefined,
    queryId: string,
    onMessage: (msg: any) => void
  ): Promise<RedisAnalysis> {
    try {
      const channel = new Channel<any>();
      channel.onmessage = onMessage;
      const res: any = await invoke('redis_analyze_db', { sample: sample ?? null, queryId, channel });
      return res as RedisAnalysis;
    } catch (err: any) {
      return {
        success: false,
        dbsize: 0,
        sampled: 0,
        sampledBytes: 0,
        estimatedBytes: null,
        byType: [],
        byNamespace: [],
        ttlBuckets: { noExpiry: 0, under1h: 0, under1d: 0, under7d: 0, over7d: 0 },
        topKeys: [],
        error: err.toString(),
      };
    }
  },

  // ---- Keyspace export / import (see `utils/redisTransfer.ts`) ----
  //
  // These two methods are `RedisExportReader.dump` and `RedisImportWriter.restore` —
  // `redisTransfer` takes them as parameters, which is what keeps it free of `@tauri-apps/api` and
  // testable. They do NOT take a `connId`: like every other redis_* command, the local `invoke` has
  // already merged `currentConnId` in.

  /** DUMP + PTTL + TYPE for a batch of keys. `payload` is base64. */
  async redisDumpKeys(keys: string[]): Promise<{
    success: boolean;
    entries: { key: string; type: string; ttlMs: number; payload: string }[];
    missing: string[];
    error?: string;
  }> {
    try {
      const res: any = await invoke('redis_dump_keys', { keys });
      return { success: !!res.success, entries: res.entries || [], missing: res.missing || [] };
    } catch (err: any) {
      return { success: false, entries: [], missing: [], error: err.toString() };
    }
  },

  /**
   * RESTOREs a batch of records. `failed[].error` is Redis's own wording (English, e.g. "DUMP
   * payload version or checksum are wrong") and so does not go through `backendErrors.ts` — showing
   * it verbatim is right: it is the server's diagnosis, not a sentence this app wrote.
   */
  async redisRestoreKeys(
    entries: { key: string; type: string; ttlMs: number; payload: string }[],
    replace: boolean,
  ): Promise<{
    success: boolean;
    restored: number;
    skipped: number;
    failed: { key: string; error: string }[];
    error?: string;
  }> {
    try {
      const res: any = await invoke('redis_restore_keys', { entries, replace });
      return {
        success: !!res.success,
        restored: res.restored ?? 0,
        skipped: res.skipped ?? 0,
        failed: res.failed || [],
      };
    } catch (err: any) {
      return { success: false, restored: 0, skipped: 0, failed: [], error: err.toString() };
    }
  },

  // Explicit connId (§4.1): the statistics modal receives its connection as a prop, so it
  // has to ask about that one — not whichever is active — or the figures belong to another tab.
  async getDatabaseStats(connId: string): Promise<{ success: boolean; stats?: DatabaseStats; error?: string }> {
    try {
      const res: any = await invoke('get_database_stats', { connId });
      return { success: true, stats: res };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Everything the Properties tab shows, in one round trip.
   *
   * `schema` is `TableItem.schema`: only the Temporary section has one, and only on Postgres.
   * The error is returned rather than thrown because the panel renders it inline — a table dropped
   * in another tab is an ordinary outcome here, not an exception.
   */
  async getTableProperties(
    connId: string,
    tableName: string,
    schema?: string | null
  ): Promise<{ success: boolean; properties?: TableProperties; error?: string }> {
    try {
      const res: any = await invoke('get_table_properties', { connId, tableName, schema: schema || null });
      return { success: true, properties: res as TableProperties };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getExactTableRowCount(
    connId: string,
    tableName: string
  ): Promise<{ success: boolean; exact_rows?: number; error?: string }> {
    try {
      const res: any = await invoke('get_exact_table_row_count', { connId, tableName });
      return { success: true, exact_rows: res.exact_rows };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Phase 1: only what the data dictionary gives (names, charset, cheap sizes), so it comes
  // back almost instantly. Whatever sizes/row counts are missing arrive via phase 2 below.
  async getAllDatabasesStats(connId: string): Promise<{ success: boolean; stats?: AllDatabasesStats; error?: string }> {
    try {
      const res: any = await invoke('get_all_databases_stats', { connId });
      return { success: true, stats: res };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Phase 2: the expensive part (MySQL opens every table for DATA_LENGTH/TABLE_ROWS, SQLite
  // has to COUNT(*) each table, Postgres has to connect to each database). Called after
  // phase 1 and merged into it, so the list never waits on this.
  async getAllDatabasesSizes(
    connId: string,
    includeSystem = false
  ): Promise<{ success: boolean; items?: AllDatabasesSizeItem[]; error?: string }> {
    try {
      const res: any = await invoke('get_all_databases_sizes', { connId, includeSystem });
      return { success: true, items: res.databases };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // ---- Comparing two databases (db_compare.rs) ----
  // Each "side" needs only a database name / SQLite file: the backend takes the connection config
  // (password, SSH tunnel and IAM token included) from the open connection itself, so the frontend
  // never has to hold or resend credentials.

  /** Compares two databases structurally. Returns a per-table diff plus a sync SQL script (source -> target). */
  async compareSchemas(
    source: CompareSide,
    target: CompareSide,
    includeDrops = false,
  ): Promise<SchemaCompareResult> {
    return translateWarnings(
      await invoke<SchemaCompareResult>('compare_schemas', { source, target, includeDrops }),
    );
  },

  /** Counts rows per table on both sides, to see which tables are worth comparing in detail. */
  async compareDataOverview(
    source: CompareSide,
    target: CompareSide,
    tables?: string[],
  ): Promise<DataOverviewResult> {
    return await invoke<DataOverviewResult>('compare_data_overview', { source, target, tables });
  },

  /** Compares ONE table's data by key. Leave `keyColumns` empty to use the source's primary key. */
  async compareTableData(
    source: CompareSide,
    target: CompareSide,
    table: string,
    opts?: { keyColumns?: string[]; limit?: number; maxDiffRows?: number; includeDrops?: boolean },
  ): Promise<DataCompareResult> {
    return translateWarnings(
      await invoke<DataCompareResult>('compare_table_data', {
        source,
        target,
        table,
        keyColumns: opts?.keyColumns,
        limit: opts?.limit,
        maxDiffRows: opts?.maxDiffRows,
        includeDrops: opts?.includeDrops ?? false,
      }),
    );
  },

  // ---- Test-data generation (data_generator.rs) ----
  // Every value is produced IN RUST, the preview included — so what the preview shows is exactly
  // what gets inserted.

  /** The tables/columns data can be generated for, a suggested generator per column, and an FK-safe insertion order. */
  async getGenerationTargets(): Promise<GenTargets> {
    return translateWarnings(await invoke<GenTargets>('get_generation_targets'));
  },

  /** Generates `limit` sample rows of ONE table without writing to the database. */
  async previewGeneratedData(spec: GenSpec, table: string, limit = 100): Promise<GenPreview> {
    return translateWarnings(
      await invoke<GenPreview>('preview_generated_data', { spec, table, limit }),
    );
  },

  /**
   * Generates and really inserts. `onProgress` receives {type:'start'|'table'|'progress'|'done'|'error', ...}.
   *
   * `connId` is explicit because this runs as a **background job**: a job can sit in the queue for a
   * while, and by the time its turn comes the ambient `currentConnId` may be another connection —
   * which would mean generating data into exactly the database the user did not pick. Left out, it
   * still falls back to the ambient one as before.
   */
  async generateData(
    spec: GenSpec,
    onProgress?: (msg: GenProgress) => void,
    connId?: string,
  ): Promise<GenResult> {
    // Always create the channel: Rust's onProgress parameter is a required Channel (Channel does
    // not implement Deserialize, so Option<Channel> is not available). With no callback, the
    // messages are simply dropped.
    const channel = new Channel<GenProgress>();
    if (onProgress) channel.onmessage = onProgress;
    return translateWarnings(
      await invoke<GenResult>('generate_data', withConnId({ spec, onProgress: channel }, connId)),
    );
  },

  /** Marks a running data generation as needing to stop. Not an error when nothing is running. */
  async cancelDataGeneration(connId?: string): Promise<void> {
    try {
      // Rust keys the cancel flag by `conn_id`, so a cancel has to name the connection doing the generating.
      await invoke('cancel_data_generation', withConnId({}, connId));
    } catch {
      // Cancelling is "best effort": an error here leaves the user nothing to act on.
    }
  },

  /** Fetches active database connections, processlist and lock activity. */
  async getProcessList(connId?: string): Promise<ProcessListSummary> {
    return await invoke<ProcessListSummary>('get_process_list', withConnId({}, connId));
  },

  /** Cancels a currently running query on a connection session without disconnecting. */
  async killProcessQuery(processId: string, connId?: string): Promise<KillResult> {
    return await invoke<KillResult>('kill_process_query', withConnId({ processId }, connId));
  },

  /** Terminates an entire connection session. */
  async killProcessConnection(processId: string, connId?: string): Promise<KillResult> {
    return await invoke<KillResult>('kill_process_connection', withConnId({ processId }, connId));
  },
};

export interface TableStatItem {
  table_name: string;
  schema?: string | null;
  kind?: string | null;
  charset?: string | null;
  rows: number;
  is_exact: boolean;
  data_size_bytes: number | null;
  index_size_bytes: number | null;
  total_size_bytes: number | null;
  engine: string;
  collation: string | null;
  comment?: string | null;
}

export interface DatabaseStats {
  db_name: string;
  db_type: string;
  total_size_bytes: number;
  total_tables: number;
  total_rows: number;
  tables: TableStatItem[];
}

export interface AllDatabasesStatsItem {
  db_name: string;
  /** SQLite only: the schema name (`main`, or whatever was ATTACHed). */
  schema_name: string | null;
  is_system: boolean;
  is_current: boolean;
  /** null = no figure yet (Postgres before a deep scan, or a database that errored). */
  total_tables: number | null;
  total_rows: number | null;
  data_size_bytes: number | null;
  index_size_bytes: number | null;
  total_size_bytes: number | null;
  charset: string | null;
  collation: string | null;
  error: string | null;
}

/**
 * One row of phase 2 (`getAllDatabasesSizes`). Only the fields the backend actually measured
 * carry a value, the rest are `null` so merging cannot erase phase 1's numbers. Rows match on
 * `schema_name` first, then `db_name` (SQLite can only be matched by schema).
 */
export interface AllDatabasesSizeItem {
  db_name: string | null;
  schema_name: string | null;
  total_tables: number | null;
  total_rows: number | null;
  data_size_bytes: number | null;
  index_size_bytes: number | null;
  total_size_bytes: number | null;
  error: string | null;
}

export interface AllDatabasesStats {
  db_type: string;
  current_db: string;
  /** Whether phase 2 (`getAllDatabasesSizes`) still has numbers to add. */
  metrics_pending: boolean;
  /**
   * Whether phase 2 can start on its own. Counting tables/rows of another Postgres database
   * needs a NEW connection to it, so there it waits for the user's "deep scan"; on
   * MySQL/SQLite it runs in the background right away.
   */
  metrics_manual: boolean;
  rows_are_exact: boolean;
  databases: AllDatabasesStatsItem[];
}
