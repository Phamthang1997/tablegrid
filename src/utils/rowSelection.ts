/**
 * The rules a grid's row selection follows on a click — as pure functions, because they are the
 * one part of row selection that both grids do identically.
 *
 * `DataGrid` and the SQL editor's result grid agree on nothing underneath: one pages and sorts on
 * the server and keys a row by its PRIMARY KEY VALUE, the other holds the whole result in memory
 * and keys a row by the row OBJECT (a query result has no primary key — it can be a join, an
 * aggregate or a bare `SELECT 1`). Neither identity works for the other grid, so the components
 * stay separate. What they share is this decision table, and it was written twice, verbatim, before
 * it lived here — which is exactly how the two drift: the "Shift does not move the anchor" rule
 * below is a judgement call, and a judgement call needs one place to be read.
 *
 * Everything here is generic over the key type `K` and touches no DOM, so both callers pass their
 * own notion of a row key and the whole table is testable.
 */

export interface RowClickModifiers {
  shift: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS — the caller folds the two together. */
  ctrl: boolean;
}

export interface RowSelectionState<K> {
  rows: ReadonlySet<K>;
  /** The row a Shift+click measures its range from. `null` before anything has been clicked. */
  anchor: K | null;
}

/**
 * Plain click selects one row, Ctrl/Cmd toggles one, Shift extends from the anchor.
 *
 * Shift deliberately leaves the anchor where it is, so holding Shift and clicking around resizes
 * ONE range instead of chaining ranges end to end. Ctrl does move it, because the row just toggled
 * is what the next Shift should measure from.
 *
 * `ordered` is the rows as they appear on screen, which is what makes a Shift range mean the thing
 * the user sees. When the anchor is not in it — a re-sort or a filter dropped it out of view — this
 * falls through to a plain select rather than silently selecting nothing.
 */
export function resolveRowClick<K>(
  ordered: readonly K[],
  current: RowSelectionState<K>,
  clicked: K,
  mods: RowClickModifiers
): RowSelectionState<K> {
  if (mods.shift && current.anchor !== null) {
    const from = ordered.indexOf(current.anchor);
    const to = ordered.indexOf(clicked);
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      return { rows: new Set(ordered.slice(lo, hi + 1)), anchor: current.anchor };
    }
  }

  if (mods.ctrl) {
    const rows = new Set(current.rows);
    if (rows.has(clicked)) rows.delete(clicked);
    else rows.add(clicked);
    return { rows, anchor: clicked };
  }

  return { rows: new Set([clicked]), anchor: clicked };
}

/**
 * What a right-click does to the selection: nothing, when the row it landed on is already part of
 * it. Right-clicking inside a selection to reach "copy" must not first throw that selection away —
 * that is the one interaction where clearing it destroys exactly what the user was about to act on.
 * On a row outside the selection it behaves like a plain click.
 *
 * The kept selection is returned by REFERENCE, so a caller storing it in React state re-renders
 * only when the selection actually changed.
 */
export function resolveRowContextMenu<K>(
  current: RowSelectionState<K>,
  clicked: K
): RowSelectionState<K> {
  return {
    rows: current.rows.has(clicked) ? current.rows : new Set([clicked]),
    anchor: clicked,
  };
}
