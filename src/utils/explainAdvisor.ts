import type { ExplainFlag, ExplainNode, ExplainResult } from './explainHelper';
import { WARN_FLAGS } from './explainHelper';
import { resolveAliases, collectCteNames } from '../sql/statements';

/*
 * Two readings of a finished plan that the diagram does not do by itself: what changed since the
 * previous plan, and which index would take a full scan off the table. Pure — no React, no
 * monaco, no IPC — so both answers are pinned by tests (`explainAdvisor.test.ts`).
 *
 * The rule both halves follow is the inspection rule: silence beats a wrong answer. A comparison
 * that calls a regression an improvement, or an index suggestion on a column the query does not
 * filter by, teaches the user to ignore the panel. Whenever the plan does not say enough, the
 * answer is "nothing to report", never a guess.
 */

function flatten(node: ExplainNode | null): ExplainNode[] {
  if (!node) return [];
  return [node, ...(node.children || []).flatMap(flatten)];
}

// ---------------------------------------------------------------------------------------------
// Plan comparison
// ---------------------------------------------------------------------------------------------

/** How one table is read in one plan. */
export interface TableAccess {
  operator: string;
  index?: string;
  /** Rows examined per scan (the estimate, or the measurement when the plan has one). */
  rows?: number;
  selfCost?: number;
  flags: ExplainFlag[];
}

export type AccessVerdict = 'better' | 'worse' | 'same' | 'added' | 'removed';

export interface TableDiff {
  /** Display key: the table name, with `#2` for the second read of the same table (self-join). */
  table: string;
  before?: TableAccess;
  after?: TableAccess;
  verdict: AccessVerdict;
}

export interface PlanComparison {
  /** Byte-identical plan text: the change the user made did not reach the optimiser. */
  identical: boolean;
  costBefore?: number;
  costAfter?: number;
  /** (after − before) / before × 100; negative is an improvement. */
  costDeltaPct?: number;
  timeBefore?: number;
  timeAfter?: number;
  tables: TableDiff[];
  /** Warning kinds whose count differs between the two plans, worst first. */
  flags: { flag: ExplainFlag; before: number; after: number }[];
}

/** A change under this share is noise — cost models round, and statistics drift between runs. */
const SIGNIFICANT = 0.05;

// Worst to best. Used only when neither cost nor rows can decide.
function accessRank(a: TableAccess): number {
  if (a.flags.includes('fullTableScan')) return 0;
  if (!a.index) return 1;
  if (a.flags.includes('coveringIndex')) return 3;
  return 2;
}

function compareNumbers(before: number | undefined, after: number | undefined): AccessVerdict | null {
  if (before === undefined || after === undefined) return null;
  if (before === after) return 'same';
  const base = Math.max(Math.abs(before), Math.abs(after));
  if (base === 0 || Math.abs(after - before) / base < SIGNIFICANT) return 'same';
  return after < before ? 'better' : 'worse';
}

function judge(before: TableAccess, after: TableAccess): AccessVerdict {
  // Cost first: it is the number the optimiser itself ranks plans by.
  const byCost = compareNumbers(before.selfCost, after.selfCost);
  if (byCost && byCost !== 'same') return byCost;
  const byRows = compareNumbers(before.rows, after.rows);
  if (byRows && byRows !== 'same') return byRows;
  const rankDelta = accessRank(after) - accessRank(before);
  if (rankDelta > 0) return 'better';
  if (rankDelta < 0) return 'worse';
  return 'same';
}

function accessOf(node: ExplainNode): TableAccess {
  return {
    operator: node.type,
    index: node.indexName,
    rows: node.actualRows ?? node.rows,
    selfCost: node.selfCost,
    flags: node.flags || [],
  };
}

// Leaf-level reads keyed by table, in plan order. A table read twice (self-join, or once in a
// subquery and once outside) keeps both reads, as `film` and `film#2`.
function tableReads(root: ExplainNode | null): Map<string, TableAccess> {
  const out = new Map<string, TableAccess>();
  const seen = new Map<string, number>();
  for (const node of flatten(root)) {
    if (!node.table) continue;
    const base = node.table.toLowerCase();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? node.table : `${node.table}#${n}`, accessOf(node));
  }
  return out;
}

function flagCounts(root: ExplainNode | null): Map<ExplainFlag, number> {
  const counts = new Map<ExplainFlag, number>();
  for (const node of flatten(root)) {
    for (const flag of node.flags || []) counts.set(flag, (counts.get(flag) ?? 0) + 1);
  }
  return counts;
}

export function comparePlans(before: ExplainResult, after: ExplainResult): PlanComparison {
  const costBefore = before.totalCost;
  const costAfter = after.totalCost;
  const costDeltaPct = costBefore !== undefined && costAfter !== undefined && costBefore > 0
    ? ((costAfter - costBefore) / costBefore) * 100
    : undefined;

  const readsBefore = tableReads(before.rootNode);
  const readsAfter = tableReads(after.rootNode);
  const tables: TableDiff[] = [];
  for (const [table, b] of readsBefore) {
    const a = readsAfter.get(table);
    tables.push({ table, before: b, after: a, verdict: a ? judge(b, a) : 'removed' });
  }
  for (const [table, a] of readsAfter) {
    if (!readsBefore.has(table)) tables.push({ table, after: a, verdict: 'added' });
  }

  const fb = flagCounts(before.rootNode);
  const fa = flagCounts(after.rootNode);
  const flags = WARN_FLAGS
    .map(flag => ({ flag, before: fb.get(flag) ?? 0, after: fa.get(flag) ?? 0 }))
    .filter(f => f.before !== f.after);

  return {
    identical: before.rawText === after.rawText,
    costBefore,
    costAfter,
    costDeltaPct,
    timeBefore: before.executionTimeMs,
    timeAfter: after.executionTimeMs,
    tables,
    flags,
  };
}

// ---------------------------------------------------------------------------------------------
// Index suggestions
// ---------------------------------------------------------------------------------------------

/** Below this many rows per scan, a full scan is cheaper than any index lookup. */
export const SUGGEST_MIN_ROWS = 500;
/** Composite indexes past this width stop being a suggestion and become a design decision. */
const MAX_EQ_COLUMNS = 3;

export type PredicateKind = 'eq' | 'range' | 'join';

export interface IndexSuggestion {
  /** Real table name (aliases resolved through the statement). */
  table: string;
  /** The name the plan used, when it differs from `table`. */
  alias?: string;
  /** Equality and join columns first, then at most one range column — the order that lets every
   *  column of a composite index narrow the scan. */
  columns: { name: string; kind: PredicateKind }[];
  /** The scan this index would replace. */
  nodeId: string;
  rows: number;
  /** The predicates the columns came from, verbatim, so the reason can be shown and checked. */
  predicates: string[];
  sql: string;
}

interface Atom {
  qualifier?: string;
  column: string;
  kind: PredicateKind;
  text: string;
  /** For a join equality: the column on the other side, which may be the one this table owns. */
  other?: { qualifier?: string; column: string };
}

// One comparison whose left side is a bare (optionally qualified) column. Anything wrapped in a
// function — lower(col), year(col), col + 1 — is left out on purpose: an index on the column does
// not serve it, and suggesting one would be exactly the wrong answer this module exists to avoid.
// Qualifiers: `db`.`t`.`col`, "t"."col", t.col; a Postgres cast `(t.col)::text` is unwrapped.
const IDENT = String.raw`(?:\`[^\`]+\`|"[^"]+"|[A-Za-z_][\w$]*)`;
const REF = String.raw`(?:${IDENT}\s*\.\s*){0,2}${IDENT}`;
// Either `(ref)` — only as a whole, so `lower(ref)` never matches through its parenthesis — or a
// bare ref; both may carry a Postgres cast.
const COLUMN_REF = String.raw`(?:\(\s*(${REF})\s*\)|(${REF}))(?:::[\w ]+)?`;
const OPERATOR = String.raw`(=|<>|!=|<=|>=|<|>|\bin\s*\(|\bbetween\b|\blike\b|\bis\s+null\b)`;
const ATOM_RE = new RegExp(String.raw`(?<![\w.\`"])${COLUMN_REF}\s*${OPERATOR}\s*([^()\s][^)]*?|\([^)]*\))?(?=\s+and\b|\s+or\b|\)|$)`, 'gi');

const unquote = (s: string) => s.replace(/[`"]/g, '').trim();

function splitRef(ref: string): { qualifier?: string; column: string } {
  const parts = ref.split('.').map(unquote);
  const column = parts.pop()!;
  return { qualifier: parts.pop(), column };
}

const LITERAL_RE = /^(?:'(?:[^']|'')*'(?:::[\w ]+)?|-?\d+(?:\.\d+)?|true|false|null|\$\d+|\?)$/i;

function isColumnRef(text: string): boolean {
  return new RegExp(`^${COLUMN_REF}$`, 'i').test(text.trim()) && !LITERAL_RE.test(text.trim());
}

/**
 * The indexable comparisons in one predicate string. An OR anywhere drops the whole predicate:
 * `a = 1 OR b = 2` is served by neither index alone, and saying otherwise is a wrong answer.
 */
export function predicateAtoms(predicate: string): Atom[] {
  if (/\bor\b/i.test(predicate)) return [];
  const atoms: Atom[] = [];
  ATOM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATOM_RE.exec(predicate)) !== null) {
    const { qualifier, column } = splitRef(m[1] ?? m[2]);
    // Keywords the regex can land on when a predicate starts oddly.
    if (/^(and|or|not|null|true|false)$/i.test(column)) continue;
    const op = m[3].toLowerCase().replace(/\s+/g, ' ');
    const rhs = (m[4] || '').trim();
    let kind: PredicateKind;
    if (op === '=' && isColumnRef(rhs)) {
      kind = 'join';
    } else if (op === '=' || op.startsWith('in') || op.startsWith('is')) {
      kind = 'eq';
    } else if (op === 'like') {
      // Only a fixed prefix can walk an index; `'%abc'` cannot.
      if (!/^'[^%_]/.test(rhs)) continue;
      kind = 'range';
    } else if (op === '<>' || op === '!=') {
      continue;
    } else {
      kind = 'range';
    }
    atoms.push({ qualifier, column, kind, text: m[0].trim(), other: kind === 'join' ? splitRef(rhs) : undefined });
  }
  return atoms;
}

// Every place a plan puts a predicate, for one node.
function nodePredicates(node: ExplainNode): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) out.push(v); };
  add(node.filter);
  add(node.joinFilter);
  add(node.hashCond);
  add(node.details?.attached_condition);
  // MySQL tree / ANALYZE text: the predicate lives in the operator title.
  const titled = node.type.match(/^Filter:\s*(.+)$/i);
  if (titled) add(titled[1]);
  const joinCond = node.type.match(/join\s*\((.+)\)\s*$/i);
  if (joinCond && !/^no condition$/i.test(joinCond[1].trim())) add(joinCond[1]);
  return [...new Set(out)];
}

const isJoinNode = (node: ExplainNode) => /join|nested loop/i.test(node.type);

function quoteIdent(name: string, dbType: string): string {
  if (/mysql|maria/i.test(dbType)) return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

function indexSql(table: string, columns: string[], dbType: string): string {
  const name = `idx_${table}_${columns.join('_')}`.replace(/[^\w]/g, '_').slice(0, 60);
  const cols = columns.map(c => quoteIdent(c, dbType)).join(', ');
  return `CREATE INDEX ${quoteIdent(name, dbType)} ON ${quoteIdent(table, dbType)} (${cols});`;
}

/**
 * Index candidates for the full scans in a plan. A scan qualifies only when every one of these
 * holds, and each is there because leaving it out produced a wrong suggestion:
 * - it is a full scan (or reads with no index at all), not a range or lookup that already uses one;
 * - it reads at least SUGGEST_MIN_ROWS per scan, with the row count known;
 * - the optimiser had no candidate index for it (`possible_keys` empty) — when it had one and
 *   declined it, the column is not selective enough, and another index on it would be declined too;
 * - it is a real table: not `<derived2>`, not a CTE;
 * - some predicate names one of its columns — its own filter, the Filter step wrapped around it,
 *   or (only when it is the INNER side of a join, where an index turns each probe into a lookup)
 *   an equality with another table.
 */
export function suggestIndexes(root: ExplainNode | null, sql: string, dbType: string): IndexSuggestion[] {
  if (!root) return [];
  const aliases = resolveAliases(sql || '');
  const ctes = collectCteNames(sql || '');
  const out: IndexSuggestion[] = [];
  const done = new Set<string>();

  // `wrapper`: predicates of the Filter steps directly around this node, which can only be about
  // it. `joinConds`: the condition of the nearest enclosing join, which names BOTH sides — so
  // there an atom is taken only when it is qualified with this table's name.
  const walk = (node: ExplainNode, wrapper: string[], joinConds: string[], inner: boolean) => {
    const own = nodePredicates(node);
    const joinHere = isJoinNode(node);
    (node.children || []).forEach((child, i) => {
      if (joinHere) walk(child, [], own, inner || i > 0);
      else walk(child, [...wrapper, ...own], joinConds, inner);
    });
    if (!node.table) return;

    const scans = node.flags?.includes('fullTableScan') || node.flags?.includes('noIndexUsed');
    if (!scans || node.indexName) return;
    const rows = node.rows;
    if (rows === undefined || rows < SUGGEST_MIN_ROWS) return;
    if (node.candidateIndexes && node.candidateIndexes.length > 0) return;
    if (/[<>]/.test(node.table) || ctes.has(node.table.toLowerCase())) return;

    const alias = node.table;
    const table = aliases.get(alias.toLowerCase()) ?? alias;
    if (ctes.has(table.toLowerCase())) return;
    const mine = (a: { qualifier?: string }) => !a.qualifier
      || a.qualifier.toLowerCase() === alias.toLowerCase()
      || a.qualifier.toLowerCase() === table.toLowerCase();

    const eq: string[] = [];
    let range: string | undefined;
    const used: string[] = [];
    const take = (predicates: string[], allowJoin: boolean, allowUnqualified: boolean) => {
      for (const p of predicates) {
        let hit = false;
        for (const found of predicateAtoms(p)) {
          let atom: { qualifier?: string; column: string; kind: PredicateKind } = found;
          if (found.kind === 'join') {
            // Either side of `a.x = b.y` may be this table's; the other side must be qualified
            // too, or there is no telling which table an unqualified name belongs to.
            if (!allowJoin || !found.qualifier || !found.other?.qualifier) continue;
            if (!mine(found)) {
              const other = { ...found.other, kind: 'join' as PredicateKind };
              if (!mine(other)) continue;
              atom = other;
            }
          } else {
            if (!allowUnqualified && !found.qualifier) continue;
            if (!mine(found)) continue;
          }
          if (atom.kind === 'range') {
            if (!range && !eq.includes(atom.column)) { range = atom.column; hit = true; }
          } else if (!eq.includes(atom.column) && eq.length < MAX_EQ_COLUMNS) {
            eq.push(atom.column);
            hit = true;
          }
        }
        if (hit) used.push(p);
      }
    };
    // Unqualified columns are trusted only on the scan itself and its own Filter wrapper, where
    // there is exactly one table they can belong to. MySQL attaches a join predicate to the
    // inner table itself, so on the inner side a join equality counts there too.
    take([...own, ...wrapper], inner, true);
    // Only a qualified atom of a join condition is known to be about this table; on the inner
    // side an equality with the outer table is what an index would turn into a lookup.
    take(joinConds, inner, false);

    if (range && eq.includes(range)) range = undefined;
    const columns = [
      ...eq.map(name => ({ name, kind: 'eq' as PredicateKind })),
      ...(range ? [{ name: range, kind: 'range' as PredicateKind }] : []),
    ];
    if (columns.length === 0) return;
    const key = `${table.toLowerCase()}(${columns.map(c => c.name.toLowerCase()).join(',')})`;
    if (done.has(key)) return;
    done.add(key);

    out.push({
      table,
      alias: alias !== table ? alias : undefined,
      columns,
      nodeId: node.id,
      rows,
      predicates: [...new Set(used)],
      sql: indexSql(table, columns.map(c => c.name), dbType),
    });
  };
  walk(root, [], [], false);

  // Biggest scans first: that is where an index pays the most.
  return out.sort((a, b) => b.rows - a.rows);
}

// ---------------------------------------------------------------------------------------------
// Copy as text
// ---------------------------------------------------------------------------------------------

/** Tab-separated rows, one header row first — pastes into a spreadsheet as a table. */
export function toTsv(header: string[], rows: (string | number | undefined | null)[][]): string {
  const cell = (v: string | number | undefined | null) =>
    v === undefined || v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' ');
  return [header, ...rows].map(r => r.map(cell).join('\t')).join('\n');
}

/** The plan as an indented outline, one operator per line — the Tree view in plain text. */
export function planOutline(root: ExplainNode | null, describe: (node: ExplainNode) => string): string {
  const lines: string[] = [];
  const walk = (node: ExplainNode, depth: number) => {
    lines.push(`${'  '.repeat(depth)}-> ${describe(node)}`);
    node.children?.forEach(child => walk(child, depth + 1));
  };
  if (root) walk(root, 0);
  return lines.join('\n');
}
