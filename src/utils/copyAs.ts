/**
 * The "Copy as …" formats behind the grid's context menu.
 *
 * Pure, so the escaping is unit-tested rather than eyeballed — every one of these produces text
 * the user pastes straight into a SQL editor, a PR description or a Slack message, and a value
 * that escapes wrongly is either a broken paste or, for the SQL ones, a statement that runs and
 * means something other than it looks like.
 *
 * Values and identifiers go through `exportHelper`'s `sqlValue`/`quoteIdent` rather than a second
 * copy of that logic. The grid used to carry its own, hardcoded to MySQL backticks, so a
 * `SQL INSERT` copied from a Postgres table came out unusable.
 */

import i18n from '../i18n';
import { quoteIdent, sqlValue } from './exportHelper';

/** Wrapped at roughly this width. A five-thousand-id list on one line is not readable anywhere. */
const IN_LIST_WRAP = 100;

export interface InListResult {
  sql: string;
  /** How many values ended up in the list, after dropping nulls and duplicates. */
  count: number;
  /** Nulls dropped. `IN (NULL)` matches nothing in SQL, so keeping them would be a silent trap. */
  nullsDropped: number;
  /** Duplicates dropped. */
  duplicatesDropped: number;
}

/**
 * A parenthesised value list, ready to paste after an `IN`.
 *
 * Without the `IN` keyword on purpose: the caller usually has their own `WHERE x IN` or
 * `NOT IN` already typed, and a list is useful in `VALUES` too.
 *
 * Deduplicated because a list of ids with repeats says something the user did not mean, and
 * nulls are dropped because SQL's `IN` can never match one — `x IN (1, NULL)` is true for 1 and
 * *unknown* for everything else, never false, which quietly breaks a `NOT IN`. Both counts come
 * back so the caller can say what happened rather than silently changing the answer.
 */
export function buildInList(values: unknown[], dbType: string): InListResult {
  const seen = new Set<string>();
  const literals: string[] = [];
  let nullsDropped = 0;
  let duplicatesDropped = 0;

  for (const value of values) {
    if (value === null || value === undefined) {
      nullsDropped++;
      continue;
    }
    const literal = sqlValue(value, dbType);
    if (seen.has(literal)) {
      duplicatesDropped++;
      continue;
    }
    seen.add(literal);
    literals.push(literal);
  }

  if (literals.length === 0) {
    return { sql: '()', count: 0, nullsDropped, duplicatesDropped };
  }

  const lines: string[] = [];
  let line = '';
  for (const [index, literal] of literals.entries()) {
    const piece = index === literals.length - 1 ? literal : `${literal}, `;
    if (line !== '' && line.length + piece.length > IN_LIST_WRAP) {
      lines.push(line);
      line = '';
    }
    line += piece;
  }
  if (line !== '') lines.push(line);

  const sql = lines.length === 1 ? `(${lines[0]})` : `(\n  ${lines.join('\n  ')}\n)`;
  return { sql, count: literals.length, nullsDropped, duplicatesDropped };
}

/**
 * One `INSERT` per row rather than a single multi-`VALUES` statement.
 *
 * Deliberate, and different from the dump builder, which batches: these are pasted into an editor
 * and edited by hand, and a row that turns out to be wrong is then deleted by deleting its line.
 */
export function buildInsertStatements(
  tableName: string,
  colNames: string[],
  rows: Record<string, unknown>[],
  dbType: string
): string {
  const cols = colNames.map((name) => quoteIdent(name, dbType)).join(', ');
  return rows
    .map((row) => {
      const values = colNames.map((name) => sqlValue(row?.[name], dbType)).join(', ');
      return `INSERT INTO ${quoteIdent(tableName, dbType)} (${cols}) VALUES (${values});`;
    })
    .join('\n');
}

export type UpdateRefusal = 'noKey' | 'nothingToSet';

export interface UpdateResult {
  sql: string;
  /** Set when nothing could be built; `sql` is then empty. */
  refused?: UpdateRefusal;
}

/**
 * One `UPDATE … WHERE <key>` per row.
 *
 * **It refuses rather than emit an UPDATE with no WHERE.** A table with no primary key has
 * nothing to key the statement on, and `UPDATE t SET …;` pasted into an editor and run rewrites
 * every row in the table. There is no useful version of this without a key, so the caller has to
 * tell the user instead.
 *
 * Key columns are left out of the `SET` list — they are the target of the `WHERE`, and setting a
 * key to the value it already has is noise. So are generated columns, which the database
 * computes and refuses to be written (MySQL 3105).
 */
export function buildUpdateStatements(
  tableName: string,
  colNames: string[],
  rows: Record<string, unknown>[],
  dbType: string,
  keyCols: string[],
  skipCols: Set<string> = new Set()
): UpdateResult {
  const keys = keyCols.filter((name) => colNames.includes(name));
  if (keys.length === 0) return { sql: '', refused: 'noKey' };

  const setCols = colNames.filter((name) => !keys.includes(name) && !skipCols.has(name));
  if (setCols.length === 0) return { sql: '', refused: 'nothingToSet' };

  const sql = rows
    .map((row) => {
      const assignments = setCols
        .map((name) => `${quoteIdent(name, dbType)} = ${sqlValue(row?.[name], dbType)}`)
        .join(', ');
      // A key that is NULL cannot be matched by `=`, so it becomes `IS NULL` — otherwise the
      // statement would silently update nothing.
      const where = keys
        .map((name) => {
          const value = row?.[name];
          if (value === null || value === undefined) return `${quoteIdent(name, dbType)} IS NULL`;
          return `${quoteIdent(name, dbType)} = ${sqlValue(value, dbType)}`;
        })
        .join(' AND ');
      return `UPDATE ${quoteIdent(tableName, dbType)} SET ${assignments} WHERE ${where};`;
    })
    .join('\n');

  return { sql };
}

/**
 * A GitHub-flavoured Markdown table.
 *
 * Backslashes are escaped before pipes, or the escape added for a `|` would itself be escaped.
 * Newlines become spaces because a Markdown table row is one line — like the TSV copy, this is a
 * format for pasting, not a lossless export.
 */
export function buildMarkdownTable(colNames: string[], rows: Record<string, unknown>[]): string {
  const cell = (value: unknown) =>
    String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ');

  const header = `| ${colNames.join(' | ')} |`;
  const rule = `| ${colNames.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${colNames.map((name) => cell(row?.[name])).join(' | ')} |`);
  return [header, rule, ...body].join('\n');
}

/** The message for a refusal, so the grid does not have to know the reasons. */
export function updateRefusalMessage(refused: UpdateRefusal): string {
  return refused === 'noKey'
    ? i18n.t('dataGrid.copyUpdateNoKey')
    : i18n.t('dataGrid.copyUpdateNothingToSet');
}
