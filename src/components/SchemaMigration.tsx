import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Trash2, GitCompare, Download, Upload, Copy, Loader } from 'lucide-react';
import {
  listSnapshots,
  saveSnapshot,
  deleteSnapshot,
  captureCurrentSchema,
  diffSchemas,
  buildMigrationSql,
  type SchemaSnapshot,
  type SchemaDiff,
} from '../utils/schemaSnapshot';
import { Modal } from './Modal';

interface SchemaMigrationProps {
  dbType: string;
  database?: string;
  onClose: () => void;
  asTab?: boolean;
}

export const SchemaMigration: React.FC<SchemaMigrationProps> = ({ dbType, database, onClose, asTab = false }) => {
  const { t, i18n } = useTranslation();
  const [snapshots, setSnapshots] = useState<SchemaSnapshot[]>(() => listSnapshots());
  const [snapName, setSnapName] = useState('');
  const [busy, setBusy] = useState<string>(''); // the status message while it is working
  // Separate flag for "an operation is running". The spinner used to be driven by
  // `busy.startsWith('currently')`, which only worked while the message was Vietnamese.
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [migrationSql, setMigrationSql] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = () => setSnapshots(listSnapshots());

  // Read at CAPTURE time, never during render: a placeholder computed in render showed one minute
  // and saved another. The placeholder shows the pattern instead.
  const defaultName = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${database || dbType}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  };

  const handleCapture = async () => {
    setError(null);
    const name = (snapName.trim() || defaultName());
    setWorking(true);
    setBusy(t('migration.capturing', { name }));
    try {
      const snap = await captureCurrentSchema(name, dbType, database);
      saveSnapshot(snap);
      setSnapName('');
      refresh();
      setBusy(t('migration.captured', { name, n: Object.keys(snap.tables).length }));
    } catch (e: any) {
      setError(t('migration.errCapture', { message: e?.message || e }));
      setBusy('');
    } finally {
      setWorking(false);
    }
  };

  const handleDelete = (name: string) => {
    deleteSnapshot(name);
    if (selected === name) { setSelected(null); setDiff(null); setMigrationSql(''); }
    refresh();
  };

  const handleExport = (snap: SchemaSnapshot) => {
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${snap.name}.schema.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const snap = JSON.parse(await file.text()) as SchemaSnapshot;
      if (!snap || !snap.tables || typeof snap.tables !== 'object') throw new Error(t('migration.errInvalidSnapshot'));
      if (!snap.name) snap.name = file.name.replace(/\.schema\.json$|\.json$/i, '');
      saveSnapshot(snap);
      refresh();
      setBusy(t('migration.imported', { name: snap.name }));
    } catch (err: any) {
      setError(t('migration.errReadSnapshot', { message: err?.message || err }));
    }
  };

  const handleCompare = async (name: string) => {
    setError(null);
    setSelected(name);
    setDiff(null);
    setMigrationSql('');
    const baseline = listSnapshots().find((s) => s.name === name);
    if (!baseline) { setError(t('migration.errNoSnapshot')); return; }
    setWorking(true);
    setBusy(t('migration.comparing'));
    try {
      const current = await captureCurrentSchema('__current__', dbType, database);
      const d = diffSchemas(baseline, current);
      setDiff(d);
      if (d.identical) {
        setMigrationSql(t('migration.noDifference'));
      } else {
        const sql = await buildMigrationSql(d, current, baseline, dbType);
        setMigrationSql(sql);
      }
      setBusy('');
    } catch (e: any) {
      setError(t('migration.errCompare', { message: e?.message || e }));
      setBusy('');
    } finally {
      setWorking(false);
    }
  };

  const copySql = () => {
    navigator.clipboard.writeText(migrationSql);
    setBusy(t('migration.copiedSql'));
  };

  const downloadSql = () => {
    const blob = new Blob([migrationSql], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration_${selected || 'schema'}.sql`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const label = { fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' } as React.CSSProperties;

  const content = (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%', width: '100%' }}>
      {/* Left column: snapshots */}
      <div style={{ width: '320px', borderRight: '1px solid var(--win-border)', display: 'flex', flexDirection: 'column', padding: '14px', gap: '10px', overflow: 'hidden', background: 'var(--win-bg-card)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={label}>{t('migration.captureLabel')}</span>
          <input
            type="text"
            value={snapName}
            onChange={(e) => setSnapName(e.target.value)}
            placeholder={t('migration.snapNamePattern', { prefix: database || dbType })}
            style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: '6px' }}>
            <button className="btn btn-primary" onClick={handleCapture} disabled={working} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
              <Camera size={13} /> {t('migration.capture')}
            </button>
            <button className="btn btn-secondary" title={t('migration.importSnapshotTitle')} onClick={() => fileInputRef.current?.click()} style={{ width: '34px', height: '28px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Upload size={14} />
            </button>
            <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />
          </div>
        </div>

        <div style={{ ...label, borderTop: '1px solid var(--win-border)', paddingTop: '8px' }}>{t('migration.savedSnapshots', { n: snapshots.length })}</div>
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {snapshots.length === 0 && <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>{t('migration.noSnapshots')}</div>}
          {snapshots.map((s) => (
            <div
              key={s.name}
              style={{
                border: '1px solid ' + (selected === s.name ? 'var(--win-accent)' : 'var(--win-border)'),
                borderRadius: '4px', padding: '6px 8px', background: selected === s.name ? 'rgba(0,102,204,0.08)' : 'var(--win-bg-window)',
              }}
            >
              <div style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>{s.name}</div>
              <div style={{ fontSize: '10px', color: 'var(--win-text-disabled)', marginTop: '2px' }}>
                {t('migration.snapshotMeta', {
                  n: Object.keys(s.tables || {}).length,
                  date: new Date(s.createdAt).toLocaleString(i18n.language),
                })}
              </div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                <button className="btn btn-primary" onClick={() => handleCompare(s.name)} style={{ flex: 1, height: '26px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '0 8px' }}>
                  <GitCompare size={12} /> {t('migration.compare')}
                </button>
                <button className="btn btn-secondary" title={t('migration.exportFile')} onClick={() => handleExport(s)} style={{ width: '28px', height: '26px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Download size={13} /></button>
                <button className="btn btn-secondary" title={t('migration.deleteSnapshot')} onClick={() => handleDelete(s.name)} style={{ width: '28px', height: '26px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--st-danger)' }}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right column: the diff result and the migration */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '16px', gap: '12px', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
        {error && (
          <div style={{ fontSize: '11px', color: 'var(--st-danger)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '4px', padding: '6px 8px' }}>{error}</div>
        )}
        {busy && !error && (
          <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            {working && <Loader size={12} className="loading-spinner" />}{busy}
          </div>
        )}

        {!selected && !busy && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--win-text-disabled)', fontSize: '12px', textAlign: 'center', padding: '0 24px' }}>
            {t('migration.emptyHint')}
          </div>
        )}

        {diff && (
          <>
            <div style={label}>{t('migration.diffTitle', { name: selected })}</div>
            <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid var(--win-border)', borderRadius: '4px', padding: '8px', fontSize: '11.5px', background: 'var(--win-bg-card)' }}>
              {diff.identical && <div style={{ color: 'var(--win-text-secondary)' }}>{t('migration.identical')}</div>}
              {diff.addedTables.map((name) => (
                <div key={'a' + name} style={{ color: 'var(--st-ok)' }}>{t('migration.tableAdded', { name })}</div>
              ))}
              {diff.droppedTables.map((name) => (
                <div key={'d' + name} style={{ color: 'var(--st-danger)' }}>{t('migration.tableDropped', { name })}</div>
              ))}
              {diff.changedTables.map((c) => (
                <div key={'c' + c.table} style={{ color: 'var(--st-warn)' }}>~ {c.table}: {c.summary.join(', ')}</div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={label}>Migration SQL</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn btn-secondary" onClick={copySql} disabled={!migrationSql} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}><Copy size={11} /> {t('migration.copySql')}</button>
                <button className="btn btn-secondary" onClick={downloadSql} disabled={!migrationSql} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}><Download size={11} /> {t('migration.downloadSql')}</button>
              </div>
            </div>
            <textarea
              readOnly
              value={migrationSql}
              style={{ flex: 1, width: '100%', background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', fontFamily: 'var(--win-font-mono)', fontSize: '11px', padding: '10px', borderRadius: '4px', resize: 'none', outline: 'none' }}
            />
          </>
        )}
      </div>
    </div>
  );

  if (asTab) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', width: '100%', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-card)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <GitCompare size={15} style={{ color: 'var(--win-accent)' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
              Diff Schema &amp; Migration
            </span>
            {database && (
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'var(--win-bg-hover)', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>
                {database}
              </span>
            )}
          </div>
        </div>
        {content}
      </div>
    );
  }

  return (
    <Modal
      title="Diff Schema & Migration"
      icon={<GitCompare size={14} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />}
      onClose={onClose}
      width="860px"
      maxWidth="94vw"
      height="80vh"
      zIndex={10000}
    >
      {content}
    </Modal>
  );
};
