// A query notebook: SQL cells and Markdown notes in one tab, where a SQL cell can use an earlier
// cell's result as a BOUND parameter (`:q1.id`, `:q1.id[]` — see utils/notebookRefs.ts).
//
// Loaded lazily from App (it imports Monaco, like SqlEditor) and mounted permanently like a query
// tab, so results survive a tab switch. Only the cells' SOURCE is persisted (the tab, and `.tgnb`
// files); results live in this component and are gone when the tab closes — they are the
// database's answer at one moment, not part of the notebook.

import '../../sql/monacoSetup';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import {
  ArrowDown, ArrowUp, Code2, Eraser, FileText, FolderOpen, Loader2, Play, PlayCircle, Save, Square, Trash2,
} from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { dbHelper, type QueryStreamMessage } from '../../utils/dbHelper';
import { setupSqlCompletion, langIdForDbType } from '../../sql/sqlLanguage';
import { setupSqlHover } from '../../sql/intellisense';
import { defineSqlThemes, sqlThemeName } from '../../sql/theme';
import { SQL_EDITOR_OPTIONS } from '../../sql/editorOptions';
import { setEditorConnId } from '../../sql/editorScope';
import { findUnsafeStatements, isReadOnlySql, type UnsafeStatement, type UnsafeStatementKind } from '../../sql/statements';
import { willPromptForSql } from '../../utils/safeMode';
import { bindCellRefs, findCellRefs, type CellResult, type RefProblem } from '../../utils/notebookRefs';
import {
  duplicateNames, fromStored, isValidCellName, newCell, NOTEBOOK_EXTENSION, parseNotebook, serializeNotebook,
  starterCells, toStored, type NotebookCell, type NotebookCellKind, type StoredCell,
} from '../../utils/notebookFile';
import { parseMarkdown, type MdBlock, type MdInline } from '../../utils/notebookMarkdown';
import { pickSaveFilePath, saveExportFileAtPath } from '../../utils/fileSave';
import './notebook.css';

// Both are guarded / idempotent (the completion setup keeps a flag, the hover setup disposes its
// previous registration), so a notebook opened before any query tab still gets completion + hover.
setupSqlCompletion();
setupSqlHover();
defineSqlThemes();

/** Rows a cell keeps from one run — what a `:q1.col[]` list can draw from, and all memory it costs. */
const ROW_CAP = 5000;
/** Rows drawn under a cell; the rest are only counted. A notebook is read top to bottom. */
const ROWS_SHOWN = 100;
/** Past this a file is not a notebook anyone wrote by hand. */
const FILE_MAX_BYTES = 5 * 1024 * 1024;
/** How long a burst of keystrokes waits before the cells are written back to the tab. */
const PERSIST_DEBOUNCE_MS = 400;

interface CellRun {
  status: 'running' | 'done' | 'error';
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  affected?: number;
  ms?: number;
  error?: string;
  uses?: string[];
}

export interface NotebookTabProps {
  connId: string;
  dbType?: string;
  theme: 'dark' | 'light';
  /** The global read-only switch; the connection's own flag is enforced by the backend as well. */
  readOnly: boolean;
  connReadOnly?: boolean;
  /** The tab's label — the default file name and the file's title. */
  title: string;
  initialCells?: unknown;
  onCellsChange: (cells: StoredCell[]) => void;
  /** Open a notebook read from a file in a tab of its own. */
  onOpenNotebook: (cells: StoredCell[], title?: string) => void;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ─── Markdown ────────────────────────────────────────────────────────────────────────────────

/**
 * A note is re-rendered whole from its text, so an element's position IS its identity. The key
 * comes from a counter handed down the tree rather than a map index — same keys, one idea.
 */
type Keyer = { n: number };

function renderInline(nodes: MdInline[], openLink: (href: string) => void, k: Keyer): React.ReactNode[] {
  return nodes.map((n) => {
    const key = k.n++;
    switch (n.t) {
      case 'text': return <React.Fragment key={key}>{n.v}</React.Fragment>;
      case 'code': return <code key={key}>{n.v}</code>;
      case 'b': return <strong key={key}>{renderInline(n.c, openLink, k)}</strong>;
      case 'i': return <em key={key}>{renderInline(n.c, openLink, k)}</em>;
      case 'a':
        // A link must leave through the OS browser: following it inside the webview would
        // navigate the whole app away.
        return (
          <a key={key} href={n.href} onClick={(e) => { e.preventDefault(); openLink(n.href); }}>
            {renderInline(n.c, openLink, k)}
          </a>
        );
    }
  });
}

function renderItems(items: MdInline[][], openLink: (href: string) => void, k: Keyer): React.ReactNode[] {
  return items.map((it) => <li key={k.n++}>{renderInline(it, openLink, k)}</li>);
}

function renderBlocks(blocks: MdBlock[], openLink: (href: string) => void): React.ReactNode[] {
  const k: Keyer = { n: 0 };
  return blocks.map((b) => {
    const key = k.n++;
    switch (b.t) {
      case 'h': {
        // One level down: the tab itself is the page's title.
        const H = `h${Math.min(b.level + 1, 6)}` as 'h2';
        return <H key={key}>{renderInline(b.c, openLink, k)}</H>;
      }
      case 'p': return <p key={key}>{renderInline(b.c, openLink, k)}</p>;
      case 'code': return <pre key={key}><code>{b.v}</code></pre>;
      case 'ul': return <ul key={key}>{renderItems(b.items, openLink, k)}</ul>;
      case 'ol': return <ol key={key} start={b.start}>{renderItems(b.items, openLink, k)}</ol>;
      case 'quote': return <blockquote key={key}>{renderInline(b.c, openLink, k)}</blockquote>;
      case 'hr': return <hr key={key} />;
    }
  });
}

const NoteCell: React.FC<{
  source: string;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onChange: (v: string) => void;
}> = ({ source, editing, onEdit, onChange }) => {
  const { t } = useTranslation();
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const openLink = useCallback((href: string) => void dbHelper.openUrl(href), []);
  if (editing) {
    return (
      <textarea
        className="nb-note-input"
        autoFocus
        value={source}
        rows={Math.max(3, source.split('\n').length + 1)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onEdit(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
            e.preventDefault();
            onEdit(false);
          }
        }}
      />
    );
  }
  return (
    <div className="nb-note" title={t('notebook.editHint')} onDoubleClick={() => onEdit(true)}>
      {blocks.length ? renderBlocks(blocks, openLink) : <p className="nb-dim">{t('notebook.emptyNote')}</p>}
    </div>
  );
};

// ─── SQL editor ──────────────────────────────────────────────────────────────────────────────

/**
 * The SQL parser (`dt-sql-parser`, through monaco-sql-languages) does not know `:q1.col` and
 * underlines it as a syntax error on every reference. For the notebook's own models only, markers
 * lying on a reference — or on the token just before it, where the parser often reports instead
 * (`IN` in `IN (:q1.id[])`, REF_LEAD characters back) — are dropped; everything else the parser
 * reports stays, so a real typo elsewhere in the cell is still underlined. Re-setting the
 * filtered list fires the event again, finds nothing left to drop, and stops there.
 */
const notebookModels = new Set<string>();
/** Characters before a reference that still count as "on" it: `IN (` or `= ` and the space. */
const REF_LEAD = 6;
monaco.editor.onDidChangeMarkers((uris) => {
  for (const uri of uris) {
    if (!notebookModels.has(uri.toString())) continue;
    const model = monaco.editor.getModel(uri);
    if (!model) continue;
    const refs = findCellRefs(model.getValue());
    if (!refs.length) continue;
    const byOwner = new Map<string, monaco.editor.IMarker[]>();
    for (const m of monaco.editor.getModelMarkers({ resource: uri })) {
      if (m.owner === 'sql-inspector') continue;
      const list = byOwner.get(m.owner) ?? [];
      list.push(m);
      byOwner.set(m.owner, list);
    }
    for (const [owner, markers] of byOwner) {
      const kept = markers.filter((m) => {
        const start = model.getOffsetAt({ lineNumber: m.startLineNumber, column: m.startColumn });
        const end = model.getOffsetAt({ lineNumber: m.endLineNumber, column: m.endColumn });
        return !refs.some(function onRef(r) {
          return Math.max(start, r.start - REF_LEAD) < Math.min(end, r.end);
        });
      });
      if (kept.length !== markers.length) monaco.editor.setModelMarkers(model, owner, kept);
    }
  }
});

const EDITOR_MIN = 38;
const EDITOR_MAX = 420;

const SqlCellEditor: React.FC<{
  source: string;
  connId: string;
  dbType?: string;
  theme: 'dark' | 'light';
  onChange: (v: string) => void;
  onRun: () => void;
}> = ({ source, connId, dbType, theme, onChange, onRun }) => {
  const [height, setHeight] = useState(EDITOR_MIN);
  // The run action is registered once, on mount; it reads the latest handler through this ref.
  const runRef = useRef(onRun);
  useEffect(() => { runRef.current = onRun; }, [onRun]);
  const options = useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(() => ({
    ...SQL_EDITOR_OPTIONS,
    automaticLayout: true,
    glyphMargin: false,
    folding: false,
    lineNumbersMinChars: 2,
    scrollBeyondLastLine: false,
    // The page scrolls, not the editor: a wheel over a cell must not get stuck in it.
    scrollbar: { ...SQL_EDITOR_OPTIONS.scrollbar, alwaysConsumeMouseWheel: false },
    padding: { top: 6, bottom: 6 },
  }), []);
  return (
    <div className="nb-editor" style={{ height }}>
      <Editor
        height="100%"
        language={langIdForDbType(dbType || '')}
        theme={sqlThemeName(theme)}
        defaultValue={source}
        options={options}
        onChange={(v) => onChange(v ?? '')}
        onMount={(editor) => {
          const uri = editor.getModel()?.uri.toString();
          if (uri) {
            notebookModels.add(uri);
            editor.onDidDispose(() => notebookModels.delete(uri));
          }
          const fit =() => setHeight(Math.min(EDITOR_MAX, Math.max(EDITOR_MIN, editor.getContentHeight())));
          editor.onDidContentSizeChange(fit);
          fit();
          editor.onDidFocusEditorText(() => setEditorConnId(connId));
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
        }}
      />
    </div>
  );
};

// ─── Result ──────────────────────────────────────────────────────────────────────────────────

const ResultView: React.FC<{ run: CellRun }> = ({ run }) => {
  const { t, i18n } = useTranslation();
  const n = (v: number) => v.toLocaleString(i18n.language);
  if (run.status === 'running') {
    return <div className="nb-result-meta"><Loader2 size={12} className="nb-spin" /> {t('notebook.running')}</div>;
  }
  if (run.status === 'error') return <div className="nb-error">{run.error}</div>;
  const meta: string[] = [];
  if (run.columns.length) {
    meta.push(t('notebook.rows', { n: n(run.rows.length) }));
    if (run.truncated) meta.push(t('notebook.rowsCapped', { n: n(ROW_CAP) }));
    else if (run.rows.length > ROWS_SHOWN) meta.push(t('notebook.shownOf', { shown: n(ROWS_SHOWN) }));
  } else if (run.affected != null) {
    meta.push(t('notebook.affected', { n: n(run.affected) }));
  } else {
    meta.push(t('notebook.noResultSet'));
  }
  if (run.ms != null) meta.push(t('notebook.ms', { n: n(run.ms) }));
  if (run.uses?.length) meta.push(t('notebook.uses', { names: run.uses.join(', ') }));
  return (
    <>
      <div className="nb-result-meta">{meta.join(' · ')}</div>
      {run.columns.length > 0 && (
        <div className="nb-grid-wrap">
          <table className="nb-grid">
            <thead>
              <tr>
                {/* Keyed by position: two columns may share a name (see CLAUDE.md, uniquify). */}
                {run.columns.map((c, i) => <th key={i}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {run.rows.slice(0, ROWS_SHOWN).map((row, ri) => (
                <tr key={ri}>
                  {run.columns.map((c, ci) => {
                    const v = row[c];
                    return <td key={ci} className={v === null || v === undefined ? 'nb-null' : undefined}>{cellText(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

// ─── Notebook ────────────────────────────────────────────────────────────────────────────────

export const NotebookTab: React.FC<NotebookTabProps> = ({
  connId, dbType, theme, readOnly, connReadOnly, title, initialCells, onCellsChange, onOpenNotebook,
}) => {
  const { t } = useTranslation();
  const [cells, setCells] = useState<NotebookCell[]>(() => {
    const restored = fromStored(initialCells);
    return restored.length ? restored : starterCells(t('notebook.intro'));
  });
  const [results, setResults] = useState<Record<number, CellRun>>({});
  const [editingNotes, setEditingNotes] = useState<Set<number>>(() => new Set());
  const [runningAll, setRunningAll] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [unsafeAsk, setUnsafeAsk] = useState<{ items: UnsafeStatement[]; resolve: (ok: boolean) => void } | null>(null);

  // Mirrors for the async run loop: state set by one awaited cell is not visible to the next one
  // through the closure, only through these.
  const cellsRef = useRef(cells);
  const resultsRef = useRef(results);
  const stopRef = useRef(false);
  const queryRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Written back to the tab in a debounced burst: every write re-renders App.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCellsChangeRef = useRef(onCellsChange);
  useEffect(() => { onCellsChangeRef.current = onCellsChange; }, [onCellsChange]);
  useEffect(() => {
    cellsRef.current = cells;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => onCellsChangeRef.current(toStored(cells)), PERSIST_DEBOUNCE_MS);
  }, [cells]);
  useEffect(() => () => {
    // Closing the tab mid-burst still keeps the last keystrokes.
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      onCellsChangeRef.current(toStored(cellsRef.current));
    }
  }, []);

  const setRun = useCallback((id: number, run: CellRun | undefined) => {
    const next = { ...resultsRef.current };
    if (run) next[id] = run;
    else delete next[id];
    resultsRef.current = next;
    setResults(next);
  }, []);

  const dups = useMemo(() => duplicateNames(cells), [cells]);

  const refMessage = useCallback((p: RefProblem): string => {
    switch (p.kind) {
      case 'unknownCell': return t('notebook.refUnknownCell', { cell: p.cell });
      case 'self': return t('notebook.refSelf', { cell: p.cell });
      case 'notRun': return t('notebook.refNotRun', { cell: p.cell });
      case 'noRows': return t('notebook.refNoRows', { cell: p.cell });
      case 'noColumn': return t('notebook.refNoColumn', { cell: p.cell, column: p.column });
      case 'listTruncated': return t('notebook.refListTruncated', { cell: p.cell, column: p.column });
      case 'mixedParams': return t('notebook.refMixedParams');
    }
  }, [t]);

  const unsafeLabel = (kind: UnsafeStatementKind): string => {
    switch (kind) {
      case 'deleteNoWhere': return t('sqlEditor.unsafeKindDeleteNoWhere');
      case 'dropTable': return t('sqlEditor.unsafeKindDropTable');
      case 'updateNoWhere': return t('sqlEditor.unsafeKindUpdateNoWhere');
      case 'truncate': return t('sqlEditor.unsafeKindTruncate');
    }
  };

  /** Runs one SQL cell; true when it produced a result the next cell may read. */
  const runCell = useCallback(async (cellId: number): Promise<boolean> => {
    const cell = cellsRef.current.find((c) => c.id === cellId);
    if (!cell || cell.kind !== 'sql') return true;
    const source = cell.source.trim();
    if (!source) return true;
    const fail = (error: string) => {
      setRun(cell.id, { status: 'error', columns: [], rows: [], truncated: false, error });
      return false;
    };
    if (cell.name && duplicateNames(cellsRef.current).has(cell.name.toLowerCase())) {
      return fail(t('notebook.dupName', { name: cell.name }));
    }

    const lookup = (name: string): CellResult | null | undefined => {
      const target = cellsRef.current.find((c) => c.kind === 'sql' && c.name?.toLowerCase() === name.toLowerCase());
      if (!target) return undefined;
      const r = resultsRef.current[target.id];
      return r && r.status === 'done' ? r : null;
    };
    const bound = bindCellRefs(source, dbType || '', lookup, cell.name);
    if ('problem' in bound) return fail(refMessage(bound.problem));

    if ((readOnly || connReadOnly) && !isReadOnlySql(bound.sql)) return fail(t('notebook.readOnlyBlocked'));

    // Safe Mode asks for itself when it will; otherwise wiping statements are confirmed here, like
    // the SQL editor does — one question, never two.
    if (!willPromptForSql(connId, bound.sql)) {
      const items = findUnsafeStatements(bound.sql);
      if (items.length) {
        const ok = await new Promise<boolean>((resolve) => setUnsafeAsk({ items, resolve }));
        if (!ok) return false;
      }
    }

    const queryId = `nb_${cell.id}_${Date.now()}`;
    queryRef.current = queryId;
    setRun(cell.id, { status: 'running', columns: [], rows: [], truncated: false });
    const started = performance.now();
    type Stmt = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; affected?: number };
    const stmts: Stmt[] = [];
    const cur = (i: number | undefined): Stmt => {
      const k = i ?? 0;
      if (!stmts[k]) stmts[k] = { columns: [], rows: [], truncated: false };
      return stmts[k];
    };
    let error: string | null = null;
    try {
      await dbHelper.executeQueryStream(
        connId,
        bound.sql,
        queryId,
        (msg: QueryStreamMessage) => {
          if (msg.type === 'columns') cur(msg.stmtIndex).columns = msg.columns ?? [];
          else if (msg.type === 'rows') {
            const s = cur(msg.stmtIndex);
            for (const r of msg.rows ?? []) {
              if (s.rows.length >= ROW_CAP) { s.truncated = true; break; }
              s.rows.push(r);
            }
          } else if (msg.type === 'affected') cur(msg.stmtIndex).affected = msg.affected;
          else if (msg.type === 'error') error = msg.message ?? 'error';
        },
        bound.params.length ? bound.params : undefined,
      );
    } catch (e) {
      error = String(e);
    } finally {
      if (queryRef.current === queryId) queryRef.current = null;
    }
    const ms = Math.round(performance.now() - started);
    if (error) return fail(error);
    // What a later cell reads is the LAST result set — the SELECT after a few setup statements.
    const withRows = [...stmts].reverse().find((s) => s && s.columns.length > 0);
    const last = withRows ?? [...stmts].reverse().find(Boolean) ?? { columns: [], rows: [], truncated: false };
    setRun(cell.id, { status: 'done', ...last, ms, uses: bound.uses });
    return true;
  }, [connId, dbType, readOnly, connReadOnly, refMessage, setRun, t]);

  // Not memoized: nothing receives it as a prop, it only reads refs and the latest runCell.
  const runAll = async () => {
    stopRef.current = false;
    setRunningAll(true);
    setBanner(null);
    try {
      for (const cell of cellsRef.current) {
        if (stopRef.current) break;
        if (cell.kind !== 'sql') continue;
        // Sequential on purpose: a cell may read the result of the one before it.
        const ok = await runCell(cell.id);
        if (!ok) {
          if (!stopRef.current) setBanner({ tone: 'error', text: t('notebook.stoppedAt', { name: cell.name ?? '' }) });
          break;
        }
      }
    } finally {
      setRunningAll(false);
    }
  };

  const stop = () => {
    stopRef.current = true;
    if (queryRef.current) void dbHelper.cancelQuery(queryRef.current);
  };

  const update = (id: number, patch: Partial<NotebookCell>) =>
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const insertAfter = (index: number, kind: NotebookCellKind) => {
    // Minted outside the updater, which StrictMode runs twice.
    const cell = newCell(kind, cellsRef.current);
    if (kind === 'md') setEditingNotes((prev) => new Set(prev).add(cell.id));
    setCells((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, cell);
      return next;
    });
  };

  const move = (index: number, delta: -1 | 1) =>
    setCells((prev) => {
      const j = index + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });

  const remove = (id: number) => {
    setCells((prev) => prev.filter((c) => c.id !== id));
    setRun(id, undefined);
  };

  const clearResults = () => {
    resultsRef.current = {};
    setResults({});
    setBanner(null);
  };

  const save = async () => {
    const path = await pickSaveFilePath(title.replace(/[\\/:*?"<>|]/g, '_') || 'notebook', NOTEBOOK_EXTENSION, t('notebook.fileFilter'));
    if (!path) return;
    await saveExportFileAtPath(path, serializeNotebook(cellsRef.current, title), 'application/json');
    setBanner({ tone: 'info', text: t('notebook.saved') });
  };

  const openFile = async (file: File) => {
    if (file.size > FILE_MAX_BYTES) {
      setBanner({ tone: 'error', text: t('notebook.fileTooLarge') });
      return;
    }
    const parsed = parseNotebook(await file.text());
    if (!parsed.ok) {
      const key = parsed.reason === 'json' ? 'notebook.fileJson' : parsed.reason === 'version' ? 'notebook.fileVersion' : 'notebook.fileFormat';
      setBanner({ tone: 'error', text: t(key) });
      return;
    }
    onOpenNotebook(toStored(parsed.cells), parsed.title || file.name.replace(/\.[^.]+$/, ''));
    if (parsed.dropped) setBanner({ tone: 'info', text: t('notebook.fileDropped', { n: parsed.dropped }) });
  };

  const anyRunning = Object.values(results).some((r) => r.status === 'running');

  return (
    <div className="nb-root">
      <div className="nb-toolbar">
        {runningAll || anyRunning ? (
          <button type="button" className="btn btn-secondary" onClick={stop}>
            <Square size={12} /> {t('notebook.stop')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => void runAll()}>
            <PlayCircle size={13} /> {t('notebook.runAll')}
          </button>
        )}
        <span className="nb-sep" />
        <button type="button" className="btn btn-secondary" title={t('notebook.addSqlTitle')} onClick={() => insertAfter(cells.length - 1, 'sql')}>
          <Code2 size={13} /> {t('notebook.addSql')}
        </button>
        <button type="button" className="btn btn-secondary" title={t('notebook.addNoteTitle')} onClick={() => insertAfter(cells.length - 1, 'md')}>
          <FileText size={13} /> {t('notebook.addNote')}
        </button>
        <span className="nb-spacer" />
        <button type="button" className="btn btn-secondary" onClick={clearResults} disabled={!Object.keys(results).length}>
          <Eraser size={13} /> {t('notebook.clearResults')}
        </button>
        <button type="button" className="btn btn-secondary" title={t('notebook.openTitle')} onClick={() => fileInputRef.current?.click()}>
          <FolderOpen size={13} /> {t('notebook.open')}
        </button>
        <button type="button" className="btn btn-secondary" title={t('notebook.saveTitle')} onClick={() => void save()}>
          <Save size={13} /> {t('notebook.save')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={`.${NOTEBOOK_EXTENSION},.json`}
          className="nb-hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void openFile(f);
          }}
        />
      </div>

      {banner && <div className={`nb-banner ${banner.tone}`}>{banner.text}</div>}

      <div className="nb-cells">
        {cells.map((cell, index) => {
          const run = results[cell.id];
          const nameBad = cell.kind === 'sql' && (!cell.name || !isValidCellName(cell.name));
          const nameDup = cell.kind === 'sql' && !!cell.name && dups.has(cell.name.toLowerCase());
          return (
            <div key={cell.id} className={`nb-cell nb-${cell.kind}${run?.status === 'error' ? ' has-error' : ''}`}>
              <div className="nb-cell-bar">
                {cell.kind === 'sql' ? (
                  <>
                    <button
                      type="button"
                      className="nb-icon-btn nb-run"
                      title={t('notebook.runCell')}
                      disabled={run?.status === 'running' || runningAll}
                      onClick={() => void runCell(cell.id)}
                    >
                      {run?.status === 'running' ? <Loader2 size={13} className="nb-spin" /> : <Play size={13} />}
                    </button>
                    <input
                      type="text"
                      className={`nb-name${nameBad || nameDup ? ' bad' : ''}`}
                      value={cell.name ?? ''}
                      title={nameBad ? t('notebook.badName') : nameDup ? t('notebook.dupName', { name: cell.name }) : t('notebook.cellName')}
                      spellCheck={false}
                      onChange={(e) => update(cell.id, { name: e.target.value.trim() })}
                    />
                  </>
                ) : (
                  <FileText size={13} className="nb-dim" />
                )}
                <span className="nb-spacer" />
                <button type="button" className="nb-icon-btn" title={t('notebook.moveUp')} disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp size={13} />
                </button>
                <button type="button" className="nb-icon-btn" title={t('notebook.moveDown')} disabled={index === cells.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown size={13} />
                </button>
                <button type="button" className="nb-icon-btn" title={t('notebook.deleteCell')} onClick={() => remove(cell.id)}>
                  <Trash2 size={13} />
                </button>
              </div>

              {cell.kind === 'sql' ? (
                <SqlCellEditor
                  source={cell.source}
                  connId={connId}
                  dbType={dbType}
                  theme={theme}
                  onChange={(v) => update(cell.id, { source: v })}
                  onRun={() => void runCell(cell.id)}
                />
              ) : (
                <NoteCell
                  source={cell.source}
                  editing={editingNotes.has(cell.id)}
                  onEdit={(on) =>
                    setEditingNotes((s) => {
                      const next = new Set(s);
                      if (on) next.add(cell.id);
                      else next.delete(cell.id);
                      return next;
                    })
                  }
                  onChange={(v) => update(cell.id, { source: v })}
                />
              )}

              {run && <div className="nb-result"><ResultView run={run} /></div>}

              <div className="nb-insert">
                <button type="button" title={t('notebook.addSqlTitle')} onClick={() => insertAfter(index, 'sql')}>
                  <Code2 size={11} /> {t('notebook.addSql')}
                </button>
                <button type="button" title={t('notebook.addNoteTitle')} onClick={() => insertAfter(index, 'md')}>
                  <FileText size={11} /> {t('notebook.addNote')}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={!!unsafeAsk}
        danger
        title={t('sqlEditor.unsafeTitle')}
        message={
          unsafeAsk && (
            <>
              <p>{t('sqlEditor.unsafeIntro', { n: unsafeAsk.items.length })}</p>
              <ul className="nb-unsafe">
                {unsafeAsk.items.map((it, i) => (
                  <li key={i}>
                    <strong>{unsafeLabel(it.kind)}</strong>
                    <code>{it.text.length > 160 ? `${it.text.slice(0, 160)}…` : it.text}</code>
                  </li>
                ))}
              </ul>
            </>
          )
        }
        note={t('sqlEditor.unsafeNote')}
        confirmLabel={t('sqlEditor.unsafeConfirm')}
        onConfirm={() => { unsafeAsk?.resolve(true); setUnsafeAsk(null); }}
        onCancel={() => { unsafeAsk?.resolve(false); setUnsafeAsk(null); }}
      />
    </div>
  );
};

export default NotebookTab;
