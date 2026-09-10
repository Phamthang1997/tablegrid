import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { X, TerminalSquare, PictureInPicture2, PanelBottom, FileSearch, ScrollText, Maximize2, Minimize2, ExternalLink, Copy, FolderOpen, RefreshCw, Play, Eraser } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import type { DbConnectionConfig, DockerContainerInfo, SshTerminalMessage } from '../utils/dbHelper';
import { openTerminalWindow } from '../utils/terminalWindow';
import { ConfirmDialog } from './ConfirmDialog';

interface TerminalPanelProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  config: DbConnectionConfig;
  profileName?: string;
  onClose: () => void;
  floating?: boolean;          // true = a floating window; false = docked in a tab
  active?: boolean;            // (docked mode) whether this tab is active -> decides shown/hidden
  onToggleFloat?: () => void;  // present -> show the pop-out/dock button
  inOwnWindow?: boolean;       // running in an OS window of its own -> hide "New window" and fill it
  // Whether to show the X in the header. Callers that already have another way to close it (a
  // terminal opened as a tab -> the tab's own X) pass false, so the header does not duplicate it.
  closable?: boolean;
}

// A smart terminal: a profile with SSH gets a remote shell, otherwise a local one.
// Two display modes:
//   - Docked: fills the tab's content area and is visible only while the tab is active (hidden with
//     display:none, NOT unmounted -> the PTY session survives a tab switch).
//   - Floating: a draggable floating window, visible whichever tab is active.
export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  connId,
  config,
  profileName,
  onClose: _onClose,
  floating = false,
  active = true,
  onToggleFloat,
  inOwnWindow = false,
  closable: _closable = true,
}) => {
  const { t } = useTranslation();
  // The shell-opening effect runs once per session (deps: [epoch]) and writes into
  // the xterm buffer from its callbacks. Reading `t` directly would put it in the
  // dependency graph, so switching language would tear down the live PTY.
  const tRef = useRef(t);
  tRef.current = t;

  const containerRef = useRef<HTMLDivElement>(null);
  // crypto.randomUUID rather than Math.random: sessionId identifies a session to the backend and
  // should not be predictable (which also rules out collisions).
  const sessionIdRef = useRef<string>(`term_${crypto.randomUUID()}`);
  const apiRef = useRef<{ input: (d: string) => void } | null>(null);
  const termRef = useRef<Terminal | null>(null);

  const [pos, setPos] = useState({ x: 240, y: 90 });
  const [maximized, setMaximized] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const [logMenu, setLogMenu] = useState(false);
  const [logPaths, setLogPaths] = useState<{ label: string; path: string }[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  // Why log detection failed, so the menu can say it rather than reporting a generic "not found".
  const [detectError, setDetectError] = useState<string | null>(null);
  // Whether the shell session is still alive. This state used to NOT be kept: when the shell died the
  // panel merely printed "[Disconnected]" and every log action still called api.input() into a closed
  // session -> nothing responded to anything.
  const [alive, setAlive] = useState(true);
  // Bumped to reopen the shell session (it is the init effect's dependency).
  const [epoch, setEpoch] = useState(0);

  // Ô run SQL in panel
  const [sqlBar, setSqlBar] = useState(false);
  const [sqlText, setSqlText] = useState('');
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlHistory, setSqlHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  // The app's own message bar, outside the terminal buffer so the shell cannot draw over it.
  const [banner, setBanner] = useState<{ text: string; kind: 'info' | 'ok' | 'err' } | null>(null);
  const bannerTimer = useRef<number | null>(null);
  const [setupMenu, setSetupMenu] = useState(false);
  /** Enable-logging request waiting for confirmation — see handleEnableLog. */
  const [enableLogPrompt, setEnableLogPrompt] = useState<{ kind: string; message: string } | null>(null);

  // The log source: tail run directly (local), wrapped in ssh (a VM), or docker exec/logs (Docker).
  const [logSource, setLogSource] = useState<'local' | 'ssh' | 'docker'>(() => (localStorage.getItem('term_log_source') as any) || 'local');
  const [sshTarget, setSshTarget] = useState(() => localStorage.getItem('term_ssh_target') || '');
  const [dockerContainer, setDockerContainer] = useState(() => localStorage.getItem('term_docker_container') || '');
  useEffect(() => { localStorage.setItem('term_log_source', logSource); }, [logSource]);
  useEffect(() => { localStorage.setItem('term_ssh_target', sshTarget); }, [sshTarget]);
  useEffect(() => { localStorage.setItem('term_docker_container', dockerContainer); }, [dockerContainer]);
  // Clears the message bar's timer on unmount, so no setState lands after the component is gone.
  useEffect(() => () => { if (bannerTimer.current) window.clearTimeout(bannerTimer.current); }, []);

  const [dockerCli, setDockerCli] = useState<'docker' | 'nerdctl'>('docker');
  /**
   * The full path the scan resolved, or `` when nothing was found.
   *
   * Kept because Rust and the SHELL look for the CLI in different places, and the gap is real:
   * `find_docker_cli` probes Rancher Desktop's own directories (%LOCALAPPDATA%\Programs\Rancher
   * Desktop\…, ~/.rd/bin), which are routinely absent from the shell’s PATH. Without the path,
   * the dropdown lists every container and the button then fails with `command not found`.
   */
  const [dockerBinary, setDockerBinary] = useState('');
  const [dockerContainers, setDockerContainers] = useState<DockerContainerInfo[]>([]);
  const [scanningContainers, setScanningContainers] = useState(false);
  const [dockerCustomMode, setDockerCustomMode] = useState(false);
  /**
   * Why the last scan found nothing, already translated — `null` once it found something.
   *
   * An auto-detect feature's whole value is the diagnosis: "install Docker", "start Docker" and
   * "your container is stopped" are three different things to do, and an empty dropdown says none
   * of them. `''` is not used for "no error" because a blank string reads as a message that failed
   * to load.
   */
  const [dockerError, setDockerError] = useState<string | null>(null);
  const [dockerScanned, setDockerScanned] = useState(false);

  /**
   * Is the chosen container one the scan returned?
   *
   * A `<select>` whose `value` matches no `<option>` shows the FIRST option while the state says
   * something else — so the dropdown would name one container and `logs -f` would run on
   * another. That happens two ways: a name typed in custom mode, and a name restored from
   * localStorage for a container that no longer exists. Both are answered by keeping the typed
   * value as a real option rather than by silently changing it.
   */
  const chosenIsListed = dockerContainers.some((c) => (c.name || c.id) === dockerContainer);

  const scanDocker = useCallback(async () => {
    setScanningContainers(true);
    try {
      const cliInfo = await dbHelper.getDockerCliInfo();
      if (cliInfo.available && (cliInfo.cli_type === 'nerdctl' || cliInfo.cli_type === 'docker')) {
        setDockerCli(cliInfo.cli_type);
      }
      setDockerBinary(cliInfo.available ? cliInfo.binary_path : '');
      if (!cliInfo.available) {
        setDockerContainers([]);
        setDockerError(tRef.current('backend.dockerCliMissing'));
        return;
      }
      const list = await dbHelper.listDockerContainers(config.port);
      setDockerContainers(list);
      setDockerError(list.length === 0 ? tRef.current('terminal.dockerNoContainers') : null);
      // Pick the best guess, but never overrule a name the user is already pointing at: `prev` is
      // kept whenever it names a container that came back. The list arrives best-first from Rust,
      // so `list[0]` is the same choice the badge marks.
      setDockerContainer(prev => {
        if (prev.trim() && list.some(c => c.name === prev || c.id === prev)) return prev;
        if (!prev.trim() && list.length > 0) return list[0].name || list[0].id;
        return prev;
      });
    } catch (err) {
      // `listDockerContainers` rethrows the backend's already-translated text.
      setDockerContainers([]);
      setDockerError(String(err));
    } finally {
      setScanningContainers(false);
      setDockerScanned(true);
    }
    // `t` is read through `tRef`, not taken as a dependency: this callback feeds an effect, and
    // `t` changes identity on every language switch — depending on it would re-scan (and so
    // re-spawn docker processes) each time the user switches language.
  }, [config.port]);

  useEffect(() => {
    if (logSource === 'docker' && logMenu) {
      void scanDocker();
    }
  }, [logSource, logMenu, scanDocker]);

  const useSsh = !!(config.sshEnabled && config.sshHost);

  useEffect(() => {
    if (!containerRef.current) return;
    // Every reconnect needs a fresh sessionId: the backend keys sessions by id, and reusing an old
    // (already closed) one cannot open.
    if (epoch > 0) {
      sessionIdRef.current = `term_${crypto.randomUUID()}`;
    }
    const sessionId = sessionIdRef.current;
    setAlive(true);

    const api = useSsh
      ? {
          open: (c: number, r: number, cb: (m: SshTerminalMessage) => void) =>
            dbHelper.openSshTerminal(config, sessionId, c, r, cb),
          input: (d: string) => dbHelper.sendSshInput(sessionId, d),
          resize: (c: number, r: number) => dbHelper.resizeSshTerminal(sessionId, c, r),
          close: () => dbHelper.closeSshTerminal(sessionId),
        }
      : {
          open: (c: number, r: number, cb: (m: SshTerminalMessage) => void) =>
            dbHelper.openLocalTerminal(sessionId, c, r, cb),
          input: (d: string) => dbHelper.sendLocalInput(sessionId, d),
          resize: (c: number, r: number) => dbHelper.resizeLocalTerminal(sessionId, c, r),
          close: () => dbHelper.closeLocalTerminal(sessionId),
        };
    apiRef.current = { input: api.input };

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      theme: { background: '#1c1c1e', foreground: '#e5e5e7' },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    const doFit = () => { try { fit.fit(); } catch { /* ignore */ } };
    // Fitted IMMEDIATELY (synchronously) before the PTY opens, so its rows and columns match xterm
    // from the start; otherwise ConPTY wraps at 80 columns while xterm is wider -> text lands in the
    // wrong columns and looks scrambled.
    doFit();

    const dataSub = term.onData((d) => { void api.input(d); });
    const resizeSub = term.onResize(({ cols, rows }) => { void api.resize(cols, rows); });

    let disposed = false;

    api
      .open(term.cols, term.rows, (msg) => {
        if (disposed) return;
        if (msg.type === 'data' && msg.bytes) {
          term.write(new Uint8Array(msg.bytes));
        } else if (msg.type === 'exit') {
          // '\x1b[2K' clears the current line before printing, so it cannot overwrite a line the
          // shell is midway through ('\r\n' alone would put the cursor back at column 0 and write
          // over the text).
          term.write('\r\n\x1b[2K');
          term.writeln(`\x1b[33m${tRef.current('terminal.sessionExited', { code: msg.code ?? 0 })}\x1b[0m`);
          term.writeln(`\x1b[33m${tRef.current('terminal.reconnectHint')}\x1b[0m`);
          setAlive(false);
        } else if (msg.type === 'closed') {
          term.write('\r\n\x1b[2K');
          term.writeln(`\x1b[31m${tRef.current('terminal.disconnected')}\x1b[0m`);
          term.writeln(`\x1b[31m${tRef.current('terminal.reconnectHint')}\x1b[0m`);
          setAlive(false);
        }
      })
      .catch((e) => {
        if (!disposed) {
          term.write('\r\n\x1b[2K');
          term.writeln(`\x1b[31m${tRef.current('terminal.errOpen', { message: String(e) })}\x1b[0m`);
        }
        setAlive(false);
      });

    // Fitted again once the layout has settled, in case the first synchronous fit measured wrongly
    setTimeout(doFit, 60);
    const ro = new ResizeObserver(() => doFit());
    ro.observe(containerRef.current);
    const onWinResize = () => doFit();
    window.addEventListener('resize', onWinResize);

    return () => {
      disposed = true;
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      dataSub.dispose();
      resizeSub.dispose();
      void api.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  const startDrag = (e: React.MouseEvent) => {
    if (!floating || maximized) return; // draggable only while floating and not maximized
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({ x: Math.max(0, d.ox + ev.clientX - d.sx), y: Math.max(0, d.oy + ev.clientY - d.sy) });
    };
    const up = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const handleDetectLog = async () => {
    if (logPaths && !detecting) { setLogMenu(m => !m); return; }
    setDetecting(true);
    setLogMenu(true);
    setDetectError(null);
    const det = await dbHelper.detectLogPaths(connId, config.type);
    setLogPaths(det.paths);
    setDetectError(det.error || null);
    setDetecting(false);
  };

  // Windows: Get-Content -Wait does not keep up with what mysqld appends, and ReadLine() cuts a
  // half-written line while MySQL's log ends lines with \n and no \r -> xterm draws a "staircase".
  // So: open with FileShare.ReadWrite, seek to the end, read RAW ReadToEnd() every 250ms, and
  // normalise to \r\n before printing.
  // Escaping for a PowerShell single-quoted string: ' -> '' (so a path containing one cannot break
  // the command)
  const psq = (p: string) => p.replace(/'/g, "''");

  const winTail = (p: string) =>
    `$p='${psq(p)}'; $fs=[System.IO.File]::Open($p,'Open','Read','ReadWrite'); $sr=New-Object System.IO.StreamReader($fs,[System.Text.Encoding]::UTF8); [void]$fs.Seek(0,'End'); $cr=[char]13; $lf=[char]10; Write-Host '--- theo doi log (Ctrl+C de dung) ---'; while($true){ $c=$sr.ReadToEnd(); if($c.Length -gt 0){ [Console]::Out.Write($c.Replace($cr.ToString(),'').Replace($lf.ToString(),$cr.ToString()+$lf.ToString())); [Console]::Out.Flush() } else { Start-Sleep -Milliseconds 250 } }`;

  const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);

  /** Escaping for a POSIX single-quoted string, the twin of `psq` above. */
  const shq = (v: string) => v.replace(/'/g, "'\\''");

  /**
   * The docker/nerdctl command as the shell that receives it must spell it.
   *
   * Three cases, and the SSH one is why this cannot simply always use the resolved path: over
   * SSH the shell runs on another machine, so a path this app probed locally names nothing there
   * -- the bare word is the only thing that can work, and it is the remote host's own docker that
   * should answer anyway. Locally the resolved path is what closes the gap described on
   * `dockerBinary`. The local shell is `powershell.exe` on Windows and $SHELL elsewhere
   * (`terminal/local.rs`), so the quoting splits on the same flag the tail command already uses,
   * and PowerShell needs the call operator before a quoted path or it treats it as a string.
   */
  const dockerExe = () => {
    if (useSsh || !dockerBinary) return dockerCli;
    return isWindows ? `& '${psq(dockerBinary)}'` : `'${shq(dockerBinary)}'`;
  };

  // The tail and list commands depend on the LOG SOURCE:
  // - docker: run exec on container to tail or list
  // - ssh: run ssh to tail or list on VM
  // - local: run straight in current shell (remote Linux when SSH, or host OS)
  const src = (): 'local' | 'ssh' | 'docker' =>
    (logSource === 'ssh' && sshTarget.trim()) ? 'ssh'
      : logSource === 'docker' ? 'docker'
        : 'local';

  // Both builders assume a container is chosen when the source is docker; `runItem` is the only
  // caller and refuses first. An earlier version fell back to `docker logs -f --tail 100` with no
  // container argument, which is not a valid command -- dead code that reads like a real one is
  // what the next caller copies.
  const tailCommand = (p: string) => {
    switch (src()) {
      case 'ssh': return `ssh ${sshTarget.trim()} "tail -f '${p}'"`;
      case 'docker': return `${dockerExe()} exec ${dockerContainer.trim()} tail -f '${p}'`;
      default: return (useSsh || !isWindows) ? `tail -f "${p}"` : winTail(p);
    }
  };

  // datadir or log_directory is a DIRECTORY -> it cannot be tailed, so its files are listed instead.
  const isFolder = (lp: { label: string; path: string }) =>
    lp.label === 'datadir' || lp.label === 'log_directory' || /[\\/]$/.test(lp.path) || /[\\/]log$/.test(lp.path);

  const listCommand = (p: string) => {
    switch (src()) {
      case 'ssh': return `ssh ${sshTarget.trim()} "ls -lah '${p}'"`;
      case 'docker': return `${dockerExe()} exec ${dockerContainer.trim()} ls -lah '${p}'`;
      default: return (useSsh || !isWindows)
        ? `ls -lah "${p}"`
        : `Get-ChildItem -Path '${psq(p)}' -Filter *.log | Format-Table Name,Length,LastWriteTime -AutoSize`;
    }
  };

  // ——— Running SQL right in the panel ———
  // The SQL does NOT go through the shell: it runs on the current DB connection and prints its result
  // into the terminal, so it still works after the shell session has died.
  const MAX_SQL_ROWS = 50;
  const MAX_CELL = 28;

  const ansi = {
    dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
    head: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
    ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
    err: (s: string) => `\x1b[31m${s}\x1b[0m`,
  };

  const cellText = (v: any) => {
    if (v === null || v === undefined) return 'NULL';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > MAX_CELL ? s.slice(0, MAX_CELL - 1) + '…' : s;
  };

  // Prints the result as an ASCII table, with columns sized to the real content width.
  const printTable = (columns: string[], rows: any[]) => {
    const term = termRef.current;
    if (!term) return;
    const shown = rows.slice(0, MAX_SQL_ROWS);
    const widths = columns.map((c, i) =>
      Math.max(c.length, ...shown.map(r => cellText(Object.values(r)[i]).length), 3)
    );
    const line = (l: string, m: string, r: string) =>
      ansi.dim(l + widths.map(w => '─'.repeat(w + 2)).join(m) + r);
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

    term.writeln(line('┌', '┬', '┐'));
    term.writeln(ansi.dim('│') + columns.map((c, i) => ' ' + ansi.head(pad(c, widths[i])) + ' ').join(ansi.dim('│')) + ansi.dim('│'));
    term.writeln(line('├', '┼', '┤'));
    for (const row of shown) {
      const vals = Object.values(row);
      term.writeln(
        ansi.dim('│') +
        // Not named `t` — that is the translation function.
        columns.map((_, i) => {
          const cell = cellText(vals[i]);
          return ' ' + (cell === 'NULL' ? ansi.dim(pad(cell, widths[i])) : pad(cell, widths[i])) + ' ';
        }).join(ansi.dim('│')) +
        ansi.dim('│')
      );
    }
    term.writeln(line('└', '┴', '┘'));
    term.writeln(ansi.dim(
      rows.length > MAX_SQL_ROWS
        ? t('terminal.rowCountClipped', { n: rows.length, shown: MAX_SQL_ROWS })
        : t('terminal.rowCount', { n: rows.length })
    ));
  };

  const runSql = async () => {
    const sql = sqlText.trim();
    if (!sql || sqlBusy) return;
    const term = termRef.current;
    setSqlBusy(true);
    setSqlHistory(h => (h[h.length - 1] === sql ? h : [...h, sql]).slice(-50));
    setHistIdx(null);
    freshLine();
    term?.writeln(`\x1b[1;35msql>\x1b[0m ${sql}`);
    try {
      const res = await dbHelper.executeQueryMulti(connId, sql);
      if (!res.success) {
        term?.writeln(ansi.err(t('terminal.sqlError', { message: res.error || t('terminal.unknownReason') })));
      } else {
        for (const r of res.results) {
          if (r.columns && r.columns.length > 0) {
            printTable(r.columns, r.data || []);
          } else {
            // A statement returning no table (INSERT/UPDATE/DDL…)
            term?.writeln(ansi.ok(t('terminal.sqlOk')));
          }
        }
        if (res.results.length === 0) term?.writeln(ansi.ok(t('terminal.sqlOk')));
      }
    } catch (e: any) {
      term?.writeln(ansi.err(t('terminal.sqlError', { message: e?.message || e })));
    } finally {
      setSqlBusy(false);
      setSqlText('');
    }
  };

  // Every log action works by TYPING A COMMAND into the shell. With the session dead, api.input()
  // vanishes into nothing without a word — so it is refused here and said out loud.
  const sendCommand = (cmd: string) => {
    if (!alive) {
      note(t('terminal.errSessionClosed'), 'err');
      return false;
    }
    apiRef.current?.input(cmd + '\r');
    return true;
  };

  // Docker: container logs via logs -f or exec sh
  const dockerLogs = () => {
    const target = dockerContainer.trim();
    if (!target) {
      note(t('terminal.errNoContainerSelected'), 'err');
      return;
    }
    if (sendCommand(`${dockerExe()} logs -f --tail 100 ${target}`)) setLogMenu(false);
  };

  const dockerShell = () => {
    const target = dockerContainer.trim();
    if (!target) {
      note(t('terminal.errNoContainerSelected'), 'err');
      return;
    }
    if (sendCommand(`${dockerExe()} exec -it ${target} sh`)) setLogMenu(false);
  };

  const runItem = (lp: { label: string; path: string }) => {
    if (src() === 'docker' && !dockerContainer.trim()) {
      note(t('terminal.errNoContainerSelected'), 'err');
      return;
    }
    if (sendCommand(isFolder(lp) ? listCommand(lp.path) : tailCommand(lp.path))) setLogMenu(false);
  };

  const copyPath = (p: string) => { try { navigator.clipboard?.writeText(p); } catch { /* ignore */ } };

  const freshLine = () => termRef.current?.write('\r\n\x1b[2K');

  // The app's messages appear in a BAR OF THEIR OWN and are no longer written into the terminal
  // buffer. The reason: PowerShell/PSReadLine redraws its line with cursor movement (\r, \x1b[A)
  // and owns the cursor — anything the app inserts into the buffer can be drawn over by the shell.
  // '\x1b[2K' does not solve it, because this is a race over the cursor, not a missing newline.
  const note = (s: string, kind: 'info' | 'ok' | 'err' = 'info') => {
    setBanner({ text: s, kind });
    if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), kind === 'err' ? 9000 : 5000);
  };

  // Enabling logging writes to the server config, so it must still be confirmed;
  // window.confirm shows nothing in the Tauri webview (the dialog plugin has no `confirm`
  // command), so clicking the menu entry used to run straight through without asking.
  const handleEnableLog = (kind: string, confirmMsg: string) => {
    setSetupMenu(false);
    setEnableLogPrompt({ kind, message: confirmMsg });
  };

  const doEnableLog = async (kind: string) => {
    note(t('terminal.enablingLog'));
    const res = await dbHelper.enableLogging(connId, config.type, kind);
    if (!res.success) {
      note(t('terminal.errEnableLog', { message: res.message || t('terminal.errEnableLogPerm') }), 'err');
      return;
    }
    if (res.needsRestart) {
      note(t('terminal.needsRestart'), 'err');
      return;
    }
    note(t('terminal.logEnabledDetecting'));
    const det = await dbHelper.detectLogPaths(connId, config.type);
    setLogPaths(det.paths);
    setDetectError(det.error || null);
    setLogMenu(true);
    // The result is printed straight into the terminal: this used to only open a menu, and an empty
    // menu left the user watching it stall at "Detecting paths…" with no explanation.
    if (det.error) {
      note(t('terminal.errDetectPaths', { message: det.error }), 'err');
    } else if (det.paths.length === 0) {
      note(t('terminal.noLogPaths'));
    } else {
      note(t('terminal.foundLogPaths', { n: det.paths.length }), 'ok');
    }
  };

  const handleDisableLog = async (kind: string) => {
    setSetupMenu(false);
    const res = await dbHelper.disableLogging(connId, config.type, kind);
    note(
      res.success ? t('terminal.logDisabled') : t('terminal.errDisableLog', { message: res.message }),
      res.success ? 'ok' : 'err'
    );
  };

  // The per-dialect log toggles
  const setupItems: { label: string; danger?: boolean; onClick: () => void }[] = (() => {
    if (config.type === 'mysql') {
      return [
        { label: t('terminal.mysqlEnableSlow'), onClick: () => handleEnableLog('slow', t('terminal.mysqlEnableSlowConfirm')) },
        { label: t('terminal.mysqlEnableGeneral'), onClick: () => handleEnableLog('general', t('terminal.mysqlEnableGeneralConfirm')) },
        { label: t('terminal.mysqlDisableSlow'), danger: true, onClick: () => handleDisableLog('slow') },
        { label: t('terminal.mysqlDisableGeneral'), danger: true, onClick: () => handleDisableLog('general') },
      ];
    }
    if (config.type === 'postgres') {
      return [
        { label: t('terminal.pgEnableStatements'), onClick: () => handleEnableLog('statements', t('terminal.pgEnableStatementsConfirm')) },
        { label: t('terminal.pgEnableCollector'), onClick: () => handleEnableLog('collector', t('terminal.pgEnableCollectorConfirm')) },
        { label: t('terminal.pgDisableStatements'), danger: true, onClick: () => handleDisableLog('statements') },
      ];
    }
    return [];
  })();

  const title = useSsh ? 'SSH Terminal' : 'Local Terminal';
  const subtitle = useSsh
    ? `${config.sshUser || 'root'}@${config.sshHost}:${config.sshPort || 22}`
    : t('terminal.localShell');

  // The base style per mode
  const rootStyle: React.CSSProperties = floating
    ? (maximized
        // Full = fills the app's content area (it does not cover the title bar, tab strip or sidebar)
        ? { position: 'absolute', inset: 0, zIndex: 40 }
        : {
            position: 'fixed', top: pos.y, left: pos.x,
            width: '820px', height: '460px', minWidth: '420px', minHeight: '240px',
            resize: 'both', overflow: 'hidden', zIndex: 5000,
          })
    : {
        position: 'absolute', inset: 0,
        display: active ? 'flex' : 'none',
      };

  return (
    <div
      className={`tp-panel ${floating && !maximized ? 'floating-panel' : ''}`}
      style={{
        ...rootStyle,
        display: floating ? 'flex' : (active ? 'flex' : 'none'),
      }}
    >
      <div
        className={`tp-header ${floating ? 'floating-header' : ''}`}
        onMouseDown={startDrag}
      >
        {/* The heading: adds a session light (green = running, red = closed) and puts the name and
            address on two rows, so a narrow window is not cramped. */}
        <div className="tp-title">
          <TerminalSquare size={15} className="tp-title-icon" />
          <span className={`tp-dot ${alive ? 'on' : 'off'}`} title={alive ? t('terminal.sessionAlive') : t('terminal.sessionDead')} />
          <div>
            <div className="tp-title-main">{title}{profileName ? ` — ${profileName}` : ''}</div>
            <div className="tp-title-sub">{subtitle}</div>
          </div>
        </div>
        <div className="tp-actions" onMouseDown={(e) => e.stopPropagation()}>
          {/* With the session dead the panel is a brick: the shell is opened once in the init effect
              and there is no way back other than closing the terminal entirely. */}
          {!alive && (
            <button className="tp-btn warn" onClick={() => setEpoch(e => e + 1)} title={t('terminal.reconnectTitle')}>
              <RefreshCw size={13} />
              <span>{t('terminal.reconnect')}</span>
            </button>
          )}

          {/* Running SQL: it does not go through the shell, so it works even with the session closed */}
          {config.type !== 'redis' && (
            <button
              className={`tp-btn ${sqlBar ? 'on' : ''}`}
              onClick={() => { setSqlBar(v => !v); setLogMenu(false); setSetupMenu(false); }}
              title={t('terminal.runSqlTitle')}
            >
              <Play size={12} />
              <span>{t('terminal.sqlBtn')}</span>
            </button>
          )}

          {/* Enabling logging (MySQL/Postgres only) */}
          {config.type !== 'sqlite' && (
            <div className="tp-dropdown-wrap">
              <button
                className="tp-btn"
                onClick={() => { setSetupMenu(m => !m); setLogMenu(false); }}
                title={t('terminal.setupLogTitle')}
              >
                <ScrollText size={13} />
                <span>{t('terminal.setupLog')}</span>
              </button>
              {setupMenu && (
                <>
                  <div className="tp-backdrop" onClick={() => setSetupMenu(false)} />
                  <div className="tp-menu tp-setup-menu">
                    {setupItems.map((it, i) => (
                      <button
                        key={i}
                        className={`context-menu-item tp-menu-item ${it.danger ? 'danger' : ''}`}
                        onClick={it.onClick}
                      >
                        {it.label}
                      </button>
                    ))}
                    <div className="tp-menu-note">
                      {t('terminal.setupLogNote')}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {/* scan log */}
          <div className="tp-dropdown-wrap">
            <button
              className="tp-btn"
              onClick={handleDetectLog}
              title={t('terminal.findLogsTitle')}
            >
              <FileSearch size={13} />
              <span>{t('terminal.findLogs')}</span>
            </button>
            {logMenu && (
              <>
                <div className="tp-backdrop" onClick={() => setLogMenu(false)} />
                <div className="tp-menu tp-log-menu">
                  {/* The log source: Local / SSH (VM) / Docker */}
                  <div className="tp-log-source-box">
                    <div className="tp-log-source-label">{t('terminal.logSource')}</div>
                    <div className="tp-log-source-btns">
                      {(['local', 'ssh', 'docker'] as const).map(m => (
                        <button
                          key={m}
                          onClick={() => setLogSource(m)}
                          className={`tp-btn tp-btn-flex ${logSource === m ? 'on' : ''}`}
                        >
                          {m === 'local' ? 'Local' : m === 'ssh' ? 'SSH (VM)' : 'Docker'}
                        </button>
                      ))}
                    </div>
                    {logSource === 'ssh' && (
                      <input
                        value={sshTarget}
                        onChange={(e) => setSshTarget(e.target.value)}
                        placeholder={t('terminal.sshPlaceholder')}
                        className="tp-ssh-input"
                      />
                    )}
                    {logSource === 'docker' && (
                      <div className="tp-docker-box">
                        <div className="tp-docker-header">
                          <span
                            className="tp-docker-badge"
                            title={dockerBinary || undefined}
                          >
                            {t('terminal.dockerCliLabel', { cli: dockerCli })}
                          </span>
                          <button
                            type="button"
                            className="tp-docker-btn"
                            onClick={() => void scanDocker()}
                            disabled={scanningContainers}
                            title={t('terminal.dockerScan')}
                          >
                            <RefreshCw size={11} className={scanningContainers ? 'tp-spin' : ''} />
                            <span>{scanningContainers ? t('terminal.dockerScanning') : t('terminal.dockerScan')}</span>
                          </button>
                        </div>

                        {!dockerCustomMode && dockerContainers.length > 0 ? (
                          <select
                            className="tp-docker-select"
                            value={dockerContainer}
                            onChange={(e) => {
                              if (e.target.value === '__custom__') {
                                setDockerCustomMode(true);
                              } else {
                                setDockerContainer(e.target.value);
                              }
                            }}
                          >
                            {dockerContainer && !chosenIsListed && (
                              <option value={dockerContainer}>
                                {`${dockerContainer} — ${t('terminal.dockerNotListed')}`}
                              </option>
                            )}
                            {dockerContainers.map((c) => (
                              <option key={c.id} value={c.name || c.id}>
                                {c.matched_host_port
                                  ? `[${t('terminal.dockerMatchedBadge')}] `
                                  : c.matched_container_port
                                    ? `[${t('terminal.dockerMatchedImageBadge')}] `
                                    : ''}
                                {c.running ? '' : `[${t('terminal.dockerStopped')}] `}
                                {c.name || c.id} ({c.image})
                              </option>
                            ))}
                            <option value="__custom__">
                              {`✎ ${t('terminal.dockerCustomInput')}`}
                            </option>
                          </select>
                        ) : (
                          <div className="tp-docker-custom-row">
                            <input
                              type="text"
                              className="tp-docker-input"
                              value={dockerContainer}
                              onChange={(e) => setDockerContainer(e.target.value)}
                              placeholder={t('terminal.dockerContainerPlaceholder')}
                            />
                            {dockerContainers.length > 0 && (
                              <button
                                type="button"
                                className="tp-docker-btn"
                                onClick={() => setDockerCustomMode(false)}
                                title={t('terminal.dockerSelectContainer')}
                              >
                                📋
                              </button>
                            )}
                          </div>
                        )}

                        {/* The reason, not just an empty dropdown — see `dockerError`. */}
                        {dockerScanned && !scanningContainers && dockerError && (
                          <div className="tp-docker-note">{dockerError}</div>
                        )}

                        <div className="tp-docker-actions">
                          <button
                            type="button"
                            className="tp-docker-btn primary"
                            onClick={dockerLogs}
                            disabled={!dockerContainer.trim()}
                            title={t('terminal.dockerStreamLogs')}
                          >
                            <Play size={11} />
                            <span>{t('terminal.dockerStreamLogs')}</span>
                          </button>
                          <button
                            type="button"
                            className="tp-docker-btn"
                            onClick={dockerShell}
                            disabled={!dockerContainer.trim()}
                            title={t('terminal.dockerShell')}
                          >
                            <TerminalSquare size={11} />
                            <span>{t('terminal.dockerShell')}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontWeight: 600 }}>
                    {t('terminal.logPathsHint')}
                  </div>
                  <div style={{ maxHeight: '300px', overflowY: 'auto', padding: '4px' }}>
                    {detecting ? (
                      <div style={{ padding: '10px', color: 'var(--win-text-secondary)' }}>{t('terminal.detecting')}</div>
                    ) : logPaths && logPaths.length > 0 ? (
                      logPaths.map((lp, i) => {
                        const folder = isFolder(lp);
                        return (
                          <div
                            key={i}
                            className="context-menu-item tp-log-item"
                            onClick={() => runItem(lp)}
                            title={folder ? t('terminal.listInFolder', { path: lp.path }) : t('terminal.tailPath', { path: lp.path })}
                          >
                            {folder ? <FolderOpen size={14} className="tp-folder-icon" /> : <FileSearch size={14} className="tp-file-icon" />}
                            <div className="tp-log-item-info">
                              <div className="tp-log-item-title">
                                {lp.label}{folder ? t('terminal.folderSuffix') : ''}
                              </div>
                              <div className="tp-log-item-path">{lp.path}</div>
                            </div>
                            <button
                              className="tp-btn tp-btn-icon"
                              onClick={(e) => { e.stopPropagation(); copyPath(lp.path); }}
                              title={t('terminal.copyPath')}
                            >
                              <Copy size={12} />
                            </button>
                          </div>
                        );
                      })
                    ) : detectError ? (
                      /* Shows the database's own error (connection lost, missing privilege…) rather
                         than folding it into a generic "no log file found". */
                      <div style={{ padding: '10px', color: 'var(--st-danger)', lineHeight: 1.5 }}>
                        {t('terminal.errDetectHeading')}
                        <div style={{ marginTop: '4px', color: 'var(--win-text-secondary)', fontFamily: 'var(--win-font-mono)', fontSize: '10px', whiteSpace: 'pre-wrap' }}>
                          {detectError}
                        </div>
                      </div>
                    ) : (
                      <div style={{ padding: '10px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                        {t('terminal.noLogFile')}{' '}
                        <Trans i18nKey="terminal.noLogFileHint" components={{ code: <code /> }} />
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {!inOwnWindow && (
            <button
              className="tp-btn tp-btn-icon"
              onClick={() => openTerminalWindow(config, profileName)}
              title={t('terminal.openInOwnWindow')}
            >
              <ExternalLink size={13} />
            </button>
          )}
          {floating && (
            <button
              className="tp-btn tp-btn-icon"
              onClick={() => setMaximized(m => !m)}
              title={maximized ? t('terminal.restoreWindow') : t('terminal.fullScreen')}
            >
              {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          )}
          {onToggleFloat && (
            <button
              className="tp-btn tp-btn-icon"
              onClick={onToggleFloat}
              title={floating ? t('terminal.dockToTab') : t('terminal.popOut')}
            >
              {floating ? <PanelBottom size={13} /> : <PictureInPicture2 size={13} />}
            </button>
          )}

        </div>
      </div>
      {/* The app's message bar — OUTSIDE the terminal buffer, so the shell cannot draw over it
          (PSReadLine owns the cursor and redraws its line itself). */}
      {banner && (
        <div className={`tp-banner ${banner.kind}`}>
          <span>{banner.text}</span>
          <button className="tp-banner-close" onClick={() => setBanner(null)} title={t('common.close')} aria-label={t('common.close')}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* The SQL box: between the header and the terminal, with results printed into the terminal below */}
      {sqlBar && (
        <div className="tp-sqlbar">
          <span className="tp-sql-prompt">sql&gt;</span>
          <input
            className="tp-sql-input"
            value={sqlText}
            onChange={(e) => { setSqlText(e.target.value); setHistIdx(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { void runSql(); return; }
              if (e.key === 'Escape') { setSqlBar(false); return; }
              // Up/down arrows walk back through the statements already run, like a real REPL
              if (e.key === 'ArrowUp' && sqlHistory.length) {
                e.preventDefault();
                const i = histIdx === null ? sqlHistory.length - 1 : Math.max(0, histIdx - 1);
                setHistIdx(i); setSqlText(sqlHistory[i]);
              }
              if (e.key === 'ArrowDown' && histIdx !== null) {
                e.preventDefault();
                const i = histIdx + 1;
                if (i >= sqlHistory.length) { setHistIdx(null); setSqlText(''); }
                else { setHistIdx(i); setSqlText(sqlHistory[i]); }
              }
            }}
            placeholder={sqlHistory.length ? t('terminal.sqlPlaceholderHistory') : t('terminal.sqlPlaceholder')}
            spellCheck={false}
            autoFocus
          />
          <button className="tp-btn" onClick={() => void runSql()} disabled={sqlBusy || !sqlText.trim()} title={t('terminal.runTitle')}>
            {sqlBusy ? <RefreshCw size={12} className="loading-spinner" /> : <Play size={12} />}
            <span>{t('terminal.run')}</span>
          </button>
          <button className="tp-btn" onClick={() => { termRef.current?.clear(); }} title={t('terminal.clearScreen')}>
            <Eraser size={12} />
          </button>
        </div>
      )}

      <div ref={containerRef} className="tp-body" />

      {/* Enable-logging confirmation — the question comes from the menu entry itself
          (one wording per log kind). */}
      {enableLogPrompt && (
        <ConfirmDialog
          open
          title={t('terminal.enableLogTitle')}
          message={enableLogPrompt.message}
          onConfirm={() => { const kind = enableLogPrompt.kind; setEnableLogPrompt(null); doEnableLog(kind); }}
          onCancel={() => setEnableLogPrompt(null)}
        />
      )}
    </div>
  );
};
