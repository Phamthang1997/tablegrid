import { describe, expect, it } from 'vitest';
import { buildLockTree, findCycles, type LockEdge, type LockGraph, type LockSession } from '../lockTree';

const s = (id: string, over: Partial<LockSession> = {}): LockSession => ({
  id, user: 'app', db: 'sakila', state: 'active', query: `q${id}`, txSeconds: 0, stateSeconds: 0, waitEvent: '', ...over,
});
const e = (waiting: string, blocking: string, over: Partial<LockEdge> = {}): LockEdge => ({
  waiting, blocking, lockType: 'RECORD', object: 'sakila.film', mode: 'X', waitSeconds: 3, ...over,
});
const graph = (sessions: LockSession[], edges: LockEdge[]): LockGraph => ({ dialect: 'mysql', sessions, edges, deadlock: null, note: null });

describe('buildLockTree', () => {
  it('roots a chain at the session that waits for nobody, and counts what is stuck behind it', () => {
    // 1 holds; 2 waits for 1; 3 and 4 wait for 2.
    const t = buildLockTree(graph([s('1', { state: 'Sleep', txSeconds: 900 }), s('2'), s('3'), s('4')], [e('2', '1'), e('3', '2'), e('4', '2')]));
    expect(t.roots.map((r) => r.session.id)).toEqual(['1']);
    expect(t.roots[0].blockedCount).toBe(3);
    expect(t.roots[0].children[0].session.id).toBe('2');
    expect(t.roots[0].children[0].blockedCount).toBe(2);
    expect(t.roots[0].children[0].waitsFor?.object).toBe('sakila.film');
    expect(t.waitingTotal).toBe(3);
    expect(t.cycles).toEqual([]);
  });

  it('counts a session waiting on two blockers once, and orders roots by impact', () => {
    const t = buildLockTree(graph([s('1'), s('2'), s('3'), s('4')], [e('3', '1'), e('3', '2'), e('4', '2')]));
    expect(t.roots.map((r) => [r.session.id, r.blockedCount])).toEqual([['2', 2], ['1', 1]]);
    expect(t.waitingTotal).toBe(2);
  });

  it('reports a ring of waiters as a cycle and still shows it', () => {
    const t = buildLockTree(graph([s('1'), s('2'), s('3')], [e('1', '2'), e('2', '1'), e('3', '1')]));
    expect(t.cycles).toEqual([['1', '2']]);
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0].inCycle).toBe(true);
    // The tree does not loop forever through the ring.
    expect(t.roots[0].blockedCount).toBe(2);
  });

  it('shows a queue as one chain: each session once, under its deepest blocker', () => {
    // MySQL: 29 holds a row; 30 waits for the row; 31 (ALTER) waits for both; 32 (SELECT) for all three.
    const edges = [e('30', '29'), e('31', '29'), e('31', '30'), e('32', '29'), e('32', '30'), e('32', '31')];
    const t = buildLockTree(graph(['29', '30', '31', '32'].map((id) => s(id)), edges));
    expect(t.roots).toHaveLength(1);
    const chain: string[] = [];
    for (let n = t.roots[0]; n; n = n.children[0]) {
      chain.push(n.session.id);
      if (n.children.length > 1) throw new Error('a session is shown twice');
    }
    expect(chain).toEqual(['29', '30', '31', '32']);
    const last = t.roots[0].children[0].children[0].children[0];
    expect(last.waitsFor?.blocking).toBe('31');
    expect(last.alsoWaitsFor.sort()).toEqual(['29', '30']);
    expect(t.roots[0].blockedCount).toBe(3);
    expect(t.roots[0].alsoWaitsFor).toEqual([]);
  });

  it('collapses a pair reported twice and ignores self-edges', () => {
    const t = buildLockTree(graph([s('1'), s('2')], [e('2', '1'), e('2', '1', { lockType: 'METADATA' }), e('1', '1')]));
    expect(t.roots[0].children).toHaveLength(1);
  });

  it('fills in a blocker the session list did not carry', () => {
    const t = buildLockTree(graph([s('2')], [e('2', '99')]));
    expect(t.roots[0].session.id).toBe('99');
    expect(t.roots[0].session.query).toBe('');
  });

  it('is empty when nothing waits', () => {
    expect(buildLockTree(graph([s('1')], []))).toEqual({ roots: [], cycles: [], waitingTotal: 0 });
  });
});

describe('findCycles', () => {
  it('finds each ring once, whatever member it is found from', () => {
    expect(findCycles([e('a', 'b'), e('b', 'c'), e('c', 'a')])).toEqual([['a', 'b', 'c']]);
    expect(findCycles([e('a', 'b'), e('b', 'c')])).toEqual([]);
  });
});
