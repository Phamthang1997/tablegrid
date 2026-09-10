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

/** `scope` identifies the server, `database`/`schema` the diagram drawn from it. */
export function erLayoutKey(scope: string, database?: string, schema?: string): string {
  const dbPart = database ? database.trim() : 'default';
  const schPart = schema ? schema.trim() : 'public';
  return `${STORAGE_PREFIX}:${scope || 'unknown'}:${dbPart}:${schPart}`;
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
