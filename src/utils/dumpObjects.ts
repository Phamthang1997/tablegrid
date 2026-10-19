/**
 * The set of objects a dump can carry, and the rules for selecting them.
 *
 * Extracted from `ExportDatabaseDialog` when `CopyDatabaseDialog` arrived: both build the same list
 * from the same three backend calls, group it the same way, and have to split the selection into the
 * exact shape `buildDump` takes. Only the **pure** part lives here — the fetching and the JSX stay in
 * each dialog, which is the same line `rowSelection.ts` and `copyAs.ts` sit on. A shared *component*
 * would have to carry both dialogs' very different halves (a file name and a format on one side, two
 * connections and a dialect guard on the other) behind flags.
 *
 * `objKey` is why this is worth sharing at all: a name does NOT identify an object. One database can
 * hold a table `payment` and a trigger `payment` at once, and each kind is written into the dump
 * differently.
 */

/** `table` is the default case and carries data; everything else is a definition. */
export type DumpObjKind = 'table' | 'view' | 'function' | 'procedure' | 'trigger' | 'event';

export interface DumpObj {
  name: string;
  kind: DumpObjKind;
  /** The trigger's owning table (present only when `kind === 'trigger'`). */
  table?: string;
}

export const objKey = (o: DumpObj) => `${o.kind}:${o.name}`;

/**
 * The order of the groups in the list, which is also the order they are written into the dump.
 *
 * The list is grouped rather than flat: a database the size of sakila has two dozen tables ahead of
 * everything else, so routines and triggers fall below the fold and the user assumes they are not
 * being included.
 */
export const KIND_ORDER = ['table', 'view', 'function', 'procedure', 'event', 'trigger'] as const;

/** Translation keys for the group headings and badges; resolved with `t()` at the call site. */
export const KIND_LABEL_KEY = {
  table: 'exportDialog.tableBadge',
  view: 'exportDialog.viewBadge',
  function: 'exportDialog.funcBadge',
  procedure: 'exportDialog.procBadge',
  trigger: 'exportDialog.triggerBadge',
  event: 'exportDialog.eventBadge',
} as const satisfies Record<DumpObjKind, string>;

/** Routines and triggers can only go into a .sql dump — the other formats are table data. */
export const isSqlOnlyKind = (k: DumpObjKind) => k !== 'table' && k !== 'view';

/** What `getTables` returns, narrowed to the two fields this module reads. */
export interface DumpSourceTable {
  name: string;
  type?: string;
}

/** What `getDatabaseObjects` returns, narrowed the same way. `events` is empty off MySQL. */
export interface DumpSourceObjects {
  functions: string[];
  procedures: string[];
  events: string[];
}

/** What `getAllTriggers` returns. `table` is the trigger's owning table. */
export interface DumpSourceTrigger {
  name: string;
  table: string;
}

/**
 * The full object list, in `KIND_ORDER`.
 *
 * A view is told from a table by `type`, not by a separate call: `getTables` already returns both
 * and marks which is which.
 */
export function buildDumpObjects(
  tables: DumpSourceTable[],
  objects: DumpSourceObjects,
  triggers: DumpSourceTrigger[],
): DumpObj[] {
  const viewSet = new Set(tables.filter((item) => item.type === 'view').map((item) => item.name));
  return [
    ...tables.map((item) => ({
      name: item.name,
      kind: viewSet.has(item.name) ? ('view' as const) : ('table' as const),
    })),
    ...objects.functions.map((name) => ({ name, kind: 'function' as const })),
    ...objects.procedures.map((name) => ({ name, kind: 'procedure' as const })),
    ...objects.events.map((name) => ({ name, kind: 'event' as const })),
    ...triggers.map((tr) => ({ name: tr.name, kind: 'trigger' as const, table: tr.table })),
  ];
}

/** The keys of every trigger owned by `tableName`, compared case-insensitively as SQL does. */
export function triggerKeysOf(objects: DumpObj[], tableName: string): string[] {
  const lowered = tableName.toLowerCase();
  return objects
    .filter((o) => o.kind === 'trigger' && (o.table || '').toLowerCase() === lowered)
    .map(objKey);
}

/**
 * The keys of `items`, plus the triggers of every table among them.
 *
 * A trigger follows its owning table because `mysqldump` exports them together by default, and it is
 * what the user expects: clearing everything and ticking exactly one table has to put that table's
 * triggers in the dump. Triggers still have rows of their own, so they can be unticked individually.
 */
export function keysWithTriggers(objects: DumpObj[], items: DumpObj[]): string[] {
  return [
    ...items.map(objKey),
    ...items.filter((o) => o.kind === 'table').flatMap((o) => triggerKeysOf(objects, o.name)),
  ];
}

/** The selection split into the shape `buildDump` takes. */
export interface DumpSelection {
  /** Tables **and** views: the old contract, where `views` merely marks which of these are views. */
  tables: string[];
  views: string[];
  routines: { name: string; kind: 'function' | 'procedure' }[];
  triggers: string[];
  events: string[];
}

export function splitSelection(chosen: DumpObj[]): DumpSelection {
  return {
    tables: chosen.filter((o) => o.kind === 'table' || o.kind === 'view').map((o) => o.name),
    views: chosen.filter((o) => o.kind === 'view').map((o) => o.name),
    routines: chosen
      .filter((o): o is DumpObj & { kind: 'function' | 'procedure' } =>
        o.kind === 'function' || o.kind === 'procedure')
      .map((o) => ({ name: o.name, kind: o.kind })),
    triggers: chosen.filter((o) => o.kind === 'trigger').map((o) => o.name),
    events: chosen.filter((o) => o.kind === 'event').map((o) => o.name),
  };
}
