// Judges the indexes `get_index_facts` reports (stats/index_usage.rs): which are never used, which
// duplicate another, which are covered by a longer one. Pure and tested — a wrong "redundant" on a
// production database is an index someone needed, dropped on this tool's advice, so every rule here
// errs towards NOT flagging:
//
//  - only B-tree indexes are compared (a hash/GIN/GiST index answers other questions than a btree on
//    the same columns), and only two indexes with the same predicate (a partial index is never
//    "covered" by a full one, nor the other way round);
//  - "the same columns" includes each column's flavor — operator class, DESC, collation, a MySQL
//    prefix length — so `name text_pattern_ops` is not a duplicate of `name`;
//  - a UNIQUE index is never redundant: `(a)` UNIQUE enforces something `(a, b)` does not;
//  - "unused" needs counters the server actually keeps (`usageAvailable`), and is never said of a
//    primary key, a unique index or an index backing a constraint;
//  - nothing is dropped from here: a finding carries the DROP statement for the user to read and
//    run themselves.

export type IndexDialect = 'postgres' | 'mysql' | 'sqlite';

export interface IndexFact {
  table: string;
  name: string;
  /** Key columns (or expressions) in order, as the server prints them. */
  columns: string[];
  /** Per column: what besides the column makes the key different (opclass/order/collation/prefix). */
  flavors: string[];
  unique: boolean;
  primary: boolean;
  /** Backs a constraint (PRIMARY/UNIQUE/EXCLUDE): dropped with the constraint, not as an index. */
  constraint: boolean;
  method: string;
  predicate: string | null;
  valid: boolean;
  sizeBytes: number | null;
  /** Times the index was used since the counters started; null when the server keeps none. */
  scans: number | null;
}

export interface IndexFacts {
  dialect: IndexDialect;
  schema: string | null;
  indexes: IndexFact[];
  foreignKeys: { table: string; columns: string[] }[];
  usageAvailable: boolean;
  sizesAvailable: boolean;
  statsReset: string | null;
  serverStarted: string | null;
}

export type IndexIssue = 'invalid' | 'duplicate' | 'redundant' | 'unused';

export interface IndexFinding {
  table: string;
  index: string;
  columns: string[];
  issues: IndexIssue[];
  /** `duplicate`: the identical index that is kept. */
  duplicateOf?: string;
  /** `redundant`: the longer index whose leading columns are this one's. */
  coveredBy?: string;
  sizeBytes: number | null;
  scans: number | null;
  /** The only index a foreign key can use: MySQL refuses the DROP, Postgres gets slow cascades. */
  backsForeignKey: boolean;
  /** The statement to drop it, or null when it cannot be dropped as an index (MySQL FK support). */
  dropSql: string | null;
}

export interface IndexReport {
  findings: IndexFinding[];
  /** Bytes the droppable findings occupy (null when the server reports no sizes). */
  reclaimableBytes: number | null;
  totalIndexes: number;
}

/** `"Weird Name"` → `Weird Name`, `name` → `name` — so an FK's attname compares with indexdef output. */
export function unquoteIdent(s: string): string {
  const m = /^"((?:[^"]|"")*)"$/.exec(s.trim()) ?? /^`((?:[^`]|``)*)`$/.exec(s.trim());
  return m ? m[1].replace(/""/g, '"').replace(/``/g, '`') : s.trim();
}

const isBtree = (ix: IndexFact) => ix.method.toLowerCase() === 'btree';

function sameKeyPrefix(a: IndexFact, b: IndexFact, n: number): boolean {
  for (let i = 0; i < n; i++) {
    if (a.columns[i] !== b.columns[i]) return false;
    if ((a.flavors[i] ?? '') !== (b.flavors[i] ?? '')) return false;
  }
  return true;
}

function fullKey(ix: IndexFact): string {
  return [ix.method.toLowerCase(), ix.predicate ?? '', ix.columns.join('\u001f'), ix.flavors.join('\u001f')].join('\u0000');
}

/** Which of two identical indexes to keep: the one the schema depends on, then the busier one. */
function keepRank(ix: IndexFact): number[] {
  return [ix.primary ? 0 : 1, ix.constraint ? 0 : 1, ix.unique ? 0 : 1, -(ix.scans ?? 0)];
}

function compareRank(a: IndexFact, b: IndexFact): number {
  const ra = keepRank(a);
  const rb = keepRank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return a.name.localeCompare(b.name);
}

function quote(dialect: IndexDialect, name: string): string {
  return dialect === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"';
}

export function dropIndexSql(dialect: IndexDialect, ix: Pick<IndexFact, 'table' | 'name'>, schema: string | null): string {
  if (dialect === 'mysql') return `DROP INDEX ${quote(dialect, ix.name)} ON ${quote(dialect, ix.table)};`;
  if (dialect === 'postgres') {
    const target = schema ? `${quote(dialect, schema)}.${quote(dialect, ix.name)}` : quote(dialect, ix.name);
    return `DROP INDEX ${target};`;
  }
  return `DROP INDEX ${quote(dialect, ix.name)};`;
}

export function analyzeIndexes(facts: IndexFacts): IndexReport {
  const byTable = new Map<string, IndexFact[]>();
  for (const ix of facts.indexes) {
    const list = byTable.get(ix.table) ?? [];
    list.push(ix);
    byTable.set(ix.table, list);
  }
  const findings = new Map<IndexFact, IndexFinding>();
  const finding = (ix: IndexFact): IndexFinding => {
    let f = findings.get(ix);
    if (!f) {
      f = {
        table: ix.table, index: ix.name, columns: ix.columns, issues: [],
        sizeBytes: ix.sizeBytes, scans: ix.scans, backsForeignKey: false, dropSql: null,
      };
      findings.set(ix, f);
    }
    return f;
  };
  const droppable = (ix: IndexFact) => !ix.primary && !ix.constraint;

  for (const list of byTable.values()) {
    // 1. Identical keys.
    const groups = new Map<string, IndexFact[]>();
    for (const ix of list) {
      const k = fullKey(ix);
      groups.set(k, [...(groups.get(k) ?? []), ix]);
    }
    const dropped = new Set<IndexFact>();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const [keep, ...rest] = [...g].sort(compareRank);
      for (const ix of rest) {
        if (!droppable(ix)) continue;
        const f = finding(ix);
        f.issues.push('duplicate');
        f.duplicateOf = keep.name;
        dropped.add(ix);
      }
    }

    // 2. A leading-column prefix of a longer btree index with the same predicate.
    for (const a of list) {
      if (dropped.has(a) || !isBtree(a) || a.unique || !droppable(a) || a.predicate) continue;
      const cover = list
        .filter((b) => b !== a && !dropped.has(b) && isBtree(b) && !b.predicate && b.columns.length > a.columns.length && sameKeyPrefix(a, b, a.columns.length))
        .sort(compareRank)[0];
      if (cover) {
        const f = finding(a);
        f.issues.push('redundant');
        f.coveredBy = cover.name;
        dropped.add(a);
        // `a` may be the kept copy of a duplicate group. Its duplicates then go for the same reason:
        // saying "same key as a" about an index whose twin is being dropped too would send the user
        // looking for an index that is not there after the script runs.
        for (const [other, of] of findings) {
          if (other.table === a.table && of.duplicateOf === a.name) {
            of.issues = of.issues.map((k) => (k === 'duplicate' ? 'redundant' : k));
            of.coveredBy = cover.name;
            delete of.duplicateOf;
          }
        }
      }
    }

    // 3. Never used (only where the server keeps counters).
    if (facts.usageAvailable) {
      for (const ix of list) {
        if (ix.scans === 0 && !ix.primary && !ix.unique && !ix.constraint) finding(ix).issues.push('unused');
      }
    }

    // 4. A failed CREATE INDEX CONCURRENTLY leaves an invalid index that costs writes and serves nothing.
    for (const ix of list) if (!ix.valid) finding(ix).issues.unshift('invalid');
  }

  // Foreign keys: an index supports an FK when the FK's columns are its leading columns. When EVERY
  // supporting index has a finding, dropping them all would leave the FK with none — so the one to
  // keep is marked: preferably one flagged only as unused (a covered or duplicate index is, by
  // definition, not the best of the set), then the strongest by keepRank. The others stay safe to
  // drop as long as that one stays, which is exactly what their "covered by" already says.
  for (const fk of facts.foreignKeys) {
    const fkCols = fk.columns.map(unquoteIdent);
    const supporters = (byTable.get(fk.table) ?? []).filter(
      (o) => fkCols.length <= o.columns.length && fkCols.every((c, i) => unquoteIdent(o.columns[i]) === c),
    );
    if (!supporters.length || supporters.some((o) => !findings.has(o))) continue;
    const derivative = (o: IndexFact) => findings.get(o)!.issues.some((k) => k === 'redundant' || k === 'duplicate');
    const keep = [...supporters].sort((a, b) => Number(derivative(a)) - Number(derivative(b)) || compareRank(a, b))[0];
    findings.get(keep)!.backsForeignKey = true;
  }
  for (const [ix, f] of findings) {
    const canDrop = droppable(ix) && !(facts.dialect === 'mysql' && f.backsForeignKey);
    f.dropSql = canDrop ? dropIndexSql(facts.dialect, ix, facts.schema) : null;
  }

  const list = [...findings.values()].sort(
    (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.table.localeCompare(b.table) || a.index.localeCompare(b.index),
  );
  const reclaimableBytes = facts.sizesAvailable
    ? list.filter((f) => f.dropSql).reduce((n, f) => n + (f.sizeBytes ?? 0), 0)
    : null;
  return { findings: list, reclaimableBytes, totalIndexes: facts.indexes.length };
}
