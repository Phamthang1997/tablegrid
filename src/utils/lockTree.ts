// Builds the Process Monitor's Lock Tree from the edges `get_lock_graph` reports
// (database/commands/locks.rs): "session W waits for session B". Pure and tested.
//
// A ROOT is a session that blocks others while waiting for nobody — the one a "kill" actually
// frees. Sessions waiting on each other in a ring have no root; they are reported as a cycle,
// which on MySQL and Postgres is a deadlock the server is about to break by rolling one back.
//
// Each waiting session appears ONCE, under its DEEPEST blocker: an ALTER waiting for both the
// transaction holding a row and the UPDATE queued on that row goes under the UPDATE, so a queue
// reads as the chain it is (29 → 30 → 31 → 32) rather than the same session repeated under every
// session it waits for. The other blockers are kept on the node (`alsoWaitsFor`), and
// `blockedCount` is counted on the whole graph, not on the tree.

export interface LockSession {
  id: string;
  user: string;
  db: string;
  state: string;
  query: string;
  txSeconds: number;
  stateSeconds: number;
  waitEvent: string;
}

export interface LockEdge {
  waiting: string;
  blocking: string;
  lockType: string;
  object: string;
  mode: string;
  waitSeconds: number;
}

export interface LockGraph {
  dialect: string;
  sessions: LockSession[];
  edges: LockEdge[];
  deadlock: string | null;
  /** `noLockInfo` (the server's lock tables cannot be read), `embedded` (SQLite/DuckDB), or null. */
  note: string | null;
}

export interface LockNode {
  session: LockSession;
  /** The edge to this node's parent in the tree (what it waits for); null on a root. */
  waitsFor: LockEdge | null;
  /** The other sessions it also waits for, besides its parent. */
  alsoWaitsFor: string[];
  children: LockNode[];
  /** Distinct sessions stuck behind this one, directly or transitively (whole graph). */
  blockedCount: number;
  /** This root is a member of a waiting cycle (a deadlock in progress). */
  inCycle: boolean;
}

export interface LockTree {
  roots: LockNode[];
  /** Each cycle as the session ids around it. */
  cycles: string[][];
  /** Distinct sessions waiting on anyone. */
  waitingTotal: number;
}

const MAX_DEPTH = 64;

function placeholder(id: string): LockSession {
  return { id, user: '', db: '', state: '', query: '', txSeconds: 0, stateSeconds: 0, waitEvent: '' };
}

/** Rings in the waits-for graph, each reported once. */
export function findCycles(edges: LockEdge[]): string[][] {
  const out = new Map<string, string[]>();
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.waiting, [...(next.get(e.waiting) ?? []), e.blocking]);
  const walk = (start: string, at: string, path: string[], seen: Set<string>) => {
    for (const n of next.get(at) ?? []) {
      if (n === start) {
        // Normalized so the same ring found from another member is one ring.
        const ring = [...path];
        const min = ring.indexOf([...ring].sort()[0]);
        const norm = [...ring.slice(min), ...ring.slice(0, min)];
        out.set(norm.join('>'), norm);
      } else if (!seen.has(n) && path.length < MAX_DEPTH) {
        seen.add(n);
        walk(start, n, [...path, n], seen);
        seen.delete(n);
      }
    }
  };
  for (const id of next.keys()) walk(id, id, [id], new Set([id]));
  return [...out.values()];
}

export function buildLockTree(graph: LockGraph): LockTree {
  const sessions = new Map(graph.sessions.map((s) => [s.id, s]));
  const session = (id: string) => sessions.get(id) ?? placeholder(id);

  // One edge per (waiting, blocking) pair: a row lock and a metadata lock on the same pair are one wait.
  const edges: LockEdge[] = [];
  const seenPair = new Set<string>();
  for (const e of graph.edges) {
    if (e.waiting === e.blocking) continue;
    const pair = `${e.waiting}>${e.blocking}`;
    if (seenPair.has(pair)) continue;
    seenPair.add(pair);
    edges.push(e);
  }
  const blockersOf = new Map<string, LockEdge[]>();
  const waitersOf = new Map<string, string[]>();
  for (const e of edges) {
    blockersOf.set(e.waiting, [...(blockersOf.get(e.waiting) ?? []), e]);
    waitersOf.set(e.blocking, [...(waitersOf.get(e.blocking) ?? []), e.waiting]);
  }
  const waiting = new Set(blockersOf.keys());
  const cycles = findCycles(edges);
  const inCycle = new Set(cycles.flat());

  // Depth = the longest chain of waits above a session (0 for a root). Cycle members stop the
  // recursion where they close the ring.
  const depthMemo = new Map<string, number>();
  const depth = (id: string, stack: Set<string>): number => {
    const known = depthMemo.get(id);
    if (known !== undefined) return known;
    if (stack.has(id) || stack.size > MAX_DEPTH) return 0;
    stack.add(id);
    let d = 0;
    for (const e of blockersOf.get(id) ?? []) d = Math.max(d, 1 + depth(e.blocking, stack));
    stack.delete(id);
    depthMemo.set(id, d);
    return d;
  };

  // Everything stuck behind a session, on the whole graph.
  const behind = (id: string): number => {
    const seen = new Set<string>();
    const stack = [...(waitersOf.get(id) ?? [])];
    while (stack.length) {
      const w = stack.pop()!;
      if (w === id || seen.has(w)) continue;
      seen.add(w);
      stack.push(...(waitersOf.get(w) ?? []));
    }
    return seen.size;
  };

  // The tree parent: the deepest blocker (ties: the first reported).
  const parentEdge = new Map<string, LockEdge>();
  for (const [id, list] of blockersOf) {
    let best = list[0];
    let bestDepth = -1;
    for (const e of list) {
      const d = depth(e.blocking, new Set([id]));
      if (d > bestDepth) {
        best = e;
        bestDepth = d;
      }
    }
    parentEdge.set(id, best);
  }
  const childrenOf = new Map<string, string[]>();
  for (const [id, e] of parentEdge) childrenOf.set(e.blocking, [...(childrenOf.get(e.blocking) ?? []), id]);

  const build = (id: string, path: Set<string>): LockNode => {
    const via = path.size > 1 ? parentEdge.get(id) ?? null : null;
    const children: LockNode[] = [];
    for (const c of childrenOf.get(id) ?? []) {
      if (path.has(c) || path.size > MAX_DEPTH) continue;
      path.add(c);
      children.push(build(c, path));
      path.delete(c);
    }
    return {
      session: session(id),
      waitsFor: via,
      alsoWaitsFor: (blockersOf.get(id) ?? []).map((e) => e.blocking).filter((b) => b !== via?.blocking && path.size > 1),
      children,
      blockedCount: behind(id),
      inCycle: inCycle.has(id),
    };
  };

  const rootIds = [...waitersOf.keys()].filter((id) => !waiting.has(id));
  // A ring has no root: one member of each stands in for it, so it is still shown.
  for (const ring of cycles) {
    if (!ring.some((id) => rootIds.includes(id))) rootIds.push(ring[0]);
  }
  const roots = rootIds.map((id) => build(id, new Set([id])));
  roots.sort((a, b) => b.blockedCount - a.blockedCount || b.session.txSeconds - a.session.txSeconds || a.session.id.localeCompare(b.session.id));
  return { roots, cycles, waitingTotal: waiting.size };
}
