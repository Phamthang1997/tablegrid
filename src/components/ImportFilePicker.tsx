import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { pickOpenFile } from '../utils/fileSave';
import { dbHelper } from '../utils/dbHelper';
import { fileBaseName } from '../utils/dumpPreview';
import type { FileDetect, ImportKind } from '../utils/tableImport';

interface ImportFilePickerProps {
  open: boolean;
  /** The target table, when importing into an existing one. Empty = create a new table from the file. */
  targetTable?: string | null;
  onCancel: () => void;
  /** Called with the chosen file's PATH and what it was detected to be. */
  onConfirm: (path: string, detected: FileDetect) => void;
}

/** What the native dialog offers first; "All files" is there too, since what a file IS comes from its bytes. */
const DATA_EXTENSIONS = ['csv', 'tsv', 'txt', 'json', 'ndjson', 'jsonl', 'xlsx', 'sql', 'gz', 'zip', 'dump', 'backup', 'tar'];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * A dialog shown BEFORE the import itself: it states the target, says which files are accepted, and
 * lets the user pick one with the OS dialog. It hands on a PATH, not a `File` — the file is read in
 * Rust from disk, so its size does not matter (a `File` from an `<input>` gives no path, and reading
 * one into the webview is what used to crash the app on a large file). What the file is — CSV, JSON,
 * Excel, a SQL dump, gzipped or zipped — is detected from its bytes (`import_file_detect`).
 */
export const ImportFilePicker: React.FC<ImportFilePickerProps> = ({ open, targetTable, onCancel, onConfirm }) => {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const [detected, setDetected] = useState<FileDetect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every reopen is a new import -> the previous run's file and errors are cleared.
  useEffect(() => {
    queueMicrotask(() => {
      if (open) {
        setPath(null);
        setDetected(null);
        setError(null);
      }
    });
  }, [open]);

  if (!open) return null;

  const kindLabel = (k: ImportKind) => {
    switch (k) {
      case 'csv':
        return t('importPicker.kindCsv');
      case 'json':
        return t('importPicker.kindJson');
      case 'xlsx':
        return t('importPicker.kindXlsx');
      case 'sql':
        return t('importPicker.kindSql');
    }
  };

  const browse = async () => {
    const picked = await pickOpenFile({
      title: t('importPicker.pickFileTitle'),
      filters: [
        { name: t('importPicker.dataFiles'), extensions: DATA_EXTENSIONS },
        { name: t('importPicker.allFiles'), extensions: ['*'] },
      ],
    });
    if (!picked) return;
    setPath(picked);
    setDetected(null);
    setError(null);
    setBusy(true);
    try {
      setDetected(await dbHelper.importFileDetect(picked));
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const container = detected?.compression === 'zip'
    ? t('importPicker.inZip', { entry: detected.entry ?? '' })
    : detected?.compression === 'gzip'
      ? t('importPicker.gzipped')
      : null;

  return (
    <Modal title={t('importPicker.title')} onClose={onCancel} width="500px" zIndex={10000}>
      <ModalBody>
        <div className="form-group">
          <label className="ifp-label">
            {targetTable ? t('importPicker.targetTable') : t('importPicker.newTableFromFile')}
          </label>
          <input
            type="text"
            className="form-input ifp-readonly"
            readOnly
            value={targetTable || (path ? fileBaseName(path) : '')}
            placeholder={t('importPicker.tableNamePlaceholder')}
          />
        </div>

        <div className="ifp-hint">{t('importPicker.formatsHint')}</div>

        <div className="form-group">
          <label className="ifp-label">{t('importPicker.sourceFile')}</label>
          <div className="ifp-row">
            <input
              type="text"
              className="form-input ifp-path"
              readOnly
              value={path ?? ''}
              placeholder={t('importPicker.noFile')}
              onClick={() => void browse()}
              title={t('importPicker.pickFileTitle')}
            />
            <button type="button" className="btn btn-secondary" onClick={() => void browse()}>
              {t('importPicker.pickFile')}
            </button>
          </div>
          {busy && <div className="ifp-meta">{t('importPicker.detecting')}</div>}
          {detected && (
            <div className="ifp-meta">
              {t('importPicker.detected', { kind: kindLabel(detected.kind) })}
              {container && <> · {container}</>}
              {' · '}
              {t('importPicker.fileSize')} <b>{formatSize(detected.fileBytes)}</b>
            </div>
          )}
          {detected?.kind === 'sql' && <div className="ifp-meta">{t('importPicker.sqlNote')}</div>}
        </div>

        {error && <div className="ifp-error">{error}</div>}
      </ModalBody>

      <ModalFooter>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!path || !detected}
          onClick={() => path && detected && onConfirm(path, detected)}
        >
          {t('importPicker.startImport')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
