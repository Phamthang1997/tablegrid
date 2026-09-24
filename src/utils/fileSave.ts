import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n';

/**
 * Picking a directory and writing the exported file into it.
 *
 * The npm wrappers of the dialog/fs plugins are not used (this project only has those two plugins'
 * Rust halves), so the `plugin:dialog|open` / `plugin:fs|write_file` commands are called directly.
 * When a direct write is refused (permissions, scope) it falls back to a WebView download, so the
 * file is never lost.
 */

const LAST_DIR_KEY = 'tablegrid.export.lastDir';

/** The directory used for the previous export (pre-filled in the dialog next time). */
export function getLastExportDir(): string {
  try {
    return localStorage.getItem(LAST_DIR_KEY) || '';
  } catch {
    return '';
  }
}

function rememberExportDir(dir: string): void {
  try {
    localStorage.setItem(LAST_DIR_KEY, dir);
  } catch {
    /* localStorage blocked -> ignored; only the convenience is lost */
  }
}

/**
 * Opens the OS file picker.
 * Returns the chosen path, or null when the user cancels or there is no Tauri backend.
 */
export async function pickOpenFile(options?: {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  try {
    const res = await invoke<string | string[] | null>('plugin:dialog|open', {
      options: {
        directory: false,
        multiple: false,
        title: options?.title || i18n.t('fileDialog.pickFileTitle'),
        defaultPath: options?.defaultPath || undefined,
        filters: options?.filters,
      },
    });
    const file = Array.isArray(res) ? res[0] : res;
    return file || null;
  } catch {
    return null;
  }
}

/**
 * Picks a SQLite database file (.db, .sqlite, .sqlite3, .db3, .s3db).
 */
export async function pickSqliteDatabaseFile(defaultPath?: string): Promise<string | null> {
  return pickOpenFile({
    title: i18n.t('fileDialog.pickSqliteTitle'),
    defaultPath,
    filters: [
      {
        name: i18n.t('fileDialog.sqliteFilter'),
        extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db'],
      },
      {
        name: i18n.t('fileDialog.allFilesFilter'),
        extensions: ['*'],
      },
    ],
  });
}

/**
 * Opens the OS directory picker.
 * Returns the chosen path, or null when the user cancels or there is no Tauri backend.
 */
export async function pickExportFolder(defaultPath?: string): Promise<string | null> {
  try {
    const res = await invoke<string | string[] | null>('plugin:dialog|open', {
      options: {
        directory: true,
        multiple: false,
        recursive: false,
        title: i18n.t('fileDialog.pickFolderTitle'),
        defaultPath: defaultPath || undefined,
      },
    });
    const dir = Array.isArray(res) ? res[0] : res;
    if (!dir) return null;
    rememberExportDir(dir);
    return dir;
  } catch {
    return null;
  }
}

/**
 * Opens the OS "Save As" dialog.
 * It lets the user choose a directory AND set or edit the file name.
 */
export async function pickSaveFilePath(
  defaultName: string,
  ext: string,
  filterName?: string
): Promise<string | null> {
  try {
    const fullName = defaultName.endsWith(`.${ext}`) ? defaultName : `${defaultName}.${ext}`;
    const lastDir = getLastExportDir();
    const defaultPath = lastDir ? joinPath(lastDir, fullName) : fullName;

    const res = await invoke<string | null>('plugin:dialog|save', {
      options: {
        title: i18n.t('fileDialog.saveFileTitle'),
        defaultPath,
        filters: [
          {
            name: filterName || i18n.t('fileDialog.defaultFilter'),
            extensions: [ext],
          },
        ],
      },
    });
    if (res) {
      const sepIdx = Math.max(res.lastIndexOf('/'), res.lastIndexOf('\\'));
      if (sepIdx > 0) {
        rememberExportDir(res.substring(0, sepIdx));
      }
    }
    return res || null;
  } catch {
    return null;
  }
}

/** Writes data straight to the full path the Save As dialog returned. */
export async function saveExportFileAtPath(
  filePath: string,
  data: Uint8Array | string,
  mime = 'application/octet-stream'
): Promise<boolean> {
  try {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await invoke('plugin:fs|write_file', bytes, {
      headers: {
        path: encodeURIComponent(filePath),
        options: JSON.stringify({}),
      },
    });
    return true;
  } catch {
    const sepIdx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const fileName = sepIdx >= 0 ? filePath.substring(sepIdx + 1) : filePath;
    downloadViaWebview(fileName, data, mime);
    return false;
  }
}

/** Joins a directory and a file name, keeping the separator the path already uses. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Downloads through the WebView (the Downloads folder, or WebView2's own dialog). */
function downloadViaWebview(name: string, data: Uint8Array | string, mime: string): void {
  const blob = typeof data === 'string'
    ? new Blob([data], { type: mime })
    : new Blob([data.slice().buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface SaveResult {
  /** 'folder' = written into the chosen directory; 'download' = it fell back to a WebView download. */
  savedTo: 'folder' | 'download';
  /** The full path, when writing into a directory succeeded. */
  path?: string;
  /** The directory holding the file (the chosen one, or the system's downloads folder). */
  dir?: string;
  /** Why writing into the directory failed, when it did. */
  fallbackReason?: string;
}

/** Gzips text with the WebView's CompressionStream (Chromium). */
export async function gzipText(text: string): Promise<Uint8Array> {
  const CS = (globalThis as any).CompressionStream;
  if (!CS) throw new Error(i18n.t('errors.noGzipSupport'));
  const stream = new Blob([text]).stream().pipeThrough(new CS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The system's downloads folder (to open when the file went through the WebView). Empty when unavailable. */
export async function resolveDownloadDir(): Promise<string> {
  try {
    const { downloadDir } = await import('@tauri-apps/api/path');
    return await downloadDir();
  } catch {
    return '';
  }
}

/** Opens a directory (or a file) in the system's file manager. */
export async function openInFileManager(pathOrDir: string): Promise<boolean> {
  try {
    await invoke('open_url', { url: pathOrDir });
    return true;
  } catch {
    return false;
  }
}

/** A file being written a chunk at a time by the backend (`export_sink.rs`). */
export interface FileSink {
  /** Queue text; it reaches the backend in batches of about `SINK_BATCH_CHARS`. */
  write(text: string): Promise<void>;
  /** Flush, finish (gzip trailer), and move the `.part` file into place. Resolves to the final path. */
  close(): Promise<string>;
  /** Drop it and delete the partial file. Never throws. */
  abort(): Promise<void>;
}

/**
 * Text gathered before one `export_append` call. A dump emits a chunk per table and per page of
 * rows — often a few KB — and an IPC round trip per chunk would cost more than the write; 1M
 * characters keeps both the call count and the memory held here small.
 */
const SINK_BATCH_CHARS = 1 << 20;

/** Opens `path` for streaming. Throws when the file cannot be created (permissions, bad folder). */
export async function openFileSink(path: string, gzip: boolean): Promise<FileSink> {
  const res = await invoke<{ handle: string }>('export_open', { path, gzip });
  const handle = res.handle;
  let pending: string[] = [];
  let pendingChars = 0;
  const send = async () => {
    if (pendingChars === 0) return;
    const chunk = pending.join('');
    pending = [];
    pendingChars = 0;
    await invoke('export_append', { handle, chunk });
  };
  return {
    async write(text) {
      pending.push(text);
      pendingChars += text.length;
      if (pendingChars >= SINK_BATCH_CHARS) await send();
    },
    async close() {
      await send();
      const done = await invoke<{ path: string }>('export_close', { handle });
      return done.path;
    },
    async abort() {
      pending = [];
      try {
        await invoke('export_abort', { handle });
      } catch {
        /* nothing left to clean */
      }
    },
  };
}

/**
 * Writes a dump into `dir` as it is built, instead of building it as one string first
 * (docs/background-jobs-plan.md, Phase 3). `write` is the producer — `writeDump` bound to its spec
 * and reader — and receives the function each chunk goes to.
 *
 * Falls back to the in-memory path when there is no folder, or the file cannot be created there:
 * `build` then produces the whole text, which is saved the way `saveExportFile` always did (a WebView
 * download as the last resort). The fallback is the old behaviour, so a folder the backend cannot
 * write to costs memory, not the export.
 *
 * A producer that throws — a failed read, a cancelled job — aborts the sink, so no half-written file
 * is left at the chosen name.
 */
export async function saveDumpToFolder(
  dir: string | null,
  name: string,
  gzip: boolean,
  write: (emit: (text: string) => Promise<void>) => Promise<void>,
  build: () => Promise<string>,
): Promise<SaveResult> {
  if (dir) {
    let sink: FileSink | null = null;
    try {
      sink = await openFileSink(joinPath(dir, name), gzip);
    } catch {
      sink = null;
    }
    if (sink) {
      try {
        await write((text) => sink!.write(text));
        const path = await sink.close();
        rememberExportDir(dir);
        return { savedTo: 'folder', path, dir };
      } catch (err) {
        await sink.abort();
        throw err;
      }
    }
  }
  const text = await build();
  const payload = gzip ? await gzipText(text) : text;
  return saveExportFile(dir, name, payload, gzip ? 'application/gzip' : 'text/plain;charset=utf-8');
}

/**
 * Writes an exported file: straight into the directory when there is one, otherwise via a WebView download.
 */
export async function saveExportFile(
  dir: string | null,
  name: string,
  data: Uint8Array | string,
  mime = 'application/octet-stream'
): Promise<SaveResult> {
  if (!dir) {
    downloadViaWebview(name, data, mime);
    return { savedTo: 'download', dir: await resolveDownloadDir() };
  }

  const path = joinPath(dir, name);
  try {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    // The same call shape as @tauri-apps/plugin-fs: the content goes in the body, path and options in the headers.
    await invoke('plugin:fs|write_file', bytes, {
      headers: {
        path: encodeURIComponent(path),
        options: JSON.stringify({}),
      },
    });
    rememberExportDir(dir);
    return { savedTo: 'folder', path, dir };
  } catch (err: any) {
    downloadViaWebview(name, data, mime);
    return {
      savedTo: 'download',
      dir: await resolveDownloadDir(),
      fallbackReason: err?.message || String(err),
    };
  }
}
