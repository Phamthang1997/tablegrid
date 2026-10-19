// The notebook's cells, and the `.tgnb` file they are shared as.
//
// Only the SOURCE is stored — in the tab (localStorage, like a query tab's draft) and in the
// file. Results are not: they are the database's answer at one moment, they can be large, and a
// file handed to a colleague should not carry another person's data along with the queries.

import { nextRowId } from './rowIds';

export type NotebookCellKind = 'sql' | 'md';

export interface NotebookCell {
  /** A React key, minted when the cell is created (`rowIds.ts`); never written to a file. */
  id: number;
  kind: NotebookCellKind;
  /** SQL cells only: what other cells call it in `:name.column`. */
  name?: string;
  source: string;
}

export const NOTEBOOK_FORMAT = 'tablegrid-notebook';
export const NOTEBOOK_VERSION = 1;
export const NOTEBOOK_EXTENSION = 'tgnb';

/** A cell name that `:name.column` can spell (see notebookRefs.ts). */
export function isValidCellName(name: string): boolean {
  return /^[A-Za-z_]\w{0,39}$/.test(name);
}

/** The first `q<n>` no cell uses yet. */
export function nextCellName(cells: Pick<NotebookCell, 'name'>[]): string {
  const taken = new Set(cells.map((c) => c.name?.toLowerCase()).filter(Boolean));
  for (let n = 1; ; n++) if (!taken.has(`q${n}`)) return `q${n}`;
}

export function newCell(kind: NotebookCellKind, cells: Pick<NotebookCell, 'name'>[], source = ''): NotebookCell {
  return kind === 'sql'
    ? { id: nextRowId(), kind, name: nextCellName(cells), source }
    : { id: nextRowId(), kind, source };
}

/** SQL cells whose name another SQL cell also has (case-insensitive). */
export function duplicateNames(cells: NotebookCell[]): Set<string> {
  const seen = new Map<string, number>();
  for (const c of cells) {
    if (c.kind !== 'sql' || !c.name) continue;
    const k = c.name.toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

/** What a tab stores: cells without their React key. */
export type StoredCell = Omit<NotebookCell, 'id'>;

export function toStored(cells: NotebookCell[]): StoredCell[] {
  return cells.map(({ id: _id, ...rest }) => rest);
}

/** Stored cells back into live ones; anything malformed is dropped rather than failing the tab. */
export function fromStored(stored: unknown): NotebookCell[] {
  if (!Array.isArray(stored)) return [];
  const out: NotebookCell[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if ((r.kind !== 'sql' && r.kind !== 'md') || typeof r.source !== 'string') continue;
    if (r.kind === 'sql') {
      const name = typeof r.name === 'string' && isValidCellName(r.name) ? r.name : nextCellName(out);
      out.push({ id: nextRowId(), kind: 'sql', name, source: r.source });
    } else {
      out.push({ id: nextRowId(), kind: 'md', source: r.source });
    }
  }
  return out;
}

/** A new notebook: a short note and one SQL cell, so the reference syntax is visible at once. */
export function starterCells(intro: string): NotebookCell[] {
  const md = newCell('md', [], intro);
  return [md, newCell('sql', [])];
}

export function serializeNotebook(cells: NotebookCell[], title?: string): string {
  return (
    JSON.stringify(
      { format: NOTEBOOK_FORMAT, version: NOTEBOOK_VERSION, ...(title ? { title } : {}), cells: toStored(cells) },
      null,
      2,
    ) + '\n'
  );
}

export type ParsedNotebook =
  | { ok: true; cells: NotebookCell[]; title?: string; dropped: number }
  | { ok: false; reason: 'json' | 'format' | 'version' };

/**
 * Reads a `.tgnb` file. A file of another shape is refused whole; a malformed cell inside a valid
 * file is dropped and counted, so one bad cell does not cost the rest.
 */
export function parseNotebook(text: string): ParsedNotebook {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!data || typeof data !== 'object') return { ok: false, reason: 'format' };
  const d = data as Record<string, unknown>;
  if (d.format !== NOTEBOOK_FORMAT || !Array.isArray(d.cells)) return { ok: false, reason: 'format' };
  if (typeof d.version !== 'number' || d.version > NOTEBOOK_VERSION) return { ok: false, reason: 'version' };
  const cells = fromStored(d.cells);
  return { ok: true, cells, title: typeof d.title === 'string' ? d.title : undefined, dropped: d.cells.length - cells.length };
}
