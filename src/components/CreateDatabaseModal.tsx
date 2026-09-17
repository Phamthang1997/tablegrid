import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { OptionSelect } from './OptionSelect';
import { dbHelper, type CreateDbPayload, type DbCharsets } from '../utils/dbHelper';

/**
 * The create-database dialog. One component for every entry point (the title bar's quick switcher
 * today) — it used to be a bare name field here and a second, unreachable copy inside `Sidebar`
 * whose encoding/collation selects were fed by a state setter nobody called, so they only ever
 * offered "server default".
 *
 * Everything past the name is optional and dialect-gated: MySQL takes a character set + collation,
 * Postgres an owner, encoding, LC_COLLATE, LC_CTYPE and a template. SQLite takes nothing at all —
 * one file is one database — so the dialog says so instead of offering a button that always fails.
 *
 * The SQL preview comes from `preview_create_database`, i.e. from the same Rust builder that
 * `create_database` runs. Building it here would be a second definition of the statement, and a
 * preview that can disagree with what executes is worse than none.
 */
export interface CreateDatabaseModalProps {
  connId: string;
  /** Lower-cased driver name, as the title bar reads it off the connection status. */
  dbType: string;
  /** Called with the created name, and whether the user asked to open it right away. */
  onCreated: (name: string, open: boolean) => void;
  onClose: () => void;
  zIndex?: number;
}

/** A blank field means "server default", so it is dropped from the payload rather than sent empty. */
function trimmedPayload(form: CreateDbPayload, pg: boolean): CreateDbPayload {
  const out: CreateDbPayload = { name: form.name.trim() };
  if (form.encoding) out.encoding = form.encoding;
  if (form.collation) out.collation = form.collation;
  if (pg) {
    if (form.ctype) out.ctype = form.ctype;
    if (form.owner) out.owner = form.owner;
    if (form.template) out.template = form.template;
  }
  return out;
}

export const CreateDatabaseModal: React.FC<CreateDatabaseModalProps> = ({
  connId,
  dbType,
  onCreated,
  onClose,
  zIndex = 99999,
}) => {
  const { t } = useTranslation();
  const isPg = dbType === 'postgres';
  const isSqlite = dbType === 'sqlite';

  const [form, setForm] = useState<CreateDbPayload>({ name: '' });
  const [charsets, setCharsets] = useState<DbCharsets>({ encodings: [] });
  const [openAfter, setOpenAfter] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const name = form.name.trim();

  // The option lists. One call on mount: the answer is a property of the server, and the dialog is
  // short-lived, so there is nothing to refresh.
  useEffect(() => {
    if (isSqlite || !connId) return;
    let alive = true;
    void dbHelper.getDbCharsets(connId).then((res) => {
      // set-state-in-effect: async IPC on mount, which is the case the rule cannot cover.
      // eslint-disable-next-line react/set-state-in-effect
      if (alive && res.success) setCharsets(res);
    });
    return () => { alive = false; };
  }, [connId, isSqlite]);

  const collations = useMemo(() => {
    if (isPg) return charsets.collations || [];
    return charsets.collationsByEncoding?.[form.encoding || ''] || [];
  }, [isPg, charsets, form.encoding]);

  // The live preview, debounced: it is an IPC call and the name field is typed into. The answer is
  // stored WITH the payload it answers, so an in-flight reply for an older payload falls out during
  // render — no ref, and no window where the box shows SQL for a name the user has moved past.
  const payload = useMemo(() => trimmedPayload(form, isPg), [form, isPg]);
  const payloadKey = JSON.stringify(payload);
  const [preview, setPreview] = useState<{ key: string; sql: string } | null>(null);
  const sql = preview?.key === payloadKey ? preview.sql : '';

  useEffect(() => {
    if (isSqlite || !connId || !payload.name) return;
    let alive = true;
    const id = window.setTimeout(() => {
      void dbHelper.previewCreateDatabase(connId, payload).then((res) => {
        if (alive) setPreview({ key: payloadKey, sql: res.sql || '' });
      });
    }, 250);
    return () => { alive = false; window.clearTimeout(id); };
  }, [connId, isSqlite, payload, payloadKey]);

  const submit = async () => {
    if (!name || creating) return;
    setCreating(true);
    setError('');
    const res = await dbHelper.createDatabase(connId, trimmedPayload(form, isPg));
    setCreating(false);
    if (res.success) onCreated(name, openAfter);
    else setError(res.error || '');
  };

  const field = (label: string, control: React.ReactNode) => (
    <div className="form-group">
      <label>{label}</label>
      {control}
    </div>
  );

  // OptionSelect rather than a native <select>: the charset list is 40 entries on MySQL, and an
  // OS-drawn popup cannot be capped in height — see the note in OptionSelect.tsx.
  const select = (
    key: 'encoding' | 'collation' | 'ctype' | 'owner' | 'template',
    values: string[],
    onPick?: (value: string) => void,
  ) => (
    <OptionSelect
      value={form[key] || ''}
      options={values}
      disabled={values.length === 0}
      emptyLabel={t('createDb.serverDefault')}
      searchPlaceholder={t('createDb.filterOptions')}
      noMatchLabel={t('createDb.noMatch')}
      onChange={(value) => {
        if (onPick) onPick(value);
        else setForm((f) => ({ ...f, [key]: value }));
      }}
    />
  );

  return (
    <Modal
      title={t('createDb.title')}
      onClose={onClose}
      width="480px"
      zIndex={zIndex}
      closeDisabled={creating}
    >
      <ModalBody>
        {isSqlite ? (
          <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
            {t('createDb.sqliteUnsupported')}
          </div>
        ) : (
          <>
            {field(
              t('createDb.nameLabel'),
              <input
                type="text"
                className="form-input"
                placeholder={t('createDb.namePlaceholder')}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
                autoFocus
              />,
            )}

            <div className="form-row">
              {field(
                isPg ? t('createDb.encoding') : t('createDb.charset'),
                // Changing the charset invalidates the collation on MySQL, where a collation
                // belongs to exactly one charset.
                select('encoding', charsets.encodings, (value) =>
                  setForm((f) => ({ ...f, encoding: value, collation: '' })),
                ),
              )}
              {field(t('createDb.collation'), select('collation', collations))}
            </div>

            {isPg && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? t('createDb.hideAdvanced') : t('createDb.showAdvanced')}
                </button>
                {showAdvanced && (
                  <>
                    <div className="form-row">
                      {field(t('createDb.ctype'), select('ctype', charsets.ctypes || []))}
                      {field(t('createDb.owner'), select('owner', charsets.owners || []))}
                    </div>
                    {field(t('createDb.template'), select('template', charsets.templates || []))}
                  </>
                )}
              </>
            )}

            {field(
              t('createDb.sqlPreview'),
              <pre
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  minHeight: '46px',
                  maxHeight: '120px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontFamily: 'var(--win-font-mono)',
                  fontSize: '11px',
                  lineHeight: 1.5,
                  color: 'var(--win-text-primary)',
                  background: 'var(--win-bg-input)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px',
                }}
              >
                {sql || t('createDb.sqlPending')}
              </pre>,
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
              <input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} />
              {t('createDb.openAfter')}
            </label>

            {error && (
              <div style={{ fontSize: '11.5px', color: 'var(--st-danger)', wordBreak: 'break-word' }}>
                {t('createDb.errCreate', { message: error })}
              </div>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-secondary" onClick={onClose} disabled={creating}>
          {t('common.cancel')}
        </button>
        {!isSqlite && (
          <button className="btn btn-primary" onClick={submit} disabled={!name || creating}>
            {creating ? t('common.creating') : t('createDb.submit')}
          </button>
        )}
      </ModalFooter>
    </Modal>
  );
};

export default CreateDatabaseModal;
