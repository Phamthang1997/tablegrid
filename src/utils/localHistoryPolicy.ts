/**
 * The decisions behind the SQL editor's local history — WHEN a snapshot is taken and WHICH ones
 * are thrown away. Pure, so it is unit-tested; the IndexedDB store in `localHistory.ts` applies it.
 *
 * What it protects against: a query tab is a draft in localStorage, not a file, so there has been
 * no way back from overwriting a long statement, pasting over it, pressing Clear (which bypassed
 * Monaco's undo stack) or closing the tab. Query history only holds what was RUN.
 */

export type SnapshotReason =
  /** The pane's text when a statement from it was run. */
  | 'run'
  /** Periodic, while editing. */
  | 'edit'
  /** The text just before a large deletion. */
  | 'beforeDelete'
  /** The text just before Clear / Paste / Restore replaced it wholesale. */
  | 'beforeReplace'
  /** The text when the tab was closed. */
  | 'close';

export interface SnapshotMeta {
  ts: number;
  text: string;
}

/** An edit snapshot at most this often, however long the user keeps typing. */
export const EDIT_INTERVAL_MS = 2 * 60 * 1000;
/** Kept per pane; older ones go first. */
export const MAX_PER_DOC = 60;
/** Nothing older than this survives a prune. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Budget for the whole store, in UTF-16 code units (what IndexedDB holds a JS string as). */
export const MAX_TOTAL_CHARS = 12 * 1024 * 1024;
/**
 * A pane holding more than this is not snapshotted: that is a pasted dump, not a query somebody
 * is writing, and sixty copies of it would evict every other tab's history.
 */
export const MAX_SNAPSHOT_CHARS = 1024 * 1024;

/** A deletion this large (absolute or relative) gets the text before it saved. */
const BIG_DELETE_CHARS = 400;
const BIG_DELETE_RATIO = 0.4;

export function isBigDeletion(before: string, after: string): boolean {
  const lost = before.length - after.length;
  if (lost <= 0) return false;
  return lost >= BIG_DELETE_CHARS || (before.length >= 80 && lost / before.length >= BIG_DELETE_RATIO);
}

/**
 * Which snapshots an edit flush produces. `prev` is the text of the previous flush (what was on
 * screen a moment ago), `last` the newest stored snapshot of this pane.
 *
 * The before-deletion case saves `prev`, not `next`: the point is the text that just disappeared.
 */
export function decideEditSnapshots(
  last: SnapshotMeta | null,
  prev: string | null,
  next: string,
  now: number,
): { text: string; reason: SnapshotReason }[] {
  const out: { text: string; reason: SnapshotReason }[] = [];
  if (prev !== null && isBigDeletion(prev, next) && prev.trim() !== '' && prev !== last?.text) {
    out.push({ text: prev, reason: 'beforeDelete' });
    return out;
  }
  if (next.trim() === '' || next === last?.text) return out;
  if (!last || now - last.ts >= EDIT_INTERVAL_MS) out.push({ text: next, reason: 'edit' });
  return out;
}

/** Whether a snapshot of `text` is worth storing at all, given the newest one of the same pane. */
export function worthStoring(last: SnapshotMeta | null, text: string): boolean {
  if (text.trim() === '' || text.length > MAX_SNAPSHOT_CHARS) return false;
  return text !== last?.text;
}

export interface PruneEntry {
  id: number;
  doc: string;
  ts: number;
  chars: number;
}

/**
 * Ids to delete: everything past `MAX_AGE_MS`, everything past `MAX_PER_DOC` in its pane, then
 * the oldest remaining until the store fits `MAX_TOTAL_CHARS`. Newest first survives every rule.
 */
export function pruneIds(entries: readonly PruneEntry[], now: number): number[] {
  const drop = new Set<number>();
  const newestFirst = [...entries].sort((a, b) => b.ts - a.ts);
  const perDoc = new Map<string, number>();
  for (const e of newestFirst) {
    if (now - e.ts > MAX_AGE_MS) { drop.add(e.id); continue; }
    const n = (perDoc.get(e.doc) ?? 0) + 1;
    perDoc.set(e.doc, n);
    if (n > MAX_PER_DOC) drop.add(e.id);
  }
  let total = 0;
  for (const e of newestFirst) {
    if (drop.has(e.id)) continue;
    total += e.chars;
    if (total > MAX_TOTAL_CHARS) drop.add(e.id);
  }
  return [...drop];
}

/** The first line with content, for the snapshot list. */
export function snapshotTitle(text: string, max = 80): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Lines added / removed going from `from` to `to`, by multiset of lines — cheap and order-blind,
 * which is enough for a "+12 −3" badge; the dialog's diff view is where the real diff is.
 */
export function lineDelta(from: string, to: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const l of from.split('\n')) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of to.split('\n')) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}
