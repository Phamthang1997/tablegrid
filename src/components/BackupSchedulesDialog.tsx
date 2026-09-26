import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, CheckCircle2, FolderOpen, Pencil, Play, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { OptionSelect } from './OptionSelect';
import { configWithSecrets, loadSavedProfiles } from '../utils/connectProfile';
import { dbHelper } from '../utils/dbHelper';
import { pickExportFolder, getLastExportDir } from '../utils/fileSave';
import { listJobs, subscribeJobs } from '../utils/jobs';
import {
  backupFileName,
  deleteSchedule,
  HOUR_STEPS,
  KEEP_MAX,
  listSchedules,
  newSchedule,
  nextSlot,
  patchSchedule,
  sanitizePrefix,
  saveSchedule,
  subscribeSchedules,
  validateSchedule,
  type BackupSchedule,
} from '../utils/backupSchedule';
import { isScheduleRunning, scheduleDbLabel, submitScheduledBackup } from '../utils/backupScheduler';
import type { DbConnectionConfig } from '../utils/dbHelper';

/**
 * The scheduled backups: a list, and an editor for one. Opened from the title bar's Database menu
 * and from Connection Manager — schedules belong to saved PROFILES, so they are reachable with
 * nothing connected. The logic is in `utils/backupSchedule.ts` (when) and `backupScheduler.ts` (how);
 * this is only their UI.
 */
export const BackupSchedulesDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t, i18n } = useTranslation();
  const schedules = useSyncExternalStore(subscribeSchedules, listSchedules);
  // Re-rendered when any job moves, so "running" and the last result follow a run as it happens.
  useSyncExternalStore(subscribeJobs, listJobs);
  const profiles = useMemo(() => loadSavedProfiles().filter((p) => p.type !== 'redis'), []);
  const [editing, setEditing] = useState<BackupSchedule | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BackupSchedule | null>(null);
  // The profile's databases, for the picker. Stored WITH the profile they belong to and read back
  // only when it is still the one selected — so switching profiles never shows the previous
  // server's list, and a slow answer for a profile no longer selected is simply ignored.
  const [dbList, setDbList] = useState<{ profileId: string; list: string[] | null; error: string | null }>({
    profileId: '',
    list: null,
    error: null,
  });
  const dbRequest = useRef('');
  const loadDatabases = async (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    dbRequest.current = profileId;
    if (!profile || profile.type === 'sqlite') return;
    setDbList({ profileId, list: null, error: null });
    // Asked through the same form-level call Connection Manager's database picker uses: it opens a
    // short-lived connection from the profile (SSH included), so no connection has to be open here.
    const { config } = await configWithSecrets(profile);
    const res = await dbHelper.getDatabasesList(config as DbConnectionConfig);
    if (dbRequest.current !== profileId) return;
    setDbList(
      res.success
        ? { profileId, list: res.databases, error: null }
        : { profileId, list: null, error: res.error || t('backupSchedule.dbListFailed') },
    );
  };
  // The clock the "next run" line and the file name example read, refreshed while the dialog is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  const profileOf = (id: string) => profiles.find((p) => p.id === id);
  const fmt = (ms: number) =>
    new Date(ms).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const weekdays = [
    t('backupSchedule.sunday'),
    t('backupSchedule.monday'),
    t('backupSchedule.tuesday'),
    t('backupSchedule.wednesday'),
    t('backupSchedule.thursday'),
    t('backupSchedule.friday'),
    t('backupSchedule.saturday'),
  ];

  const describe = (s: BackupSchedule): string => {
    switch (s.frequency) {
      case 'daily':
        return t('backupSchedule.descDaily', { a: s.time });
      case 'weekly':
        return t('backupSchedule.descWeekly', { a: weekdays[s.weekday] ?? '', b: s.time });
      case 'hours':
        return t('backupSchedule.descHours', { n: s.everyHours, a: s.time.slice(-2) });
    }
  };

  const startNew = () => {
    const first = profiles[0];
    const s = newSchedule(Date.now(), first?.id ?? '');
    const db = first ? scheduleDbLabel(s, first.config as DbConnectionConfig) : '';
    setProblem(null);
    setEditing({ ...s, folder: getLastExportDir() || '', prefix: sanitizePrefix(db || 'backup') });
    if (first) void loadDatabases(first.id);
  };

  const save = () => {
    if (!editing) return;
    const key = validateSchedule(editing, schedules);
    if (key) {
      setProblem(t(key));
      return;
    }
    // A schedule edited to a new time starts counting from now: without this, moving 02:00 to 01:00
    // at 01:30 would "miss" today's 01:00 and run a catch-up the moment Save is pressed.
    const exists = schedules.some((s) => s.id === editing.id);
    saveSchedule(exists ? { ...editing, lastSlotAt: Math.max(editing.lastSlotAt ?? 0, Date.now()) } : editing);
    setEditing(null);
  };

  const set = (patch: Partial<BackupSchedule>) => setEditing((e) => (e ? { ...e, ...patch } : e));

  if (editing) {
    const profile = profileOf(editing.profileId);
    const config = profile?.config as DbConnectionConfig | undefined;
    const isSqlite = config?.type === 'sqlite';
    const dbState = dbList.profileId === editing.profileId ? dbList : null;
    const loadedList = dbState?.list ?? null;
    return (
      <Modal
        title={t('backupSchedule.editTitle')}
        icon={<CalendarClock size={14} className="bsd-icon" />}
        onClose={() => setEditing(null)}
        width="560px"
        zIndex={10002}
      >
        <ModalBody className="bsd-form">
          <div className="form-group">
            <label htmlFor="bsd-profile">{t('backupSchedule.profile')}</label>
            <select
              id="bsd-profile"
              className="form-input"
              value={editing.profileId}
              onChange={(e) => {
                // Another server's databases: the one picked for the previous profile means nothing here.
                set({ profileId: e.target.value, database: '' });
                void loadDatabases(e.target.value);
              }}
            >
              {profiles.length === 0 && <option value="">{t('backupSchedule.noProfiles')}</option>}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {!isSqlite && (
            <div className="form-group">
              <label>{t('backupSchedule.database')}</label>
              {loadedList ? (
                <OptionSelect
                  value={editing.database}
                  // A database saved earlier that the server no longer lists stays selectable, so
                  // opening the editor does not silently change what the schedule dumps.
                  options={
                    editing.database && !loadedList.includes(editing.database)
                      ? [editing.database, ...loadedList]
                      : loadedList
                  }
                  emptyLabel={
                    config?.database
                      ? t('backupSchedule.databaseDefault', { a: config.database })
                      : t('backupSchedule.databasePlaceholder')
                  }
                  onChange={(v) => set({ database: v })}
                  searchPlaceholder={t('backupSchedule.dbFilter')}
                  noMatchLabel={t('backupSchedule.dbNoMatch')}
                />
              ) : (
                // Still loading, or the server could not be asked: typing the name still works.
                <input
                  type="text"
                  className="form-input"
                  value={editing.database}
                  placeholder={config?.database || t('backupSchedule.databasePlaceholder')}
                  onChange={(e) => set({ database: e.target.value })}
                />
              )}
              {dbState?.list === null && !dbState.error && (
                <div className="bsd-hint">{t('backupSchedule.dbListLoading')}</div>
              )}
              {dbState?.error && (
                <div className="bsd-db-error">
                  <span>{dbState.error}</span>
                  <button type="button" className="btn btn-secondary" onClick={() => void loadDatabases(editing.profileId)}>
                    <RefreshCw size={12} /> {t('backupSchedule.dbRetry')}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="bsd-freq">{t('backupSchedule.frequency')}</label>
              <select
                id="bsd-freq"
                className="form-input"
                value={editing.frequency}
                onChange={(e) => set({ frequency: e.target.value as BackupSchedule['frequency'] })}
              >
                <option value="daily">{t('backupSchedule.freqDaily')}</option>
                <option value="weekly">{t('backupSchedule.freqWeekly')}</option>
                <option value="hours">{t('backupSchedule.freqHours')}</option>
              </select>
            </div>
            {editing.frequency === 'weekly' && (
              <div className="form-group">
                <label htmlFor="bsd-day">{t('backupSchedule.weekday')}</label>
                <select
                  id="bsd-day"
                  className="form-input"
                  value={editing.weekday}
                  onChange={(e) => set({ weekday: Number(e.target.value) })}
                >
                  {weekdays.map((name, i) => (
                    <option key={name} value={i}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {editing.frequency === 'hours' && (
              <div className="form-group">
                <label htmlFor="bsd-every">{t('backupSchedule.everyHours')}</label>
                <select
                  id="bsd-every"
                  className="form-input"
                  value={editing.everyHours}
                  onChange={(e) => set({ everyHours: Number(e.target.value) })}
                >
                  {HOUR_STEPS.map((h) => (
                    <option key={h} value={h}>
                      {t('backupSchedule.nHours', { n: h })}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-group">
              <label htmlFor="bsd-time">
                {editing.frequency === 'hours' ? t('backupSchedule.startAt') : t('backupSchedule.time')}
              </label>
              <input
                id="bsd-time"
                type="time"
                className="form-input"
                value={editing.time}
                onChange={(e) => set({ time: e.target.value })}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="bsd-folder">{t('backupSchedule.folder')}</label>
            <div className="bsd-folder">
              <input
                id="bsd-folder"
                type="text"
                className="form-input"
                value={editing.folder}
                onChange={(e) => set({ folder: e.target.value })}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={async () => {
                  const dir = await pickExportFolder(editing.folder || undefined);
                  if (dir) set({ folder: dir });
                }}
              >
                <FolderOpen size={13} /> {t('backupSchedule.browse')}
              </button>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="bsd-prefix">{t('backupSchedule.prefix')}</label>
              <input
                id="bsd-prefix"
                type="text"
                className="form-input"
                value={editing.prefix}
                onChange={(e) => set({ prefix: e.target.value })}
              />
            </div>
            <div className="form-group bsd-keep">
              <label htmlFor="bsd-keep">{t('backupSchedule.keep')}</label>
              <input
                id="bsd-keep"
                type="number"
                min={1}
                max={KEEP_MAX}
                value={editing.keep}
                onChange={(e) => set({ keep: Math.floor(Number(e.target.value)) })}
              />
            </div>
          </div>
          <div className="bsd-hint">
            {t('backupSchedule.fileExample', { a: backupFileName(editing.prefix, now, editing.gzip) })}
          </div>

          <label className="bsd-check">
            <input type="checkbox" checked={editing.gzip} onChange={(e) => set({ gzip: e.target.checked })} />
            {t('backupSchedule.gzip')}
          </label>
          <label className="bsd-check">
            <input type="checkbox" checked={editing.catchUp} onChange={(e) => set({ catchUp: e.target.checked })} />
            {t('backupSchedule.catchUp')}
          </label>

          {problem && <div className="bsd-error">{problem}</div>}
        </ModalBody>
        <ModalFooter>
          <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={profiles.length === 0}>
            {t('backupSchedule.save')}
          </button>
        </ModalFooter>
      </Modal>
    );
  }

  return (
    <>
      <Modal
        title={t('backupSchedule.title')}
        icon={<CalendarClock size={14} className="bsd-icon" />}
        onClose={onClose}
        width="680px"
        zIndex={10002}
      >
        <ModalBody>
          <div className="bsd-intro">{t('backupSchedule.intro')}</div>
          {schedules.length === 0 ? (
            <div className="bsd-empty">{t('backupSchedule.empty')}</div>
          ) : (
            <div className="bsd-list">
              {schedules.map((s) => {
                const profile = profileOf(s.profileId);
                const running = isScheduleRunning(s.id);
                return (
                  <div key={s.id} className={s.enabled ? 'bsd-row' : 'bsd-row bsd-off'}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      title={t('backupSchedule.enabled')}
                      aria-label={t('backupSchedule.enabled')}
                      // Re-enabling starts counting from now, for the same reason as editing does.
                      onChange={(e) =>
                        patchSchedule(s.id, e.target.checked ? { enabled: true, lastSlotAt: Date.now() } : { enabled: false })
                      }
                    />
                    <div className="bsd-main">
                      <div className="bsd-name">
                        {profile ? profile.name : t('backupSchedule.profileMissing')}
                        <span className="bsd-db"> · {scheduleDbLabel(s, profile?.config as DbConnectionConfig | undefined)}</span>
                      </div>
                      <div className="bsd-sub">
                        {describe(s)}
                        {s.enabled && ` · ${t('backupSchedule.next', { a: fmt(nextSlot(s, now)) })}`}
                        {` · ${t('backupSchedule.keepN', { n: s.keep })}`}
                      </div>
                      <div className="bsd-sub bsd-path">{s.folder}</div>
                      {running ? (
                        <div className="bsd-last">{t('backupSchedule.running')}</div>
                      ) : (
                        s.last && (
                          <div className={s.last.ok ? 'bsd-last bsd-ok' : 'bsd-last bsd-fail'} title={s.last.message}>
                            {s.last.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                            <span>
                              {fmt(s.last.at)} — {s.last.message}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                    <div className="bsd-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={running || !profile}
                        title={t('backupSchedule.runNow')}
                        onClick={() => submitScheduledBackup(s)}
                      >
                        <Play size={12} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        title={t('backupSchedule.edit')}
                        onClick={() => {
                          setProblem(null);
                          setEditing(s);
                          void loadDatabases(s.profileId);
                        }}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        title={t('backupSchedule.delete')}
                        onClick={() => setConfirmDelete(s)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
          <button type="button" className="btn btn-primary" onClick={startNew} disabled={profiles.length === 0}>
            <Plus size={13} /> {t('backupSchedule.add')}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmDialog
        open={!!confirmDelete}
        title={t('backupSchedule.deleteTitle')}
        message={t('backupSchedule.deleteMessage')}
        confirmLabel={t('backupSchedule.delete')}
        danger
        onConfirm={() => {
          if (confirmDelete) deleteSchedule(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  );
};

