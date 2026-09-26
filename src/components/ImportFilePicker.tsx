import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody, ModalFooter } from './Modal';

/**
 * The file formats allowed for import (shared by DataGrid's Import and the Sidebar's context menu).
 * `hintKey` is resolved through `t()` inside the component — this array is module
 * level, so it cannot hold already-translated text.
 */
const IMPORT_FORMATS = [
  { ext: '.csv', label: 'CSV', hintKey: 'importPicker.hintCsv' },
  { ext: '.json', label: 'JSON', hintKey: 'importPicker.hintJson' },
  { ext: '.xlsx', label: 'XLSX', hintKey: 'importPicker.hintXlsx' },
  { ext: '.sql', label: 'SQL', hintKey: 'importPicker.hintSql' },
] as const;

type ImportExt = typeof IMPORT_FORMATS[number]['ext'];

const ALL_ACCEPT = IMPORT_FORMATS.map(f => f.ext).join(',');

interface ImportFilePickerProps {
  open: boolean;
  /** The target table, when importing into an existing one. Empty = create a new table from the file name. */
  targetTable?: string | null;
  onCancel: () => void;
  /** Called when the user presses "Start import" with a valid file. */
  onConfirm: (file: File) => void;
}

/**
 * A dialog shown BEFORE the OS file picker: it states the target table and the allowed formats, shows
 * the chosen file name in an input, and only opens the native dialog when "Choose file" is pressed.
 * Its structure follows the "Export Database" modal, so the import and export flows look alike.
 */
export const ImportFilePicker: React.FC<ImportFilePickerProps> = ({
  open,
  targetTable,
  onCancel,
  onConfirm,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<ImportExt>('.csv');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every reopen is a new import -> the previous run's file and errors are cleared.
  useEffect(() => {
    queueMicrotask(() => {
      if (open) {
        setFile(null);
        setError(null);
      }
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const activeFormat = IMPORT_FORMATS.find(f => f.ext === format)!;

  const handleBrowse = () => inputRef.current?.click();

  const handlePickFormat = (ext: ImportExt) => {
    setFormat(ext);
    // The chosen file no longer matches the new format -> dropped, so nothing is imported as the wrong type.
    if (file && !file.name.toLowerCase().endsWith(ext)) setFile(null);
    setError(null);
  };

  const handlePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] || null;
    e.target.value = ''; // let the same file be chosen again
    if (!picked) return;

    const lower = picked.name.toLowerCase();
    const matched = IMPORT_FORMATS.find(f => lower.endsWith(f.ext));
    if (!matched) {
      setFile(null);
      setError(t('importPicker.errUnsupported', { formats: ALL_ACCEPT.replace(/,/g, ', ') }));
      return;
    }
    // Choosing a file of another format switches the format to match it rather than raising an error.
    if (matched.ext !== format) setFormat(matched.ext);
    setError(null);
    setFile(picked);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--win-text-secondary)',
    display: 'block',
    marginBottom: '6px',
  };

  return (
    <Modal
      title={t('importPicker.title')}
      onClose={onCancel}
      width="500px"
      zIndex={10000}
    >
      <ModalBody>
          <div className="form-group">
            <label style={labelStyle}>
              {targetTable ? t('importPicker.targetTable') : t('importPicker.newTableFromFile')}
            </label>
            <input
              type="text"
              className="form-input"
              readOnly
              value={targetTable || (file ? file.name.replace(/\.[^.]+$/, '') : '')}
              placeholder={t('importPicker.tableNamePlaceholder')}
              style={{ height: '30px', fontSize: '11px', width: '100%', background: 'var(--win-bg-hover)' }}
            />
          </div>

          <div>
            <label style={labelStyle}>
              {t('importPicker.allowedFormats')}
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {IMPORT_FORMATS.map(f => (
                <button
                  key={f.ext}
                  onClick={() => handlePickFormat(f.ext)}
                  style={{
                    padding: '6px 16px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    border: '1px solid var(--win-border)',
                    cursor: 'pointer',
                    background: format === f.ext ? 'var(--win-accent)' : 'transparent',
                    color: format === f.ext ? '#fff' : 'var(--win-text-secondary)',
                    fontWeight: 600
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{
            padding: '10px',
            background: 'var(--win-bg-window)',
            border: '1px solid var(--win-border)',
            borderRadius: '4px',
            fontSize: '11px',
            color: 'var(--win-text-secondary)',
            lineHeight: 1.5
          }}>
            <b style={{ color: 'var(--win-text-primary)', fontFamily: 'monospace' }}>{activeFormat.ext}</b>
            {' — '}{t(activeFormat.hintKey)}
          </div>

          <div className="form-group">
            <label style={labelStyle}>
              {t('importPicker.sourceFile')}
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="form-input"
                readOnly
                value={file ? file.name : ''}
                placeholder={t('importPicker.noFileSelected', { format: activeFormat.label })}
                onClick={handleBrowse}
                style={{ flex: 1, height: '30px', fontSize: '11px', cursor: 'pointer' }}
                title={t('importPicker.pickFileTitle')}
              />
              <button
                className="btn btn-secondary"
                onClick={handleBrowse}
                style={{ padding: '0 12px', whiteSpace: 'nowrap' }}
              >
                {t('importPicker.pickFile')}
              </button>
            </div>
            <input
              type="file"
              ref={inputRef}
              onChange={handlePicked}
              accept={format}
              style={{ display: 'none' }}
            />
            {file && (
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginTop: '6px' }}>
                {t('importPicker.fileSize')} <b style={{ color: 'var(--win-text-primary)' }}>{formatSize(file.size)}</b>
              </div>
            )}
          </div>

          {error && (
            <div style={{
              fontSize: '11px',
              color: 'var(--st-danger, #ff6b6b)',
              background: 'rgba(255,107,107,0.08)',
              border: '1px solid rgba(255,107,107,0.35)',
              borderRadius: '4px',
              padding: '8px 10px'
            }}>
              {error}
            </div>
          )}
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-secondary" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          className="btn btn-primary"
          disabled={!file}
          onClick={() => file && onConfirm(file)}
          style={{
            background: file ? 'var(--win-accent)' : 'var(--win-bg-hover)',
            color: file ? '#fff' : 'var(--win-text-disabled)',
            border: 'none',
            cursor: file ? 'pointer' : 'not-allowed'
          }}
        >
          {t('importPicker.startImport')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
