/**
 * Stable React keys for the rows of a form the user adds to and deletes from (CreateTableModal's
 * columns / indexes / foreign keys, CreateRoutineModal's parameters).
 *
 * Keying those rows by position made deleting a middle row hand its inputs — focus, caret, an
 * uncommitted IME composition — to the row that slid up into its place. The name is no key either:
 * "add column" twice gives two rows with an empty name. So each row carries an id minted when it is
 * created, and `withoutRowIds` takes it off again before the rows leave the form.
 */

let seq = 0;

/** A fresh id. Unique for the life of the page, which is all a React key needs. */
export function nextRowId(): number {
  seq += 1;
  return seq;
}

export type WithRowId<T> = T & { rowId: number };

/** The same rows without their key, for anything that is sent on (the backend, a generated script). */
export function withoutRowIds<T extends { rowId: number }>(rows: T[]): Omit<T, 'rowId'>[] {
  return rows.map(({ rowId: _rowId, ...rest }) => rest);
}
