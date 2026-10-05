// The Process Monitor's Lock Tree view: who blocks whom, rooted at the sessions a kill would free.
// Facts from `get_lock_graph` (database/commands/locks.rs), the tree from utils/lockTree.ts.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight, CircleCheck, Lock, Loader2, Skull, Square } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { dbHelper } from '../../utils/dbHelper';
import { buildLockTree, type LockGraph, type LockNode } from '../../utils/lockTree';
import './diagnostics.css';

function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const isIdle = (state: string) => /^(idle in transaction|sleep)$/i.test(state.trim());

export const LockTreeView: React.FC<{
  connId: string;
  /** The panel's auto-refresh period; 0 = paused. */
  intervalMs: number;
  /** After a kill, so the session list beside the tree refreshes too. */
  onChanged?: () => void;
}> = ({ connId, intervalMs, onChanged }) => {
  const { t } = useTranslation();
  const [graph, setGraph] = useState<LockGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [ask, setAsk] = useState<{ node: LockNode; action: 'kill' | 'cancel' } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showDeadlock, setShowDeadlock] = useState(false);

  const load = useCallback(async () => {
    try {
      setGraph(await dbHelper.getLockGraph(connId));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [connId]);

  useEffect(() => {
    // set-state-in-effect: async IPC on mount and on a timer — the state is the server's answer,
    // not something derivable from props.
    // eslint-disable-next-line react/set-state-in-effect
    void load();
    if (!intervalMs) return;
    const id = window.setInterval(() => void load(), intervalMs);
    return () => window.clearInterval(id);
  }, [load, intervalMs]);

  const tree = useMemo(() => (graph ? buildLockTree(graph) : null), [graph]);

  const run = async () => {
    if (!ask) return;
    const { node, action } = ask;
    setAsk(null);
    try {
      const res = action === 'kill'
        ? await dbHelper.killProcessConnection(node.session.id, connId)
        : await dbHelper.killProcessQuery(node.session.id, connId);
      setMessage(t('lockTree.done', { id: node.session.id, msg: res.message }));
    } catch (e) {
      setMessage(t('lockTree.done', { id: node.session.id, msg: String(e) }));
    }
    await load();
    onChanged?.();
  };

  const renderNode = (node: LockNode, depth: number, path: string): React.ReactNode => {
    const s = node.session;
    const key = `${path}/${s.id}`;
    const open = !collapsed.has(key);
    const isRoot = depth === 0;
    const toggle = () =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    return (
      <div key={key} className="lt-node">
        <div className={`lt-row${isRoot ? ' root' : ''}${node.inCycle ? ' cycle' : ''}`} style={{ paddingLeft: 10 + depth * 22 }}>
          <button type="button" className="lt-toggle" onClick={toggle} disabled={!node.children.length}>
            {node.children.length ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="lt-dot" />}
          </button>
          <span className="lt-id">{s.id}</span>
          <span className="lt-who">{[s.user, s.db].filter(Boolean).join('@')}</span>
          {isRoot && node.blockedCount > 0 && <span className="lt-badge">{t('lockTree.blocks', { n: node.blockedCount })}</span>}
          <span className="lt-state">{isIdle(s.state) ? t('lockTree.idleTx') : s.state}</span>
          {s.txSeconds > 0 && <span className="lt-meta">{t('lockTree.txOpen', { s: fmtSeconds(s.txSeconds) })}</span>}
          {node.waitsFor && (
            <span className="lt-wait">
              <Lock size={11} />
              {t('lockTree.waitsFor', {
                // A row-lock wait start the server did not report: how long the statement has run.
                s: fmtSeconds(node.waitsFor.waitSeconds || s.stateSeconds),
                mode: node.waitsFor.mode || '?',
                type: node.waitsFor.lockType.toLowerCase(),
                object: node.waitsFor.object || '—',
              })}
            </span>
          )}
          {node.alsoWaitsFor.length > 0 && (
            <span className="lt-meta">{t('lockTree.alsoWaits', { ids: node.alsoWaitsFor.join(', ') })}</span>
          )}
          <span className="lt-spacer" />
          {isRoot && (
            <>
              <button type="button" className="btn btn-secondary lt-act" onClick={() => setAsk({ node, action: 'cancel' })}>
                <Square size={11} /> {t('lockTree.cancelQuery')}
              </button>
              <button type="button" className="btn btn-secondary lt-act danger" onClick={() => setAsk({ node, action: 'kill' })}>
                <Skull size={11} /> {t('lockTree.killSession')}
              </button>
            </>
          )}
        </div>
        <div className="lt-query" style={{ paddingLeft: 46 + depth * 22 }} title={s.query}>
          {s.query.trim() || t('lockTree.noQuery')}
        </div>
        {open && node.children.map((c) => renderNode(c, depth + 1, key))}
      </div>
    );
  };

  if (error) return <div className="lt-banner error"><AlertTriangle size={13} /> {error}</div>;
  if (!graph || !tree) return <div className="lt-empty"><Loader2 size={14} className="diag-spin" /> {t('lockTree.loading')}</div>;

  return (
    <div className="lt-root">
      {graph.note === 'noLockInfo' && <div className="lt-banner warn"><AlertTriangle size={13} /> {t('lockTree.noLockInfo')}</div>}
      {graph.note === 'embedded' && <div className="lt-banner">{t('lockTree.embedded')}</div>}
      {message && <div className="lt-banner">{message}</div>}
      {tree.cycles.map((c) => (
        <div key={c.join('>')} className="lt-banner error"><AlertTriangle size={13} /> {t('lockTree.cycle', { ids: c.join(' → ') })}</div>
      ))}
      {tree.roots.length === 0 ? (
        graph.note !== 'noLockInfo' && graph.note !== 'embedded' && (
          <div className="lt-empty ok"><CircleCheck size={15} /> {t('lockTree.none')}</div>
        )
      ) : (
        <>
          <div className="lt-summary">{t('lockTree.summary', { waiting: tree.waitingTotal, roots: tree.roots.length })}</div>
          <div className="lt-tree">{tree.roots.map((r) => renderNode(r, 0, ''))}</div>
        </>
      )}
      {graph.deadlock && (
        <div className="lt-deadlock">
          <button type="button" className="lt-deadlock-head" onClick={() => setShowDeadlock((v) => !v)}>
            {showDeadlock ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t('lockTree.deadlock')}
          </button>
          {showDeadlock && <pre>{graph.deadlock}</pre>}
        </div>
      )}

      <ConfirmDialog
        open={!!ask}
        danger={ask?.action === 'kill'}
        title={
          ask
            ? ask.action === 'kill'
              ? t('lockTree.confirmTitle', { id: ask.node.session.id })
              : t('lockTree.cancelTitle', { id: ask.node.session.id })
            : ''
        }
        message={
          ask && (
            <>
              <p>
                {ask.action === 'kill'
                  ? t('lockTree.confirmBody', { id: ask.node.session.id, user: ask.node.session.user || '?', n: ask.node.blockedCount })
                  : t('lockTree.cancelBody', { id: ask.node.session.id })}
              </p>
              {ask.node.session.query.trim() && (
                <>
                  <p>{t('lockTree.confirmQuery')}</p>
                  <pre className="lt-confirm-query">{ask.node.session.query.slice(0, 600)}</pre>
                </>
              )}
            </>
          )
        }
        confirmLabel={ask?.action === 'kill' ? t('lockTree.killSession') : t('lockTree.cancelQuery')}
        onConfirm={() => void run()}
        onCancel={() => setAsk(null)}
      />
    </div>
  );
};
