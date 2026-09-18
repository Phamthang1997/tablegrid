/**
 * ER Diagram Layout Persistence.
 * Saves and restores custom user-dragged table node coordinates in localStorage.
 *
 * The scope string comes from `utils/connKey.ts` (see the note there), NOT from a `conn_id`:
 * that id is a fresh random UUID per connect, so keying on it meant a hand-arranged diagram was
 * never found again after a reconnect while localStorage grew one dead entry per session.
 */

import type { ERLayoutPositions } from './erTypes';

const STORAGE_PREFIX = 'tablegrid:er-layout';
const HIDDEN_PREFIX = 'tablegrid:er-hidden';

/** `scope` identifies the server, `database`/`schema` the diagram drawn from it. */
function keyFor(prefix: string, scope: string, database?: string, schema?: string): string {
  const dbPart = database ? database.trim() : 'default';
  const schPart = schema ? schema.trim() : 'public';
  return `${prefix}:${scope || 'unknown'}:${dbPart}:${schPart}`;
}

export function erLayoutKey(scope: string, database?: string, schema?: string): string {
  return keyFor(STORAGE_PREFIX, scope, database, schema);
}

/**
 * The companion key for the table picker. Same scope as the layout, separate entry: a diagram
 * whose selection is untouched must not rewrite its (much larger) positions blob, and clearing
 * one has no business clearing the other.
 */
export function erHiddenKey(scope: string, database?: string, schema?: string): string {
  return keyFor(HIDDEN_PREFIX, scope, database, schema);
}

export function loadSavedLayout(key: string): ERLayoutPositions | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ERLayoutPositions;
  } catch (err) {
    console.warn('Failed to load ER layout positions from storage:', err);
    return null;
  }
}

export function saveCurrentLayout(key: string, positions: ERLayoutPositions): void {
  try {
    localStorage.setItem(key, JSON.stringify(positions));
  } catch (err) {
    console.warn('Failed to persist ER layout positions:', err);
  }
}

export function clearSavedLayout(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    console.warn('Failed to clear saved ER layout:', err);
  }
}

/**
 * The tables the user has switched OFF in the picker — the hidden ones, never the shown ones.
 *
 * That direction is the whole decision: a table created after the selection was saved has to
 * appear on its own, and a stored "shown" list would silently swallow it. It also means an
 * untouched diagram stores nothing at all.
 */
export function loadHiddenTables(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((name): name is string => typeof name === 'string');
  } catch (err) {
    console.warn('Failed to load ER hidden tables from storage:', err);
    return [];
  }
}

export function saveHiddenTables(key: string, names: string[]): void {
  try {
    // Nothing hidden is the default, so it is stored as the absence of the entry rather than as
    // an empty array — otherwise every diagram ever opened leaves a row behind.
    if (names.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(names));
  } catch (err) {
    console.warn('Failed to persist ER hidden tables:', err);
  }
}
