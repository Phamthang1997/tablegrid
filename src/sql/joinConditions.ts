/**
 * Builds `JOIN ... ON` suggestions from table metadata.
 *
 * In a module of its own that **imports no monaco**, for the same reason as `statements.ts`: this
 * logic is a pure function over schema data, so it has to be testable in a node environment.
 */

/** Minimal schema subset needed for JOIN condition inference. */
export interface JoinSchema {
  columns: { name: string }[];
  foreignKeys?: { column: string; refTable: string; refColumn: string }[];
}

/** Key-like column candidates used for fallback when tables lack explicit FK definitions. */
const KEY_LIKE = /(^id$|_id$|number$|code$)/i;

/** Options for {@link buildJoinConditions}. */
export interface JoinConditionOptions {
  /**
   * Report FOREIGN KEYS only, skipping the same-name fallback.
   *
   * Used where the answer decides RANKING rather than filling a caret the user already put after
   * `ON`: in a schema where every table has an `id`, the fallback would mark every table as
   * "joinable", which says nothing. At the caret itself the fallback is still wanted — a guess
   * beats an empty popup once the user has committed to the join.
   */
  fkOnly?: boolean;
}

/**
 * JOIN conditions between the table joined **last** and each table before it.
 * Foreign keys win (in either direction); with no FK it falls back to same-named, key-looking columns.
 *
 * `scopeTables` must be in the order the tables appear in the statement — the last element is taken
 * to be the freshly joined table, i.e. the one the user is writing a condition for.
 */
export async function buildJoinConditions(
  scopeTables: string[],
  aliasByTable: Map<string, string>,
  getSchema: (table: string) => Promise<JoinSchema | null>,
  opts: JoinConditionOptions = {}
): Promise<string[]> {
  const uniq: string[] = [];
  for (const t of scopeTables) {
    if (!uniq.some(u => u.toLowerCase() === t.toLowerCase())) uniq.push(t);
  }
  if (uniq.length < 2) return [];

  const last = uniq[uniq.length - 1];
  const others = uniq.slice(0, -1);
  const pfx = (t: string) => aliasByTable.get(t) || t;

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (a: string, ac: string, b: string, bc: string) => {
    if (!ac || !bc) return;
    const s = `${pfx(a)}.${ac} = ${pfx(b)}.${bc}`;
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  };

  const lastSchema = await getSchema(last);
  for (const other of others) {
    const otherSchema = await getSchema(other);
    const before = out.length;

    // FK: recently joined table -> previous table
    for (const fk of lastSchema?.foreignKeys || []) {
      if ((fk.refTable || '').toLowerCase() === other.toLowerCase()) {
        add(last, fk.column, other, fk.refColumn);
      }
    }
    // FK: previous table -> recently joined table
    for (const fk of otherSchema?.foreignKeys || []) {
      if ((fk.refTable || '').toLowerCase() === last.toLowerCase()) {
        add(other, fk.column, last, fk.refColumn);
      }
    }

    // Fallback by matching column names evaluated per table pair independently.
    
    if (out.length === before && !opts.fkOnly) {
      const lastCols = lastSchema?.columns || [];
      const lastByLower = new Map(lastCols.map(c => [c.name.toLowerCase(), c.name]));
      for (const col of otherSchema?.columns || []) {
        const n = col.name.toLowerCase();
        const match = lastByLower.get(n);
        if (match && KEY_LIKE.test(n)) add(other, col.name, last, match);
      }
    }
  }
  return out;
}
