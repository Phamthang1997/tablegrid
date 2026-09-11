import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { Play, ListChecks } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import { SQL_EDITOR_OPTIONS } from '../../sql/editorOptions';
import { defineSqlThemes, sqlThemeName } from '../../sql/theme';
import { COMMANDS } from './commandHelp';
import { REDIS_LANG_ID, registerRedisLanguage } from './redisLanguage';
import { commandAtLine, splitRedisCommands } from './redisScript';
// Worker factory + loader binding. This module is lazy-loaded and may well be the first thing
// in the app to touch Monaco, so it configures the environment itself rather than relying on
// `SqlEditor` having been imported first.
import '../../sql/monacoSetup';

interface ConsoleProps {
  /** localStorage scope for the buffer — the server, never `dbName`. */
  storageScope: string;
  theme: 'dark' | 'light';
  onError: (msg: string) => void;
  /**
   * `SELECT n` in console. Includes `connId` because backend does NOT change this connection's db — it resolves
   * the target db connection and reports back (§2.2); caller switches workspace to that id.
   */
  onSelectedDb: (index: number, connId?: string) => void;
}

const QUICK_CMDS = ['PING', 'INFO', 'DBSIZE', 'CLIENT LIST', 'CONFIG GET maxmemory'];

interface LogEntry {
  cmd: string;
  out: string;
  ok: boolean;
  /** System message (switched db...), distinct from server responses. */
  note?: boolean;
}

/**
 * CLI console — a multi-line Monaco buffer, not a one-line input.
 *
 * The shape changed because a one-line input forces exactly one gesture: type a command, Enter,
 * forget it. What people actually do with `redis-cli` is keep a handful of commands and re-run them
 * — inspect a key, change its TTL, check again. A buffer does that without any extra feature; it
 * also replaces the old ↑/↓ history, because the buffer *is* the history and it can be edited.
 *
 * It reuses the SQL side's whole Monaco setup — `SQL_EDITOR_OPTIONS`, both themes — so shortcuts,
 * font sizes and suggestion behaviour match the query tab exactly. Only the language is Redis's own
 * (`redisLanguage.ts`).
 *
 * Two classes of command are still refused by the backend rather than here — writes while read-only,
 * and commands that monopolise the shared connection (`SUBSCRIBE`, `MONITOR`, `BLPOP`…) — so the
 * message the user sees really is the one from the IPC boundary, not a second guess made in the UI.
 */
/**
 * Ring buffer for the command log, the same shape `Profiler` and `PubSub` already use.
 *
 * It was unbounded, and this tab is mounted for the life of the connection — so a session that
 * runs a few `LRANGE`s or a `KEYS *` accumulates their full output forever, in a tab nobody is
 * looking at. Entries are whole command outputs rather than single lines, hence a far smaller
 * cap than the Profiler's 5000.
 */
const LOG_CAP = 500;

function appendLog(prev: LogEntry[], entry: LogEntry): LogEntry[] {
  const next = prev.concat(entry);
  return next.length > LOG_CAP ? next.slice(-LOG_CAP) : next;
}

export const Console: React.FC<ConsoleProps> = ({ storageScope, theme, onError, onSelectedDb }) => {
  const { t } = useTranslation();
  const bufKey = `tf_redis_cli_buf_${storageScope}`;
  const legacyHistoryKey = `tf_redis_cli_history_${storageScope}`;

  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  // Cursor position displayed in action bar. Kept in state to trigger re-renders on cursor movements.
  
  const [pos, setPos] = useState({ line: 1, col: 1 });
  /** User-dragged editor height in px. `null` = unadjusted, uses default ratio. */
  const [editorH, setEditorH] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const editorBoxRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  /**
   * The initial contents.
   *
   * On the first run of a new build there is no buffer yet, but there may be the old ↑/↓ history —
   * load that as the buffer instead of leaving it stranded in localStorage. The user does not lose
   * the commands they typed just because the place holding them changed shape.
   */
  const [initialValue] = useState<string>(() => {
    let buf = '';
    try {
      buf = typeof localStorage !== 'undefined' ? localStorage.getItem(bufKey) ?? '' : '';
      if (!buf && typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(legacyHistoryKey);
        if (raw) buf = (JSON.parse(raw) as string[]).join('\n');
      }
    } catch { /* localStorage corrupt -> fallback to empty */ }
    return buf;
  });

  useEffect(() => { registerRedisLanguage(); defineSqlThemes(); }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    // `log` is a trigger, not a read - the body only touches refs. Dropping it kills auto-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log]);

  /** Reads directly from Monaco without React state — mirrors SqlEditor `getPaneSql()`. */
  const bufferText = () => editorRef.current?.getValue() ?? '';

  const persist = useCallback(() => {
    try { localStorage.setItem(bufKey, bufferText()); } catch { /* quota */ }
    // Same as `runAll` below: `bufferText` is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufKey]);

  /**
   * Runs a sequence of commands in order.
   *
   * **Stops at `SELECT n`** rather than continuing. The backend does not change this connection's db
   * — it resolves the connection for `dbN` and reports back (§2.2) — so the commands after it, if
   * they ran, would run on the OLD db while the user wrote them for the new one. Carrying out half
   * of an intention is worse than stopping and saying so.
   */
  const runCommands = useCallback(async (cmds: string[]) => {
    if (cmds.length === 0 || running) return;
    setRunning(true);
    try {
      for (let i = 0; i < cmds.length; i++) {
        const command = cmds[i];
        const res = await dbHelper.redisExecuteCmd(command);
        const out = res.success ? JSON.stringify(res.result, null, 2) : `(error) ${res.error}`;
        if (!res.success && res.error) onError(res.error);
        setLog((prev) => appendLog(prev, { cmd: command, out, ok: !!res.success }));

        if (res.selectedDb != null) {
          onSelectedDb(res.selectedDb, res.switchDb?.connId);
          const left = cmds.length - i - 1;
          if (left > 0) {
            setLog((prev) =>
              appendLog(prev, {
                cmd: '',
                out: t('redis.cliStoppedAtSelect', { db: res.selectedDb, n: left }),
                ok: true,
                note: true,
              })
            );
          }
          break;
        }
      }
    } finally {
      setRunning(false);
    }
    // memo-dependencies calls `onError`, `onSelectedDb` and `t` unnecessary here. **It is wrong**:
    // the body calls all three (`onError(res.error)`, `onSelectedDb(...)`, `t(redis.cliStoppedAtSelect)`).
    // The one thing that sets this callback apart from the two below is that it is `async`, which the
    // rule appears not to traverse. Do NOT trim these: dropping `t` is the stale-translation bug the
    // i18n notes in CLAUDE.md warn about, and dropping the two props is a stale closure over an old
    // handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, onError, onSelectedDb, t]);

  /** Ctrl+Enter: command under cursor. */
  const runCurrent = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const line = ed.getPosition()?.lineNumber ?? 1;
    const cmd = commandAtLine(ed.getValue(), line);
    if (!cmd) { onError(t('redis.cliNothingToRun')); return; }
    void runCommands([cmd.text]);
  }, [runCommands, onError, t]);

  /** Ctrl+Shift+Enter: entire buffer. */
  const runAll = useCallback(() => {
    const cmds = splitRedisCommands(bufferText()).map((c) => c.text);
    if (cmds.length === 0) { onError(t('redis.cliNothingToRun')); return; }
    void runCommands(cmds);
    // memo-dependencies wants `bufferText` here. Leaving it out is deliberate: it is recreated
    // every render and only reads a ref, so listing it would make this callback change identity on
    // every render - defeating the very memo it is inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCommands, onError, t]);

  // Handlers invoked by Monaco keybindings retain initial closure — accessed via refs
  // so shortcuts always execute latest handlers. Matches `SqlEditor` action handling.
  const runHintRef = useRef(t('redis.cliRunThisLine'));
  const runCurrentRef = useRef(runCurrent);
  const runAllRef = useRef(runAll);
  useEffect(() => {
    runHintRef.current = t('redis.cliRunThisLine');
    runCurrentRef.current = runCurrent;
    runAllRef.current = runAll;
  }, [t, runCurrent, runAll]);

  /** Cleans up resize drag listeners on tab unmount. */
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  /**
   * Drags separator between action bar and results area to resize editor.
   *
   * Listens to `mousemove`/`mouseup` on `window`: fast dragging can move cursor outside separator
   before browser fires event, which would prematurely break the drag operation.
   */
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const startY = e.clientY;
    const startH = editorBoxRef.current?.clientHeight ?? 220;

    const onMove = (ev: MouseEvent) => {
      const root = rootRef.current;
      // Preserves min 120px for results and 80px for editor to prevent either container collapsing.
      
      const maxH = root ? root.clientHeight - 120 : window.innerHeight - 200;
      setEditorH(Math.max(80, Math.min(maxH, startH + ev.clientY - startY)));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Monaco recalculates layout immediately rather than waiting for next `automaticLayout` cycle.
      editorRef.current?.layout();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    dragCleanupRef.current = onUp;
  };

  const onMount = (ed: monaco.editor.IStandaloneCodeEditor) => {
    editorRef.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCurrentRef.current());
    ed.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
      () => runAllRef.current(),
    );

    // Clicking glyph margin arrow executes that line. Moves cursor first to align `runCurrent` target.
    
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      if (!e.target.position) return;
      ed.setPosition(e.target.position);
      runCurrentRef.current();
    });

    // Highlights line that Ctrl+Enter will execute. Line-based without SQL masking overhead.
    
    const decorations = ed.createDecorationsCollection([]);
    const refresh = () => {
      const model = ed.getModel();
      const caret = ed.getPosition();
      if (!model || !caret) return;
      const text = model.getValue();
      const cmd = commandAtLine(text, caret.lineNumber);
      if (!cmd) { decorations.set([]); return; }
      const items: monaco.editor.IModelDeltaDecoration[] = [{
        range: new monaco.Range(cmd.line, 1, cmd.line, 1),
        options: {
          glyphMarginClassName: 'sql-run-glyph',
          glyphMarginHoverMessage: { value: runHintRef.current },
        },
      }];
      // Only highlight line when multiple commands exist — redundant on single-command buffers.
      if (splitRedisCommands(text).length > 1) {
        items.push({
          range: new monaco.Range(cmd.line, 1, cmd.line, model.getLineMaxColumn(cmd.line)),
          options: { isWholeLine: true, className: 'sql-current-stmt' },
        });
      }
      decorations.set(items);
    };
    ed.onDidChangeCursorPosition((e) => {
      setPos({ line: e.position.lineNumber, col: e.position.column });
      refresh();
    });
    ed.onDidChangeModelContent(refresh);
    refresh();

    ed.focus();
  };

  /** Quick command: appends new line at end of buffer and executes. */
  const runQuick = (q: string) => {
    const ed = editorRef.current;
    if (ed) {
      const text = ed.getValue();
      const next = text && !text.endsWith('\n') ? `${text}\n${q}` : `${text}${q}`;
      ed.setValue(next);
      const last = ed.getModel()?.getLineCount() ?? 1;
      ed.setPosition({ lineNumber: last, column: q.length + 1 });
      persist();
    }
    void runCommands([q]);
  };

  return (
    <div className="redis-console" ref={rootRef}>
      {/* Layout mirrors SQL query layout: editor -> action bar -> result tabs -> results area -> status bar. */}
      <div
        className="redis-cli-editor"
        ref={editorBoxRef}
        // Overrides style only after user drag; otherwise CSS flex proportions apply.
        style={editorH != null ? { flex: '0 0 auto', height: editorH } : undefined}
      >
        <Editor
          height="100%"
          language={REDIS_LANG_ID}
          theme={sqlThemeName(theme)}
          defaultValue={initialValue}
          onChange={persist}
          onMount={onMount}
          options={{ ...SQL_EDITOR_OPTIONS, lineNumbersMinChars: 2 }}
        />
      </div>

      <div className="redis-cli-actionbar">
        <span className="redis-cli-pos">
          {t('redis.cliPosition', { line: pos.line, col: pos.col })}
        </span>
        <span className="redis-value-meta">{t('redis.commandsKnown', { n: COMMANDS.length })}</span>
        <div className="redis-keylist-spacer" />
        {QUICK_CMDS.map((q) => (
          <button key={q} onClick={() => runQuick(q)} className="redis-pill" disabled={running}>{q}</button>
        ))}
        <button className="btn btn-secondary redis-value-save" onClick={runAll} disabled={running}>
          <ListChecks size={11} /> {t('redis.cliRunAll')}
        </button>
        <button className="btn btn-primary redis-value-save" onClick={runCurrent} disabled={running}>
          <Play size={11} /> {t('redis.runCommand')}
        </button>
      </div>

      <div
        className={`redis-cli-resizer${dragging ? ' dragging' : ''}`}
        onMouseDown={startDrag}
        title={t('redis.cliResizeHint')}
      />

      <div className="redis-cli-result-head">
        <span className="redis-cli-result-tab">{t('redis.cliResults')}</span>
        {log.length > 0 && (
          <span className="redis-value-meta">{t('redis.cliResultCount', { n: log.length })}</span>
        )}
        <div className="redis-keylist-spacer" />
        <button className="redis-ghost-btn" onClick={() => setLog([])} disabled={log.length === 0}>
          {t('redis.clearLog')}
        </button>
      </div>

      <div ref={logRef} className="redis-log-box flush">
        {log.length === 0 ? (
          <div className="redis-cli-result-empty">{t('redis.cliResultEmpty')}</div>
        ) : log.map((l, i) => (
          <div key={i} className="redis-console-entry">
            {l.cmd && <div className="redis-console-echo">&gt; {l.cmd}</div>}
            <pre className={`redis-console-out${l.ok ? '' : ' err'}${l.note ? ' note' : ''}`}>{l.out}</pre>
          </div>
        ))}
      </div>

      <div className="redis-cli-status">
        {running ? t('redis.cliStatusRunning') : t('redis.consoleHint')}
      </div>
    </div>
  );
};
