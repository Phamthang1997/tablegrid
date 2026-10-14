import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DiffEditor } from '@monaco-editor/react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import {
  clearDoc,
  docKey,
  deleteSnapshot,
  listForDoc,
  listForScope,
  subscribeHistory,
  type HistorySnapshot,
  type HistoryTarget,
} from '../utils/localHistory';
import { lineDelta, snapshotTitle, type SnapshotReason } from '../utils/localHistoryPolicy';

// Module-level: a literal in JSX would be a new object per render and make the diff editor re-apply it.
const DIFF_OPTIONS = {
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
  minimap: { enabled: false },
  fontSize: 12,
  lineHeight: 18,
  scrollBeyondLastLine: false,
  automaticLayout: true,
} as const;

/**
 * Local history of one query pane: pick a snapshot, see it against the current text, restore it.
 *
 * Lives next to SqlEditor and is only imported by it, so the Monaco diff editor it renders comes
 * from the chunk that is already lazy (see the Monaco notes in CLAUDE.md) — importing it from
 * anything the entry reaches would put Monaco back into startup.
 *
 * "All tabs on this database" is the recovery path for a CLOSED tab: its draft is gone from
 * localStorage, but its snapshots are keyed by scope, not by an open tab, and are still here.
 */
export const LocalHistoryDialog: React.FC<{
  target: HistoryTarget;
  /** Read at open and on every refresh, so the diff is against what the pane holds right now. */
  getCurrentText: () => string;
  language: string;
  monacoTheme: string;
  onRestore: (text: string) => void;
  onClose: () => void;
}> = ({ target, getCurrentText, language, monacoTheme, onRestore, onClose }) => {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<'tab' | 'scope'>('tab');
  const [items, setItems] = useState<HistorySnapshot[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [current, setCurrent] = useState(() => getCurrentText());
  const [confirmClear, setConfirmClear] = useState(false);

  // The parent hands over a fresh `target` object and `getCurrentText` closure on every render, so
  // the load is keyed on the target's IDENTITY string and reads both through refs — keyed on the
  // objects, every re-render of the SQL editor behind the dialog would re-query IndexedDB.
  const targetRef = useRef(target);
  targetRef.current = target;
  const getTextRef = useRef(getCurrentText);
  getTextRef.current = getCurrentText;
  const targetKey = docKey(target);

  const load = useCallback(async () => {
    const tgt = targetRef.current;
    const rows = mode === 'tab' ? await listForDoc(tgt) : await listForScope(tgt.scope);
    setItems(rows);
    setCurrent(getTextRef.current());
    // targetKey stands in for the target object, see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetKey]);

  useEffect(() => {
    void load();
    return subscribeHistory(() => void load());
  }, [load]);

  // The selection falls back to the newest snapshot, derived rather than set in an effect, so a
  // deleted or filtered-out selection never leaves the diff pointing at nothing.
  const selected = useMemo(
    () => items?.find((s) => s.id === selectedId) ?? items?.[0] ?? null,
    [items, selectedId],
  );

  const reasonLabel = (r: SnapshotReason): string => {
    switch (r) {
      case 'run': return t('localHistory.reasonRun');
      case 'edit': return t('localHistory.reasonEdit');
      case 'beforeDelete': return t('localHistory.reasonBeforeDelete');
      case 'beforeReplace': return t('localHistory.reasonBeforeReplace');
      case 'close': return t('localHistory.reasonClose');
    }
  };

  const isThisTab = (s: HistorySnapshot) => s.tabId === target.tabId && s.pane === target.pane;
  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'medium' });

  return (
    <Modal
      title={t('localHistory.title')}
      onClose={onClose}
      width="1100px"
      maxWidth="95%"
      height="80vh"
      zIndex={9999}
    >
      <ModalBody style={{ gap: 10 }}>
        <div className="lh-toolbar">
          <div className="lh-seg" role="tablist">
            <button role="tab" aria-selected={mode === 'tab'} className={mode === 'tab' ? 'is-on' : undefined} onClick={() => { setMode('tab'); setSelectedId(null); }}>
              {t('localHistory.modeTab')}
            </button>
            <button role="tab" aria-selected={mode === 'scope'} className={mode === 'scope' ? 'is-on' : undefined} onClick={() => { setMode('scope'); setSelectedId(null); }}>
              {t('localHistory.modeScope')}
            </button>
          </div>
          <span className="gt-note">{mode === 'tab' ? t('localHistory.hintTab') : t('localHistory.hintScope')}</span>
        </div>

        <div className="lh-body">
          <div className="lh-list">
            {items === null ? null : items.length === 0 ? (
              <div className="lh-empty">{t('localHistory.empty')}</div>
            ) : (
              items.map((s) => {
                const d = lineDelta(s.text, current);
                return (
                  <button
                    key={s.id}
                    className={`lh-item${selected?.id === s.id ? ' is-on' : ''}`}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <div className="lh-item-head">
                      <span>{fmtTime(s.ts)}</span>
                      <span className="lh-reason">{reasonLabel(s.reason)}</span>
                    </div>
                    <div className="lh-item-title">{snapshotTitle(s.text) || t('localHistory.untitled')}</div>
                    <div className="lh-item-meta">
                      {mode === 'scope' && (
                        <span className="lh-tag">{isThisTab(s) ? t('localHistory.thisTab') : t('localHistory.otherTab')}</span>
                      )}
                      {d.added === 0 && d.removed === 0 ? (
                        <span>{t('localHistory.sameAsCurrent')}</span>
                      ) : (
                        <span>{t('localHistory.delta', { added: d.added, removed: d.removed })}</span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div className="lh-diff">
            {selected ? (
              <>
                <div className="lh-diff-head">
                  <span>{t('localHistory.diffLeft', { time: fmtTime(selected.ts) })}</span>
                  <span>{t('localHistory.diffRight')}</span>
                </div>
                <DiffEditor
                  original={selected.text}
                  modified={current}
                  language={language}
                  theme={monacoTheme}
                  options={DIFF_OPTIONS}
                />
              </>
            ) : (
              <div className="lh-empty">{t('localHistory.pickOne')}</div>
            )}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        {mode === 'tab' && items && items.length > 0 && (
          <button className="btn btn-secondary" onClick={() => setConfirmClear(true)}>{t('localHistory.clearTab')}</button>
        )}
        <span className="lh-spacer" />
        {selected && (
          <>
            <button className="btn btn-secondary" onClick={() => void deleteSnapshot(selected.id)}>{t('localHistory.deleteOne')}</button>
            <button className="btn btn-secondary" onClick={() => { void navigator.clipboard.writeText(selected.text).catch(() => {}); }}>{t('common.copy')}</button>
            <button
              className="btn btn-primary"
              disabled={selected.text === current}
              onClick={() => { onRestore(selected.text); onClose(); }}
            >
              {t('localHistory.restore')}
            </button>
          </>
        )}
      </ModalFooter>
      <ConfirmDialog
        open={confirmClear}
        danger
        title={t('localHistory.clearTitle')}
        message={t('localHistory.clearMessage')}
        zIndex={10001}
        onConfirm={() => { setConfirmClear(false); void clearDoc(target); }}
        onCancel={() => setConfirmClear(false)}
      />
    </Modal>
  );
};
