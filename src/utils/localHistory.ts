/**
 * The SQL editor's local history store: snapshots of each query pane's text, in IndexedDB.
 *
 * IndexedDB rather than localStorage, deliberately: the tab drafts are already the largest thing in
 * localStorage (App.tsx retries without inactive drafts on `QuotaExceededError`), and sixty copies
 * of each would push them out. IndexedDB's quota is a share of the disk, and it is async, so a
 * snapshot never blocks a keystroke.
 *
 * When to snapshot and what to prune is decided in `localHistoryPolicy.ts` (pure, tested); this
 * module only stores. Every call swallows its errors: history is a safety net, and a broken net
 * must never break the editor it hangs under — an unavailable IndexedDB (private mode, a blocked
 * profile) just means no history.
 */
import {
  decideEditSnapshots,
  pruneIds,
  worthStoring,
  type PruneEntry,
  type SnapshotMeta,
  type SnapshotReason,
} from './localHistoryPolicy';

export interface HistorySnapshot {
  id: number;
  /** One pane of one tab: `<scope>|<tabId>|<pane>`. */
  doc: string;
  /** Server + database: `<connKey>|<dbName>` — what "this database's other tabs" filters on. */
  scope: string;
  tabId: string;
  pane: 1 | 2;
  ts: number;
  reason: SnapshotReason;
  text: string;
}

export interface HistoryTarget {
  scope: string;
  tabId: string;
  pane: 1 | 2;
}

const DB_NAME = 'tablegrid-local-history';
const STORE = 'snapshots';
/** Prune once every this many writes rather than on each one: a prune reads every row's metadata. */
const PRUNE_EVERY = 25;

export const docKey = (t: HistoryTarget) => `${t.scope}|${t.tabId}|${t.pane}`;
export const historyScope = (connKey: string, dbName: string) => `${connKey}|${dbName}`;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('doc', 'doc');
        store.createIndex('scope', 'scope');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The newest snapshot of each pane, cached so an edit flush does not query IndexedDB each time. */
const lastByDoc = new Map<string, SnapshotMeta | null>();
let writesSincePrune = 0;

async function lastOf(db: IDBDatabase, doc: string): Promise<SnapshotMeta | null> {
  if (lastByDoc.has(doc)) return lastByDoc.get(doc) ?? null;
  const rows = await done(db.transaction(STORE).objectStore(STORE).index('doc').getAll(doc)) as HistorySnapshot[];
  const newest = rows.reduce<HistorySnapshot | null>((a, b) => (!a || b.ts > a.ts ? b : a), null);
  const meta = newest ? { ts: newest.ts, text: newest.text } : null;
  lastByDoc.set(doc, meta);
  return meta;
}

async function put(db: IDBDatabase, target: HistoryTarget, text: string, reason: SnapshotReason): Promise<void> {
  const doc = docKey(target);
  const ts = Date.now();
  await done(db.transaction(STORE, 'readwrite').objectStore(STORE).add({
    doc, scope: target.scope, tabId: target.tabId, pane: target.pane, ts, reason, text,
  }));
  lastByDoc.set(doc, { ts, text });
  notify();
  if (++writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0;
    void prune(db);
  }
}

async function prune(db: IDBDatabase): Promise<void> {
  try {
    const entries: PruneEntry[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        const v = cur.value as HistorySnapshot;
        entries.push({ id: v.id, doc: v.doc, ts: v.ts, chars: v.text.length });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    const ids = pruneIds(entries, Date.now());
    if (ids.length === 0) return;
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const id of ids) store.delete(id);
    lastByDoc.clear();
    notify();
  } catch {
    // A failed prune only means the store stays larger until the next one.
  }
}

/** Stores `text` as a snapshot unless it duplicates the pane's newest one (run, close, replace). */
export async function recordSnapshot(target: HistoryTarget, text: string, reason: SnapshotReason): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    if (!worthStoring(await lastOf(db, docKey(target)), text)) return;
    await put(db, target, text, reason);
  } catch {
    // See the module comment: history must never break editing.
  }
}

/** An edit flush: `prev` is the previous flush's text. The policy decides whether anything is stored. */
export async function recordEdit(target: HistoryTarget, prev: string | null, next: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const last = await lastOf(db, docKey(target));
    // The policy yields at most one snapshot per flush (the before-deletion case returns early).
    const [snap] = decideEditSnapshots(last, prev, next, Date.now());
    if (snap && worthStoring(last, snap.text)) await put(db, target, snap.text, snap.reason);
  } catch {
    // See the module comment.
  }
}

/** Newest first. */
export async function listForDoc(target: HistoryTarget): Promise<HistorySnapshot[]> {
  try {
    const db = await openDb();
    if (!db) return [];
    const rows = await done(db.transaction(STORE).objectStore(STORE).index('doc').getAll(docKey(target))) as HistorySnapshot[];
    return rows.sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/** Every pane of every tab on this server + database — closed tabs included. Newest first. */
export async function listForScope(scope: string, limit = 300): Promise<HistorySnapshot[]> {
  try {
    const db = await openDb();
    if (!db) return [];
    const rows = await done(db.transaction(STORE).objectStore(STORE).index('scope').getAll(scope)) as HistorySnapshot[];
    return rows.sort((a, b) => b.ts - a.ts).slice(0, limit);
  } catch {
    return [];
  }
}

export async function deleteSnapshot(id: number): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    await done(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
    lastByDoc.clear();
    notify();
  } catch {
    // Nothing to recover: the row stays and the list shows it again.
  }
}

export async function clearDoc(target: HistoryTarget): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const rows = await listForDoc(target);
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const r of rows) store.delete(r.id);
    lastByDoc.delete(docKey(target));
    notify();
  } catch {
    // As above.
  }
}

// An open history dialog refreshes when a snapshot lands (a Run while it is open, for instance).
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
export function subscribeHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
