/**
 * Generates a SQLite database with a few hundred foreign-key-connected tables, for testing the
 * ER diagram at a size no real sample database here reaches.
 *
 * Usage:  node scripts/make-er-mock-db.mjs [tables] [outfile]
 *         node scripts/make-er-mock-db.mjs 320 demo-er-320.db
 *
 * Uses node:sqlite (Node 22+), so it needs no dependency and no sqlite3 CLI.
 *
 * The shape matters as much as the count. A flat list of 320 unrelated tables would produce an
 * ER diagram with no connectors and therefore no layout work and no line rendering — the two
 * things worth measuring. So tables are laid out in ~12 modules (`billing_*`, `crm_*`, …) with
 * FKs mostly INSIDE a module and a few crossing between them, which is what a real schema of
 * this size looks like and what makes the hierarchical layout produce deep layer chains.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync } from 'node:fs';

const TABLE_COUNT = Number(process.argv[2] || 320);
const OUT = process.argv[3] || `demo-er-${TABLE_COUNT}.db`;

/** Deterministic PRNG so two runs produce the same schema — a perf comparison needs that. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
const rand = rng(20260908);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const MODULES = [
  'billing',
  'crm',
  'catalog',
  'inventory',
  'shipping',
  'auth',
  'audit',
  'support',
  'analytics',
  'payroll',
  'content',
  'geo',
];

const NOUNS = [
  'account', 'address', 'adjustment', 'agreement', 'alert', 'allocation', 'answer', 'approval',
  'article', 'asset', 'attachment', 'attribute', 'batch', 'bill', 'branch', 'bucket', 'campaign',
  'card', 'carrier', 'cart', 'category', 'channel', 'charge', 'claim', 'client', 'code', 'comment',
  'contact', 'contract', 'coupon', 'credit', 'currency', 'cycle', 'department', 'deposit',
  'discount', 'dispute', 'document', 'entry', 'event', 'fee', 'file', 'group', 'invoice', 'item',
  'job', 'label', 'ledger', 'level', 'license', 'line', 'location', 'lot', 'manifest', 'member',
  'message', 'method', 'metric', 'note', 'offer', 'order', 'package', 'payment', 'permission',
  'plan', 'policy', 'price', 'product', 'profile', 'project', 'quote', 'rate', 'reason', 'receipt',
  'record', 'refund', 'region', 'report', 'request', 'reservation', 'return', 'review', 'role',
  'route', 'rule', 'run', 'schedule', 'score', 'segment', 'session', 'setting', 'shipment', 'slot',
  'source', 'stage', 'status', 'step', 'stock', 'store', 'subscription', 'supplier', 'survey',
  'tag', 'task', 'tax', 'team', 'template', 'term', 'ticket', 'tier', 'token', 'transfer', 'unit',
  'user', 'vendor', 'version', 'visit', 'voucher', 'warehouse', 'window', 'zone',
];

const COLUMN_TYPES = [
  'TEXT',
  'TEXT',
  'INTEGER',
  'INTEGER',
  'REAL',
  'NUMERIC(12,2)',
  'VARCHAR(64)',
  'VARCHAR(255)',
  'BOOLEAN',
  'DATETIME',
  'DATE',
  'BLOB',
];

const PLAIN_COLUMNS = [
  'name', 'code', 'label', 'slug', 'title', 'description', 'notes', 'status', 'kind', 'external_ref',
  'amount', 'quantity', 'total', 'currency', 'rate', 'weight', 'position', 'priority', 'score',
  'is_active', 'is_default', 'is_locked', 'created_at', 'updated_at', 'deleted_at', 'starts_at',
  'ends_at', 'metadata', 'payload', 'checksum',
];

// ---------------------------------------------------------------------------------------------
// Build the table list: unique names, spread across modules.
// ---------------------------------------------------------------------------------------------
const tables = [];
const used = new Set();
let guard = 0;
while (tables.length < TABLE_COUNT && guard++ < TABLE_COUNT * 50) {
  const mod = MODULES[tables.length % MODULES.length];
  const parts = [pick(NOUNS)];
  if (rand() < 0.45) parts.push(pick(NOUNS));
  const name = `${mod}_${parts.join('_')}`;
  if (used.has(name)) continue;
  used.add(name);
  tables.push({ name, module: mod, index: tables.length });
}
if (tables.length < TABLE_COUNT) {
  throw new Error(`could only build ${tables.length} unique names; widen NOUNS`);
}

// ---------------------------------------------------------------------------------------------
// Foreign keys. Every reference points at an EARLIER table, which keeps the schema creatable in
// one pass without deferred constraints and gives the layout engine a real DAG to layer.
// ---------------------------------------------------------------------------------------------
const byModule = new Map();
for (const t of tables) {
  if (!byModule.has(t.module)) byModule.set(t.module, []);
  byModule.get(t.module).push(t);
}

let fkCount = 0;
for (const table of tables) {
  const siblings = byModule.get(table.module).filter((t) => t.index < table.index);
  const earlier = tables.filter((t) => t.index < table.index);
  if (earlier.length === 0) {
    table.fks = [];
    continue;
  }

  // A tail of tables gets no parent at all, so "hide isolated tables" has something to hide.
  const wanted = rand() < 0.08 ? 0 : between(1, 3);
  const fks = [];
  const taken = new Set();
  for (let i = 0; i < wanted; i++) {
    // 4 in 5 references stay inside the module; the rest cross, which is what makes the FK
    // graph interesting rather than twelve disconnected trees.
    const pool = siblings.length > 0 && rand() < 0.8 ? siblings : earlier;
    const parent = pick(pool);
    if (!parent || taken.has(parent.name)) continue;
    taken.add(parent.name);
    fks.push({ column: `${parent.name.replace(`${parent.module}_`, '')}_id`, parent: parent.name });
  }
  // Two FKs can reduce to the same column name (`order_id` from `crm_order` and `billing_order`).
  const seenCols = new Set();
  table.fks = fks.filter((fk) => !seenCols.has(fk.column) && seenCols.add(fk.column));
  fkCount += table.fks.length;
}

// ---------------------------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------------------------
if (existsSync(OUT)) unlinkSync(OUT);
const db = new DatabaseSync(OUT);
db.exec('PRAGMA journal_mode = MEMORY');
db.exec('BEGIN');

let columnCount = 0;
for (const table of tables) {
  const lines = [`  "${table.name}_id" INTEGER PRIMARY KEY AUTOINCREMENT`];
  for (const fk of table.fks) {
    lines.push(`  "${fk.column}" INTEGER REFERENCES "${fk.parent}"("${fk.parent}_id")`);
  }
  // Wide and narrow tables both matter: a 20-row card is 20 DOM rows at full detail.
  const extra = between(3, 16);
  const cols = new Set();
  for (let i = 0; i < extra; i++) {
    const col = pick(PLAIN_COLUMNS);
    if (cols.has(col)) continue;
    cols.add(col);
    const nullable = rand() < 0.4 ? ' NOT NULL' : '';
    lines.push(`  "${col}" ${pick(COLUMN_TYPES)}${nullable}`);
  }
  columnCount += lines.length;
  db.exec(`CREATE TABLE "${table.name}" (\n${lines.join(',\n')}\n)`);
}

// A handful of views, so "show views" and the view/table split have something to show.
const viewSources = tables.slice(0, 14);
for (const [i, table] of viewSources.entries()) {
  db.exec(`CREATE VIEW "v_${table.name}_summary" AS SELECT * FROM "${table.name}" LIMIT ${i + 1}`);
}

db.exec('COMMIT');
db.close();

const isolated = tables.filter((t) => t.fks.length === 0).length;
console.log(`wrote ${OUT}`);
console.log(`  tables      ${tables.length}`);
console.log(`  views       ${viewSources.length}`);
console.log(`  columns     ${columnCount} (avg ${(columnCount / tables.length).toFixed(1)}/table)`);
console.log(`  foreign keys ${fkCount}`);
console.log(`  tables with no parent ${isolated}`);
