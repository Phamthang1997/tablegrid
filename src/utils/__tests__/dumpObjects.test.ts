import { describe, it, expect } from 'vitest';
import {
  buildDumpObjects,
  keysWithTriggers,
  objKey,
  splitSelection,
  triggerKeysOf,
  type DumpObj,
} from '../dumpObjects';

const tables = [
  { name: 'actor' },
  { name: 'film' },
  { name: 'actor_info', type: 'view' },
];
const objects = {
  functions: ['get_customer_balance'],
  procedures: ['film_in_stock'],
  events: ['nightly_cleanup'],
};
const triggers = [
  { name: 'ins_film', table: 'film' },
  { name: 'upd_film', table: 'FILM' },
  { name: 'ins_actor', table: 'actor' },
];

describe('buildDumpObjects', () => {
  it('tells a view from a table by `type`, not by a second call', () => {
    const all = buildDumpObjects(tables, objects, triggers);
    expect(all.find((o) => o.name === 'actor_info')?.kind).toBe('view');
    expect(all.find((o) => o.name === 'film')?.kind).toBe('table');
  });

  it('carries every kind, with each trigger keeping its owning table', () => {
    const all = buildDumpObjects(tables, objects, triggers);
    expect(all.map((o) => o.kind)).toEqual([
      'table', 'table', 'view', 'function', 'procedure', 'event', 'trigger', 'trigger', 'trigger',
    ]);
    expect(all.find((o) => o.name === 'ins_film')?.table).toBe('film');
  });

  it('keys by kind AND name, because a name alone does not identify an object', () => {
    // A database may hold a table and a trigger of the same name; keyed by name they would collapse
    // into one row and ticking either would tick both.
    const clash = buildDumpObjects(
      [{ name: 'payment' }],
      { functions: [], procedures: [], events: [] },
      [{ name: 'payment', table: 'payment' }],
    );
    expect(clash.map(objKey)).toEqual(['table:payment', 'trigger:payment']);
  });
});

describe('keysWithTriggers', () => {
  const all = buildDumpObjects(tables, objects, triggers);

  it('matches the owning table case-insensitively, as SQL does', () => {
    // `upd_film` is declared on `FILM`; a case-sensitive compare would silently leave it behind.
    expect(triggerKeysOf(all, 'film').sort()).toEqual(['trigger:ins_film', 'trigger:upd_film']);
  });

  it('carries a table selection along to its triggers', () => {
    const film = all.filter((o) => o.name === 'film');
    expect(keysWithTriggers(all, film).sort()).toEqual([
      'table:film', 'trigger:ins_film', 'trigger:upd_film',
    ]);
  });

  it('adds nothing for a view or a routine, which own no trigger', () => {
    const view = all.filter((o) => o.kind === 'view');
    expect(keysWithTriggers(all, view)).toEqual(['view:actor_info']);
  });
});

describe('splitSelection', () => {
  const all = buildDumpObjects(tables, objects, triggers);

  it('keeps views inside `tables` as well, which is the contract buildDump takes', () => {
    const out = splitSelection(all);
    expect(out.tables).toEqual(['actor', 'film', 'actor_info']);
    expect(out.views).toEqual(['actor_info']);
  });

  it('splits routines by kind and keeps events apart', () => {
    const out = splitSelection(all);
    expect(out.routines).toEqual([
      { name: 'get_customer_balance', kind: 'function' },
      { name: 'film_in_stock', kind: 'procedure' },
    ]);
    expect(out.events).toEqual(['nightly_cleanup']);
    expect(out.triggers).toEqual(['ins_film', 'upd_film', 'ins_actor']);
  });

  it('returns empty arrays rather than undefined for an empty selection', () => {
    const out = splitSelection([] as DumpObj[]);
    expect(out).toEqual({ tables: [], views: [], routines: [], triggers: [], events: [] });
  });
});
