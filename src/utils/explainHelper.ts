import i18n from '../i18n';

/**
 * Facts worth flagging on a node. Every one is read straight out of the plan (or derived from
 * two of its numbers) — nothing here is guessed.
 */
export type ExplainFlag =
  | 'fullTableScan'
  | 'noIndexUsed'
  | 'coveringIndex'
  | 'indexCondition'
  | 'joinBuffer'
  | 'temporaryTable'
  | 'filesort'
  | 'neverExecuted'
  | 'rowsMisestimated'
  | 'subqueriesHidden'
  | 'cartesianJoin';

export interface ExplainNode {
  id: string;
  type: string;
  table?: string;
  /** The index actually chosen. Empty means no index is used — never fall back to candidates. */
  indexName?: string;
  /** `possible_keys`: indexes the optimiser considered and did not necessarily pick. */
  candidateIndexes?: string[];
  /** Cumulative cost in every dialect: it includes the children's cost. */
  cost?: { start: number; total: number };
  /** Cost of this operator alone. Feeds the relative-cost (%) badge in the diagram. */
  selfCost?: number;
  costSeverity?: 'low' | 'medium' | 'high';
  /** Rows this operator reads per scan. Shown as "estimated rows" in the detail panel. */
  rows?: number;
  /** Rows this operator hands to its parent. This is what the arrow labels show. */
  rowsOut?: number;
  actualTime?: { start: number; total: number };
  /** Measured rows **per loop**, exactly as the plan reports it. */
  actualRows?: number;
  /** How many times the operator ran. MySQL `loops=`, Postgres `Actual Loops`. */
  actualLoops?: number;
  /** actualRows × actualLoops — the row count a reader actually expects to see. */
  actualRowsTotal?: number;
  /** actualRows / rows: both are per-loop, so the ratio needs no loop correction. */
  estimateRatio?: number;
  /** For a join step: the tables already joined, and the one this step brings in. */
  joinTables?: { left: string[]; right?: string };
  filter?: string;
  /** Postgres `Index Cond`: evaluated inside the index, unlike `filter`. */
  indexCond?: string;
  joinFilter?: string;
  hashCond?: string;
  message?: string;
  flags?: ExplainFlag[];
  details?: Record<string, any>;
  children?: ExplainNode[];
}

export interface ExplainResult {
  rawText: string;
  rootNode: ExplainNode | null;
  planningTimeMs?: number;
  executionTimeMs?: number;
  /** Cumulative cost of the whole plan. */
  totalCost?: number;
  /** The value exactly as the driver returned it, so display loses no precision. */
  totalCostText?: string;
  /** Sum of every node's selfCost — the denominator of the % badges. */
  totalSelfCost?: number;
  /** Non-default planner settings, from Postgres `EXPLAIN (SETTINGS)`. */
  settings?: Record<string, string>;
  /** The EXPLAIN statement that produced this plan. Set by the caller, not the parser: it is what
   *  resolves the plan's aliases to real tables for index suggestions, and what the comparison
   *  view shows as "what was compared". */
  sourceSql?: string;
}

/** A row estimate this far from the measured value is worth flagging. */
const MISESTIMATE_FACTOR = 10;

/**
 * One raw plan field rendered as text, or null when the value is a nested structure that has no
 * place in a flat list (cost_info, the nested_loop array, …) — those stay readable in the Raw tab.
 * Shared by the Plan grid and the node detail panel so both agree on what is displayable.
 */
export function planFieldText(value: any): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value) && value.every(v => v === null || typeof v !== 'object')) {
      return value.join(', ');
    }
    return null;
  }
  return String(value);
}

export function buildExplainQuery(sql: string, dbType: string, variant: 'explain' | 'analyze' | 'json' = 'explain'): string {
  const cleanSql = sql.trim().replace(/;$/, '');
  const db = (dbType || 'mysql').toLowerCase();

  if (db.includes('postgres') || db.includes('pg')) {
    if (variant === 'analyze') {
      return `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${cleanSql};`;
    }
    // Postgres returns JSON for the plain variant too, so `json` has to earn its menu entry:
    // VERBOSE adds output columns and schema-qualified names, SETTINGS lists the non-default
    // planner settings in effect — the usual answer to "why did it pick this plan".
    // SETTINGS needs PostgreSQL 12+.
    if (variant === 'json') {
      return `EXPLAIN (FORMAT JSON, VERBOSE, SETTINGS) ${cleanSql};`;
    }
    return `EXPLAIN (FORMAT JSON) ${cleanSql};`;
  }

  if (db.includes('mysql') || db.includes('maria')) {
    if (variant === 'json') {
      return `EXPLAIN FORMAT=JSON ${cleanSql};`;
    }
    if (variant === 'analyze') {
      return `EXPLAIN ANALYZE ${cleanSql};`;
    }
    return `EXPLAIN ${cleanSql};`;
  }

  if (db.includes('sqlite')) {
    return `EXPLAIN QUERY PLAN ${cleanSql};`;
  }

  return `EXPLAIN ${cleanSql};`;
}

/**
 * Whether the `json` variant produces anything the plain one does not. SQLite only ever answers
 * `EXPLAIN QUERY PLAN`, so the menu entry has nothing to offer there.
 */
export function supportsJsonExplain(dbType: string): boolean {
  return !(dbType || '').toLowerCase().includes('sqlite');
}

/**
 * Menu label for the `json` variant: the statement it will actually run. Kept next to
 * buildExplainQuery so the label cannot drift away from the SQL.
 */
export function explainJsonLabel(dbType: string): string {
  const db = (dbType || '').toLowerCase();
  if (db.includes('postgres') || db.includes('pg')) return 'EXPLAIN (FORMAT JSON, VERBOSE, SETTINGS)';
  return 'EXPLAIN FORMAT=JSON';
}

// MySQL reports how a table is reached in `access_type`. The operator name and the table name
// must stay in separate fields: the diagram prints them on two different lines.
const MYSQL_ACCESS_OPERATOR: Record<string, string> = {
  all: 'Table Scan',
  index: 'Index Scan',
  range: 'Index Range Scan',
  ref: 'Index Lookup',
  ref_or_null: 'Index Lookup (or NULL)',
  eq_ref: 'Unique Index Lookup',
  const: 'Constant Row',
  system: 'System Row',
  fulltext: 'Fulltext Search',
  index_merge: 'Index Merge',
  unique_subquery: 'Subquery Lookup',
  index_subquery: 'Subquery Index Lookup',
};

function mysqlOperatorName(accessType?: string): string {
  const key = String(accessType || '').toLowerCase();
  if (MYSQL_ACCESS_OPERATOR[key]) return MYSQL_ACCESS_OPERATOR[key];
  return key ? `Scan (${key.toUpperCase()})` : 'Scan';
}

function num(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : undefined;
}

// Rows one scan of a table hands upwards. MySQL reports how many it reads
// (rows_examined_per_scan) and what share survives the predicate (`filtered`, a percentage).
function mysqlRowsPerScan(t: any): number | undefined {
  const examined = num(t?.rows_examined_per_scan ?? t?.rows ?? t?.ROWS);
  if (examined === undefined) return undefined;
  const filtered = num(t?.filtered ?? t?.FILTERED);
  if (filtered === undefined) return examined;
  return Math.round(examined * (filtered / 100));
}

function collectTables(node: ExplainNode): string[] {
  const out = node.table ? [node.table] : [];
  for (const child of node.children || []) out.push(...collectTables(child));
  return out;
}

/**
 * The join predicate, in the server's own words: `ref` is what the index lookup is compared
 * against and `used_key_parts` is which columns of the index it uses. Pairing them up is what
 * turns "Nested Loop Join" into "s.address_id = sakila.a.address_id".
 */
function mysqlJoinCondition(t: any): string | undefined {
  const refs: string[] = (Array.isArray(t?.ref) ? t.ref : []).filter((r: any) => typeof r === 'string');
  if (refs.length === 0) return undefined;
  // `const` / `func` mean the other side is not a column, so there is no join to spell out.
  if (refs.every(r => r === 'const' || r === 'func')) return undefined;

  const parts: string[] = Array.isArray(t.used_key_parts) ? t.used_key_parts : [];
  if (t.table_name && parts.length === refs.length) {
    return parts.map((part, i) => `${t.table_name}.${part} = ${refs[i]}`).join(' AND ');
  }
  return refs.join(', ');
}

// MySQL flattens a join into a single `nested_loop` array. Every plan visualiser instead shows
// one binary join per step: N tables become N-1 left-deep Nested Loop nodes. Keeping the array
// flat produced one node with N children — a diagram that grew *taller* with each joined table
// instead of wider.
function buildNestedLoopChain(items: any[]): ExplainNode {
  let acc = parseMysqlJsonNode(items[0]);

  for (let i = 1; i < items.length; i++) {
    const right = parseMysqlJsonNode(items[i]);
    const rightTable = items[i]?.table;

    // rows_produced_per_join is cumulative over the whole join prefix, so it describes the join
    // step — the table being joined in only emits its own per-scan rows.
    if (rightTable) {
      const perScan = mysqlRowsPerScan(rightTable);
      right.rowsOut = perScan;
      // `right` may be the Filter wrapper around the table; keep the two consistent.
      if (right.children?.[0]) right.children[0].rowsOut = perScan;
    }

    const prefixCost = num(rightTable?.cost_info?.prefix_cost);
    const joinFilter = mysqlJoinCondition(rightTable);
    // Collected before `acc` is replaced: everything already joined is this step's left input.
    const leftTables = collectTables(acc);

    acc = {
      id: '',
      type: 'Nested Loop Join',
      cost: prefixCost !== undefined ? { start: 0, total: prefixCost } : undefined,
      rowsOut: num(rightTable?.rows_produced_per_join),
      joinTables: { left: leftTables, right: rightTable?.table_name },
      joinFilter,
      // children[0] is the join accumulated so far: the diagram draws it straight along the top
      // row and hangs the newly joined table underneath.
      children: [acc, right],
      details: { join_step: i, joined_table: rightTable?.table_name },
    };
    if (rightTable && isMysqlCrossJoinStep(rightTable, joinFilter)) addFlag(acc, 'cartesianJoin');
  }

  return acc;
}

/**
 * A join step whose newly joined table is read with nothing tying it to the tables before it:
 * no `ref` (no index lookup keyed on them) and no `attached_condition` (MySQL attaches a join
 * predicate to the table where all of its columns first become available — this one). Every row
 * of the prefix then pairs with every row read here.
 *
 * Deliberately narrow, since a false alarm here is the loudest one in the diagram: a const /
 * eq_ref / ref read is keyed on something, `range checked for each record` re-plans per outer
 * row, and a one-row table multiplies nothing. An attached condition that only mentions this
 * table also silences it — a missed warning, never a wrong one.
 */
function isMysqlCrossJoinStep(t: any, joinFilter: string | undefined): boolean {
  if (joinFilter || t.attached_condition || t.range_checked_for_each_record) return false;
  const access = String(t.access_type || '').toLowerCase();
  if (access !== 'all' && access !== 'index' && access !== 'range') return false;
  const perScan = num(t.rows_examined_per_scan);
  return perScan !== undefined && perScan > 1;
}

/**
 * Postgres' shape of the same mistake: a Nested Loop with no Join Filter whose inner side cannot
 * be parameterised by the outer row. A Materialize is rescanned as-is on every loop, and a Seq
 * Scan with no Filter reads the whole table every loop — so neither can be what joins the two
 * sides. An inner Index Scan (whose Index Cond may name the outer row) is left alone.
 */
function isPgCrossJoin(plan: any): boolean {
  if (!/^Nested Loop/i.test(String(plan['Node Type'] || ''))) return false;
  if (plan['Join Filter']) return false;
  const inner = Array.isArray(plan.Plans) ? plan.Plans[1] : undefined;
  if (!inner) return false;
  const innerType = String(inner['Node Type'] || '');
  if (innerType === 'Materialize') return true;
  return innerType === 'Seq Scan' && !inner['Filter'];
}

function accessSeverity(accessType?: string): 'low' | 'medium' | 'high' {
  const key = String(accessType || '').toLowerCase();
  if (key === 'all') return 'high';
  if (key === 'index' || key === 'range' || key === 'index_merge') return 'medium';
  return 'low';
}

// Ids come from the position in the tree, never from a counter + Date.now(): an id that changes
// on every parse remounts the whole diagram and throws away the selected node.
function assignIds(node: ExplainNode, path: string): void {
  node.id = `n${path}`;
  node.children?.forEach((child, i) => assignIds(child, `${path}.${i}`));
}

// Fills in selfCost and returns the subtree's cumulative cost so the caller can subtract it.
function annotateSelfCost(node: ExplainNode): number {
  const childCum = (node.children || []).reduce((sum, child) => sum + annotateSelfCost(child), 0);

  // A MySQL table node carries read_cost/eval_cost, which already *is* its own cost — its
  // cost.total holds prefix_cost, i.e. the cost of the entire join prefix up to that table.
  const costInfo = node.details?.cost_info;
  const readCost = costInfo ? parseFloat(costInfo.read_cost) : NaN;
  if (Number.isFinite(readCost)) {
    const evalCost = parseFloat(costInfo.eval_cost);
    node.selfCost = readCost + (Number.isFinite(evalCost) ? evalCost : 0);
    return node.selfCost + childCum;
  }

  const own = node.cost?.total;
  if (own === undefined) {
    node.selfCost = 0;
    return childCum;
  }
  node.selfCost = Math.max(0, own - childCum);
  return Math.max(own, childCum);
}

// Derived per-node facts that need both an estimate and a measurement, so they cannot be
// computed while parsing a single field.
function annotateActuals(node: ExplainNode): void {
  if (node.actualRows !== undefined) {
    const loops = node.actualLoops ?? 1;
    node.actualRowsTotal = node.actualRows * loops;
    if (node.actualLoops === 0) addFlag(node, 'neverExecuted');
  }

  if (node.actualRows !== undefined && node.rows !== undefined && node.rows > 0 && node.actualLoops !== 0) {
    node.estimateRatio = node.actualRows / node.rows;
    if (node.estimateRatio >= MISESTIMATE_FACTOR || node.estimateRatio <= 1 / MISESTIMATE_FACTOR) {
      addFlag(node, 'rowsMisestimated');
    }
  }

  node.children?.forEach(annotateActuals);
}

function addFlag(node: ExplainNode, flag: ExplainFlag): void {
  if (!node.flags) node.flags = [];
  if (!node.flags.includes(flag)) node.flags.push(flag);
}

function sumSelfCost(node: ExplainNode): number {
  return (node.selfCost || 0) + (node.children || []).reduce((sum, child) => sum + sumSelfCost(child), 0);
}

function finalizeResult(result: ExplainResult): ExplainResult {
  if (!result.rootNode) return result;
  assignIds(result.rootNode, '0');
  annotateSelfCost(result.rootNode);
  annotateActuals(result.rootNode);
  result.totalSelfCost = sumSelfCost(result.rootNode);
  if (result.totalCost === undefined) result.totalCost = result.rootNode.cost?.total;
  if (result.totalCostText === undefined && result.totalCost !== undefined) {
    result.totalCostText = String(result.totalCost);
  }
  return result;
}

export function parseExplainOutput(rows: any[], dbType: string): ExplainResult {
  const db = (dbType || 'mysql').toLowerCase();

  if (!rows || rows.length === 0) {
    return { rawText: i18n.t('explain.noData'), rootNode: null };
  }

  // Build raw text from rows
  const rawText = rows.map(r => {
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') {
      const val = r['EXPLAIN'] || r['explain'] || r['QUERY PLAN'] || r['EXPLAIN ANALYZE'] || Object.values(r)[0];
      return typeof val === 'string' ? val : JSON.stringify(val);
    }
    return String(r);
  }).join('\n');

  // Text-based EXPLAIN ANALYZE format (MySQL 8+ "-> Table scan..." or PostgreSQL text plan).
  // Skipped when the payload is JSON: an `attached_condition` holding a JSON path operator
  // (`col->'$.a'`) would otherwise drag the whole JSON document down this branch.
  const trimmedRaw = rawText.trimStart();
  const looksLikeJson = trimmedRaw.startsWith('{') || trimmedRaw.startsWith('[');
  if (!looksLikeJson && (rawText.includes('->') || rawText.includes('actual time='))) {
    const textNode = parseAnalyzeTextPlan(rawText);
    if (textNode) {
      return finalizeResult({
        rawText,
        rootNode: textNode
      });
    }
  }

  // Format Postgres JSON
  if (db.includes('postgres') || db.includes('pg')) {
    try {
      let pgData = rows[0];
      if (typeof pgData === 'object') {
        const firstKey = Object.keys(pgData)[0];
        if (typeof pgData[firstKey] === 'string' && pgData[firstKey].trim().startsWith('[')) {
          pgData = JSON.parse(pgData[firstKey]);
        } else if (pgData['QUERY PLAN']) {
          pgData = typeof pgData['QUERY PLAN'] === 'string' ? JSON.parse(pgData['QUERY PLAN']) : pgData['QUERY PLAN'];
        }
      }
      if (Array.isArray(pgData)) pgData = pgData[0];

      if (pgData && pgData.Plan) {
        const rootNode = parsePgNode(pgData.Plan);
        const rootCost = pgData.Plan['Total Cost'];
        return finalizeResult({
          rawText: JSON.stringify(pgData, null, 2),
          rootNode,
          planningTimeMs: pgData['Planning Time'],
          executionTimeMs: pgData['Execution Time'],
          // Asked for via EXPLAIN (SETTINGS) — it used to arrive and get thrown away.
          settings: pgData['Settings'] && typeof pgData['Settings'] === 'object' ? pgData['Settings'] : undefined,
          totalCost: rootCost !== undefined ? Number(rootCost) : undefined,
          totalCostText: rootCost !== undefined ? String(rootCost) : undefined
        });
      }
    } catch {
      // fallback to raw text
    }
  }

  // Format MySQL (JSON or Tabular)
  if (db.includes('mysql') || db.includes('maria') || (rows[0] && ('select_type' in rows[0] || 'SELECT_TYPE' in rows[0]))) {
    try {
      let jsonStr = '';
      const firstRow = rows[0];
      if (firstRow) {
        jsonStr = firstRow['EXPLAIN'] || firstRow['explain'] || firstRow['QUERY PLAN'] || (typeof Object.values(firstRow)[0] === 'string' ? Object.values(firstRow)[0] as string : '');
      }
      if (jsonStr && typeof jsonStr === 'string' && jsonStr.trim().startsWith('{')) {
        const mysqlData = JSON.parse(jsonStr);
        const block = mysqlData.query_block || mysqlData;
        const rootNode = parseMysqlJsonNode(block);
        // query_cost arrives as a string ("201.488798948022"); keep it verbatim so the header
        // can print every digit instead of a rounded float.
        const queryCost = block?.cost_info?.query_cost;
        return finalizeResult({
          rawText: JSON.stringify(mysqlData, null, 2),
          rootNode,
          totalCost: queryCost !== undefined ? parseFloat(queryCost) : undefined,
          totalCostText: queryCost !== undefined ? String(queryCost) : undefined
        });
      }

      // MySQL Tabular EXPLAIN format (id, select_type, table, type, possible_keys, key, rows, Extra)
      if (firstRow && ('select_type' in firstRow || 'SELECT_TYPE' in firstRow || 'table' in firstRow || 'TABLE' in firstRow)) {
        const rootNode = parseMysqlTabularPlan(rows);
        return finalizeResult({
          rawText: rows.map(r => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' | ')).join('\n'),
          rootNode
        });
      }
    } catch {
      // fallback
    }
  }

  // Format SQLite EXPLAIN QUERY PLAN
  if (db.includes('sqlite') || (rows[0] && ('detail' in rows[0] || 'DETAIL' in rows[0] || 'selectid' in rows[0]))) {
    const rootNode = parseSqlitePlan(rows);
    return finalizeResult({ rawText, rootNode });
  }

  // Fallback Raw Text & Generic Node
  return finalizeResult({
    rawText,
    rootNode: {
      id: '',
      type: 'Execute Query',
      details: { raw: rawText }
    }
  });
}

function parseAnalyzeTextPlan(rawText: string): ExplainNode | null {
  const lines = rawText.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;

  interface StackItem {
    indent: number;
    node: ExplainNode;
  }

  const stack: StackItem[] = [];
  let rootNode: ExplainNode | null = null;

  lines.forEach((line) => {
    const arrowIdx = line.indexOf('->');
    let indent = 0;
    let content = line;
    if (arrowIdx !== -1) {
      indent = arrowIdx;
      content = line.substring(arrowIdx + 2).trim();
    } else {
      indent = line.search(/\S/);
      if (indent === -1) indent = 0;
      content = line.trim();
    }

    let cost: { start: number; total: number } | undefined;
    let rows: number | undefined;
    const costMatch = content.match(/\(cost=([\d.]+)(?:\.\.([\d.]+))?\s+rows=(\d+)/i);
    if (costMatch) {
      const startCost = costMatch[2] ? parseFloat(costMatch[1]) : 0;
      const totalCost = costMatch[2] ? parseFloat(costMatch[2]) : parseFloat(costMatch[1]);
      cost = { start: startCost, total: totalCost };
      rows = parseInt(costMatch[3], 10);
    }

    let actualTime: { start: number; total: number } | undefined;
    let actualRows: number | undefined;
    let actualLoops: number | undefined;
    // `loops=` matters: MySQL and Postgres both report `rows` **per loop**, so an inner-loop
    // operator reads as though it returned a handful of rows when it returned rows × loops.
    const actualMatch = content.match(/\(actual time=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)(?:\s+loops=(\d+))?/i);
    if (actualMatch) {
      actualTime = { start: parseFloat(actualMatch[1]), total: parseFloat(actualMatch[2]) };
      actualRows = parseInt(actualMatch[3], 10);
      if (actualMatch[4]) actualLoops = parseInt(actualMatch[4], 10);
    }
    // MySQL prints this instead of a timing block for a branch it never entered.
    const neverExecuted = /never executed/i.test(content);
    if (neverExecuted) actualLoops = 0;

    let opTitle = content
      .replace(/\(cost=.*?\)/gi, '')
      .replace(/\(actual time=.*?\)/gi, '')
      .trim();

    if (!opTitle) opTitle = 'Operation';

    const tableMatch = opTitle.match(/(?:on|from)\s+([`"\w]+)/i);
    const table = tableMatch ? tableMatch[1].replace(/[`"]/g, '') : undefined;

    const indexMatch = opTitle.match(/using\s+([`"\w]+)/i);
    const indexName = indexMatch ? indexMatch[1].replace(/[`"]/g, '') : undefined;

    const titleUpper = opTitle.toUpperCase();
    const titleLower = opTitle.toLowerCase();

    let accessType: string | undefined = undefined;
    if (titleLower.includes('single-row index lookup') || titleLower.includes('unique index lookup')) {
      accessType = 'eq_ref';
    } else if (titleLower.includes('index lookup') || titleLower.includes('ref lookup')) {
      accessType = 'ref';
    } else if (titleLower.includes('table scan') || titleLower.includes('seq scan')) {
      accessType = 'ALL';
    } else if (titleLower.includes('index range scan') || titleLower.includes('range scan')) {
      accessType = 'range';
    } else if (titleLower.includes('full index scan') || titleLower.includes('index scan')) {
      accessType = 'index';
    } else if (titleLower.includes('constant') || titleLower.includes('system row')) {
      accessType = 'const';
    }

    const condMatch = opTitle.match(/\(([^()]+=[^()]+)\)/);
    const filterCond = condMatch ? condMatch[1] : undefined;

    let costSeverity: 'low' | 'medium' | 'high' = 'low';
    if (titleUpper.includes('TABLE SCAN') || titleUpper.includes('SEQ SCAN') || titleUpper.includes('FULL SCAN')) {
      costSeverity = 'high';
    } else if (titleUpper.includes('INDEX SCAN') || titleUpper.includes('RANGE SCAN') || titleUpper.includes('FILESORT')) {
      costSeverity = 'medium';
    } else if (cost && cost.total > 100) {
      costSeverity = 'high';
    } else if (cost && cost.total > 10) {
      costSeverity = 'medium';
    }

    const detailsObj: Record<string, any> = { rawLine: line };
    if (accessType) detailsObj.access_type = accessType;
    if (indexName) detailsObj.used_key_parts = [indexName];
    if (filterCond) detailsObj.attached_condition = filterCond;

    const node: ExplainNode = {
      id: '',
      type: opTitle,
      table,
      indexName,
      cost,
      costSeverity,
      rows,
      // `rows=` in a text plan is the estimated row count the operator emits.
      rowsOut: rows,
      actualTime,
      actualRows,
      actualLoops,
      filter: filterCond,
      details: detailsObj
    };
    if (neverExecuted) addFlag(node, 'neverExecuted');
    // The same signal the JSON and tabular branches raise for access_type ALL. Without it a tree
    // plan never showed the loudest warning there is.
    if (accessType === 'ALL') addFlag(node, 'fullTableScan');
    // MySQL's own words for a join step with nothing to join on (`Inner hash join (no condition)`).
    if (/\(no condition\)/i.test(opTitle)) addFlag(node, 'cartesianJoin');

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length > 0) {
      const parent = stack[stack.length - 1].node;
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    } else {
      if (!rootNode) rootNode = node;
    }

    stack.push({ indent, node });
  });

  return rootNode;
}

function parsePgNode(plan: any): ExplainNode {
  const node: ExplainNode = {
    id: '',
    type: plan['Node Type'] || 'Operation',
    table: plan['Relation Name'] || plan['Alias'],
    indexName: plan['Index Name'],
    cost: plan['Startup Cost'] !== undefined ? { start: plan['Startup Cost'], total: plan['Total Cost'] } : undefined,
    rows: plan['Plan Rows'],
    // Postgres already reports estimated *output* rows, so it needs no per-scan correction.
    rowsOut: plan['Plan Rows'],
    actualTime: plan['Actual Startup Time'] !== undefined ? { start: plan['Actual Startup Time'], total: plan['Actual Total Time'] } : undefined,
    actualRows: plan['Actual Rows'],
    // Postgres reports rows per loop too, so without this the actual counts read far too low.
    actualLoops: num(plan['Actual Loops']),
    filter: plan['Filter'],
    // Evaluated inside the index, unlike Filter which runs after the heap fetch.
    indexCond: plan['Index Cond'],
    joinFilter: plan['Join Filter'],
    hashCond: plan['Hash Cond'],
    details: { ...plan }
  };

  const nodeType = String(plan['Node Type'] || '');
  if (/Seq Scan/i.test(nodeType)) node.costSeverity = 'high';
  else if (/Index Scan|Bitmap|Sort/i.test(nodeType)) node.costSeverity = 'medium';
  else node.costSeverity = 'low';

  // Only signals that actually mean something on Postgres. `Index Cond` is present on every
  // index scan and `Sort Method` on every sort, so flagging those would be pure noise — both
  // stay visible in the Plan grid.
  if (/Seq Scan/i.test(nodeType)) addFlag(node, 'fullTableScan');
  if (/^Index Only Scan/i.test(nodeType)) addFlag(node, 'coveringIndex');
  if (isPgCrossJoin(plan)) addFlag(node, 'cartesianJoin');

  if (plan.Plans && Array.isArray(plan.Plans)) {
    node.children = plan.Plans.map((child: any) => parsePgNode(child));
  }

  return node;
}

function parseMysqlTabularPlan(rows: any[]): ExplainNode {
  const children: ExplainNode[] = rows.map((row) => {
    const accessType = row.type || row.TYPE;
    const selectType = String(row.select_type || row.SELECT_TYPE || '').toUpperCase();
    const operator = mysqlOperatorName(accessType);
    const extra = String(row.Extra || row.EXTRA || '');
    const rowCount = row.rows ?? row.ROWS;
    const chosenKey = row.key || row.KEY;
    const candidates = row.possible_keys || row.POSSIBLE_KEYS;

    const node: ExplainNode = {
      id: '',
      // Only qualify with select_type when it says something (DERIVED, SUBQUERY, UNION…).
      type: selectType && selectType !== 'SIMPLE' ? `${operator} (${selectType})` : operator,
      table: row.table || row.TABLE,
      // Same rule as the JSON branch: candidates are not the chosen index.
      indexName: chosenKey || undefined,
      candidateIndexes: candidates ? String(candidates).split(',').map(s => s.trim()).filter(Boolean) : undefined,
      costSeverity: accessSeverity(accessType),
      rows: num(rowCount),
      rowsOut: mysqlRowsPerScan(row),
      filter: extra || undefined,
      details: { ...row }
    };

    if (String(accessType || '').toLowerCase() === 'all') addFlag(node, 'fullTableScan');
    else if (!chosenKey) addFlag(node, 'noIndexUsed');
    // The tabular form only reports these as free text in Extra.
    if (/using index(?!\s+condition)/i.test(extra)) addFlag(node, 'coveringIndex');
    if (/using index condition/i.test(extra)) addFlag(node, 'indexCondition');
    if (/using join buffer/i.test(extra)) addFlag(node, 'joinBuffer');
    if (/using temporary/i.test(extra)) addFlag(node, 'temporaryTable');
    if (/using filesort/i.test(extra)) addFlag(node, 'filesort');

    return node;
  });

  if (children.length === 1) {
    return children[0];
  }

  return {
    id: '',
    type: 'Query Execution Plan',
    children
  };
}

/**
 * dbForge draws a `Stream` step between the sort and the join. MySQL's JSON has no such field —
 * what it does have is a residual: query_block's `query_cost` minus everything the join below
 * accounts for. This gives that real number its own box instead of folding it silently into the
 * Sort above it. Only the label is borrowed; the cost is MySQL's own.
 */
function maybeStream(child: ExplainNode, blockCost?: number): ExplainNode {
  if (blockCost === undefined) return child;
  const childCum = child.cost?.total;
  if (childCum === undefined || blockCost - childCum <= 0) return child;

  return {
    id: '',
    type: 'Stream',
    cost: { start: 0, total: blockCost },
    rowsOut: child.rowsOut,
    children: [child],
    details: { residual_cost: blockCost - childCum }
  };
}

// `{dependent, cacheable, query_block}` wrappers, however MySQL nests them.
function subqueryNodes(list: any): ExplainNode[] {
  if (!Array.isArray(list)) return [];
  return list.filter(Boolean).map((item: any) => parseMysqlJsonNode(item));
}

function parseMysqlJsonNode(obj: any): ExplainNode {
  const node = parseMysqlJsonNodeInner(obj);

  // Correlated subqueries in the select list, and ones the optimiser removed, have no natural
  // place in the operator tree. Flag them so the diagram admits there is more to see in Raw
  // rather than dropping them without a word.
  if (Array.isArray(obj?.select_list_subqueries) || Array.isArray(obj?.optimized_away_subqueries)) {
    addFlag(node, 'subqueriesHidden');
  }
  if (obj?.message && !node.message) node.message = obj.message;

  return node;
}

function parseMysqlJsonNodeInner(obj: any): ExplainNode {
  if (!obj) {
    return { id: '', type: 'Operation' };
  }

  if (obj.query_block) {
    return parseMysqlJsonNode(obj.query_block);
  }

  // Single-child containers (Sort / Group By / Distinct) all have the same shape.
  const container = (label: string, inner: any): ExplainNode => {
    const blockCost = num(obj.cost_info?.query_cost);
    const child = maybeStream(parseMysqlJsonNode(inner), blockCost);
    const node: ExplainNode = {
      id: '',
      type: label,
      cost: blockCost !== undefined ? { start: 0, total: blockCost } : child.cost,
      children: [child],
      details: { ...obj }
    };
    if (inner?.using_filesort) addFlag(node, 'filesort');
    if (inner?.using_temporary_table) addFlag(node, 'temporaryTable');
    return node;
  };

  if (obj.ordering_operation) {
    return container(obj.ordering_operation.using_filesort ? 'Sort (Filesort)' : 'Sort', obj.ordering_operation);
  }

  if (obj.grouping_operation) {
    return container('Group By', obj.grouping_operation);
  }

  if (obj.duplicates_removal) {
    return container('Distinct', obj.duplicates_removal);
  }

  // UNION: each branch is a full query specification of its own. Without this the whole set of
  // branches fell through to the generic node below and vanished from the diagram.
  if (obj.union_result) {
    return {
      id: '',
      type: 'Union',
      children: subqueryNodes(obj.union_result.query_specifications),
      details: { ...obj.union_result, query_specifications: undefined }
    };
  }

  if (obj.nested_loop && Array.isArray(obj.nested_loop) && obj.nested_loop.length > 0) {
    // No ORDER BY / GROUP BY above, so the block's own cost sits directly on this level.
    return maybeStream(buildNestedLoopChain(obj.nested_loop), num(obj.cost_info?.query_cost));
  }

  if (obj.table) {
    const t = obj.table;
    const accessType = t.access_type;

    const tableNode: ExplainNode = {
      id: '',
      type: mysqlOperatorName(accessType),
      table: t.table_name,
      // `key` only. Falling back to possible_keys used to render "no index used" as though an
      // index had been chosen — the loudest warning in a plan, shown as business as usual.
      indexName: t.key || undefined,
      candidateIndexes: Array.isArray(t.possible_keys) ? t.possible_keys : undefined,
      cost: t.cost_info?.read_cost !== undefined
        ? { start: parseFloat(t.cost_info.read_cost || '0'), total: parseFloat(t.cost_info.prefix_cost || t.cost_info.read_cost || '0') }
        : (obj.cost_info?.query_cost ? { start: 0, total: parseFloat(obj.cost_info.query_cost) } : undefined),
      costSeverity: accessSeverity(accessType),
      rows: num(t.rows_examined_per_scan),
      rowsOut: num(t.rows_produced_per_join) ?? mysqlRowsPerScan(t),
      message: t.message,
      details: { ...t }
    };

    if (String(accessType || '').toLowerCase() === 'all') addFlag(tableNode, 'fullTableScan');
    else if (!t.key) addFlag(tableNode, 'noIndexUsed');
    if (t.using_index === true) addFlag(tableNode, 'coveringIndex');
    if (t.index_condition || t.using_index_condition) addFlag(tableNode, 'indexCondition');
    if (t.using_join_buffer) addFlag(tableNode, 'joinBuffer');

    // A derived table / materialised IN(…) hangs its own plan off the table node. Left unread,
    // the entire subquery was missing from the diagram.
    const subInputs = [
      ...subqueryNodes(t.materialized_from_subquery ? [t.materialized_from_subquery] : undefined),
      ...subqueryNodes(t.attached_subqueries),
    ];
    if (subInputs.length > 0) tableNode.children = subInputs;

    // MySQL hangs the residual predicate off the table itself. Split it into its own Filter step
    // so the diagram shows it as an operator. It gets no `cost`, so its selfCost stays 0 —
    // giving it the table's prefix_cost would steal cost from the tables it joins with.
    const condition = t.attached_condition;
    if (condition) {
      return {
        id: '',
        type: 'Filter',
        filter: condition,
        rows: tableNode.rows,
        rowsOut: tableNode.rowsOut,
        children: [tableNode],
        details: { attached_condition: condition }
      };
    }

    return tableNode;
  }

  return {
    id: '',
    type: obj.select_id ? `Select #${obj.select_id}` : 'Operation',
    cost: obj.cost_info?.query_cost ? { start: 0, total: parseFloat(obj.cost_info.query_cost) } : undefined,
    details: { ...obj }
  };
}

function parseSqlitePlan(rows: any[]): ExplainNode {
  const root: ExplainNode = {
    id: '',
    type: 'Query Execution Plan',
    children: []
  };

  rows.forEach((r, idx) => {
    const detail = r.detail || r.DETAIL || Object.values(r)[3] || Object.values(r)[0];
    const detailStr = String(detail || `Step ${idx + 1}`);

    let opType = 'Scan';
    let severity: 'low' | 'medium' | 'high' = 'low';
    if (detailStr.includes('SEARCH')) {
      opType = 'Index Search';
      severity = 'low';
    } else if (detailStr.includes('SCAN')) {
      opType = 'Table Scan';
      severity = 'high';
    } else if (detailStr.includes('USE TEMP B-TREE')) {
      opType = 'Temp B-Tree Sort';
      severity = 'medium';
    }

    root.children?.push({
      id: '',
      type: opType,
      costSeverity: severity,
      filter: detailStr,
      details: { ...r }
    });
  });

  return root;
}

/** Flags that mean "look here", in the order the summary lists them — worst first. */
export const WARN_FLAGS: readonly ExplainFlag[] = [
  'cartesianJoin', 'fullTableScan', 'noIndexUsed', 'filesort', 'temporaryTable', 'joinBuffer',
  'rowsMisestimated',
];
/** Flags that mean "this is fine". Everything else is neither. */
export const GOOD_FLAGS: readonly ExplainFlag[] = ['coveringIndex', 'indexCondition'];

/**
 * `danger` is reserved for a cross join: every other warning is a slower way to get the right
 * answer, while this one usually means the query returns rows it was never meant to.
 */
export function flagSeverity(flags: readonly ExplainFlag[]): 'danger' | 'warn' | 'good' | 'muted' {
  if (flags.includes('cartesianJoin')) return 'danger';
  if (flags.some(f => WARN_FLAGS.includes(f))) return 'warn';
  if (flags.some(f => GOOD_FLAGS.includes(f))) return 'good';
  return 'muted';
}

/** The rows an operator hands upward: measured when there is a measurement, else the estimate. */
export function edgeRows(node: ExplainNode): number | undefined {
  return node.actualRows ?? node.rowsOut ?? node.rows;
}

export interface PlanSummary {
  /** The operator with the largest own cost, when the plan reports cost at all. */
  hottest?: { id: string; type: string; pct: number };
  /** One entry per warning kind present, worst first; `firstId` is where a click should land. */
  issues: { flag: ExplainFlag; count: number; firstId: string }[];
  /** Largest row count on any edge — what the connector widths are scaled against. */
  maxRows: number;
}

/**
 * What the diagram's summary strip says, read off the finished tree. Pure, so "which node is the
 * hot one" and "which warnings are there" have one place to be tested.
 */
export function summarizePlan(root: ExplainNode | null, totalSelfCost: number): PlanSummary {
  const summary: PlanSummary = { issues: [], maxRows: 0 };
  if (!root) return summary;

  let hot: ExplainNode | undefined;
  const seen = new Map<ExplainFlag, { count: number; firstId: string }>();
  // Pre-order, so `firstId` is the first occurrence in reading order.
  const walk = (node: ExplainNode) => {
    if ((node.selfCost ?? 0) > (hot?.selfCost ?? 0)) hot = node;
    const rows = edgeRows(node);
    if (rows !== undefined && rows > summary.maxRows) summary.maxRows = rows;
    for (const flag of node.flags || []) {
      if (!WARN_FLAGS.includes(flag)) continue;
      const entry = seen.get(flag);
      if (entry) entry.count++;
      else seen.set(flag, { count: 1, firstId: node.id });
    }
    node.children?.forEach(walk);
  };
  walk(root);

  const hotNode = hot as ExplainNode | undefined;
  if (hotNode?.selfCost && totalSelfCost > 0) {
    summary.hottest = { id: hotNode.id, type: hotNode.type, pct: (hotNode.selfCost / totalSelfCost) * 100 };
  }
  summary.issues = WARN_FLAGS
    .filter(flag => seen.has(flag))
    .map(flag => ({ flag, ...seen.get(flag)! }));
  return summary;
}
