import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, FileUp } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ProgressBar } from './ProgressBar';
import { dbHelper } from '../utils/dbHelper';
import { fileBaseName } from '../utils/dumpPreview';
import {
  DELIMITERS,
  autoMap,
  mappedColumns,
  missingRequired,
  newTableColumnType,
  tableNameFromFile,
  typeFamily,
  type CellIssue,
  type CoerceOptions,
  type Delimiter,
  type FileCheck,
  type FileProbe,
  type RowIssue,
  type SourceOptions,
  type TargetColumn,
} from '../utils/tableImport';
import { startJob } from '../utils/jobs';
import { withJobConnection } from '../utils/jobConnection';
import { approveJob, connKeyOfConn, type JobApproval } from '../utils/safeMode';

/**
 * Import a CSV / Excel / JSON file — plain, gzipped or inside a zip — into a table, with the columns
 * mapped, the values converted to each column's type, and every row checked before anything is
 * written. With no `tableName` it creates a NEW table, its columns named after the file's and typed
 * from what the whole file holds.
 *
 * The dialog holds the file's PATH, never its contents: Rust reads it (`src-tauri/src/import_file/`)
 * for the preview (a couple of hundred rows), the dry run (counts and the first problems) and the
 * import itself (`import_step`, a background job). It used to read the whole file into the webview
 * and parse and convert it there, which crashed the app on a file of a few hundred MB.
 */

interface Props {
  connId: string;
  /** The table to import into; null creates a new table from the file. */
  tableName: string | null;
  /** A session-temporary table's own schema (Postgres `pg_temp_N`); normally absent. */
  tableSchema?: string | null;
  dbType?: string;
  /** The file to import. */
  path: string;
  onClose: () => void;
}

/** Encodings worth offering. Windows-1258 is what Vietnamese Excel on Windows writes by default. */
const ENCODINGS = ['utf-8', 'utf-16le', 'windows-1258', 'windows-1252', 'shift_jis', 'gb18030'] as const;

/** Rows read, converted and inserted per `import_step` call. */
const STEP_ROWS = 5000;

/** Problems listed in the job's result. */
const FAILURES_SHOWN = 8;

/** The translation key for each conversion problem — literal keys, so `t()` type-checks them. */
const ISSUE_KEY: Record<CellIssue, `importTable.issue.${CellIssue}`> = {
  required: 'importTable.issue.required',
  notInteger: 'importTable.issue.notInteger',
  notNumber: 'importTable.issue.notNumber',
  notBoolean: 'importTable.issue.notBoolean',
  notDate: 'importTable.issue.notDate',
  notDateTime: 'importTable.issue.notDateTime',
  notTime: 'importTable.issue.notTime',
  notJson: 'importTable.issue.notJson',
  notUuid: 'importTable.issue.notUuid',
  tooLong: 'importTable.issue.tooLong',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const message = (err: any) => String(err?.message ?? err);

export const ImportTableDataDialog: React.FC<Props> = ({ connId, tableName, tableSchema, dbType, path, onClose }) => {
  const { t, i18n } = useTranslation();
  const fmt = (n: number) => n.toLocaleString(i18n.language);
  const isNew = tableName === null;

  // ---- How to read the file
  const [encoding, setEncoding] = useState<(typeof ENCODINGS)[number]>('utf-8');
  const [delimiterChoice, setDelimiterChoice] = useState<'auto' | Delimiter>('auto');
  const [hasHeader, setHasHeader] = useState(true);
  const [sheetIndex, setSheetIndex] = useState(0);
  const sourceOptions: SourceOptions = useMemo(
    () => ({
      encoding,
      delimiter: delimiterChoice === 'auto' ? undefined : delimiterChoice,
      hasHeader,
      sheet: sheetIndex,
    }),
    [encoding, delimiterChoice, hasHeader, sheetIndex],
  );
  const optionsKey = JSON.stringify(sourceOptions);

  // ---- The preview: header + first rows, read again whenever an option changes. Stored WITH the
  //      options it was read under, so the previous preview stays on screen while the next is read
  //      but nothing that depends on the header acts on a stale one.
  const [probeState, setProbeState] = useState<{ key: string; probe?: FileProbe; error?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const opts = JSON.parse(optionsKey) as SourceOptions;
    dbHelper.importFileProbe(path, opts).then(
      (probe) => alive && setProbeState({ key: optionsKey, probe }),
      (err) => alive && setProbeState({ key: optionsKey, error: message(err) }),
    );
    return () => {
      alive = false;
    };
  }, [path, optionsKey]);
  const probe = probeState?.probe ?? null;
  const probeCurrent = probeState?.key === optionsKey && !!probeState.probe;
  const kind = probe?.kind ?? 'csv';

  // ---- An existing table's columns
  const [schemaCols, setSchemaCols] = useState<TargetColumn[] | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  useEffect(() => {
    if (isNew) return;
    let alive = true;
    dbHelper.getTableSchema(connId, tableName, tableSchema).then(
      (schema) => {
        if (!alive) return;
        // set-state-in-effect: the schema arrives by async IPC when the dialog opens, which is the
        // case the rule cannot cover — it is not derivable from props.
        // eslint-disable-next-line react/set-state-in-effect
        setSchemaCols(
          (schema.columns || []).map((c) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            hasDefault: c.defaultValue !== null || !!c.autoIncrement || !!c.identityAlways,
            generated: !!c.generated,
          })),
        );
      },
      (err) => alive && setSchemaError(message(err)),
    );
    return () => {
      alive = false;
    };
  }, [isNew, connId, tableName, tableSchema]);

  // ---- Conversion options
  const [emptyAs, setEmptyAs] = useState<'null' | 'empty'>('null');
  const [trim, setTrim] = useState(true);
  const [mode, setMode] = useState<'atomic' | 'skip'>('atomic');
  const coerce: CoerceOptions = useMemo(() => ({ emptyAsEmpty: emptyAs === 'empty', trim }), [emptyAs, trim]);

  // ---- The dry run over the whole file. Declared before the targets because a new table's column
  //      types come from it; its own inputs are only the options and the mapping.
  const [checkState, setCheckState] = useState<{ key: string; result?: FileCheck; error?: string } | null>(null);
  const [checkProgress, setCheckProgress] = useState<{ key: string; bytesDone: number; bytesTotal: number; rows: number } | null>(null);

  // ---- A new table: its name and its columns' types (guessed, editable)
  const [newName, setNewName] = useState(() => tableNameFromFile(path));
  const [typeEdits, setTypeEdits] = useState<{ key: string; types: Record<number, string> }>({ key: '', types: {} });

  // ---- The columns written to, and where each one's values come from
  // The whole file's header once the dry run has read it (a JSON file can add keys after the
  // preview's rows); indexes only ever grow, so a mapping made from the preview stays valid.
  const checkResult = checkState?.result ?? null;
  const headers = useMemo(
    () => (checkResult && checkResult.headers.length >= (probe?.headers.length ?? 0) ? checkResult.headers : (probe?.headers ?? [])),
    [checkResult, probe],
  );
  const typesKey = `${optionsKey}\u0002${(probe?.headers ?? []).join('\u0001')}`;
  const editedTypes = useMemo(
    () => (typeEdits.key === typesKey ? typeEdits.types : ({} as Record<number, string>)),
    [typeEdits, typesKey],
  );
  const typesEdited = Object.keys(editedTypes).length > 0;

  const targets: TargetColumn[] | null = useMemo(() => {
    if (!isNew) return schemaCols;
    if (!probe) return null;
    const inferred = checkResult?.inferred ?? probe.inferred;
    return headers.map((h, i) => ({
      name: h,
      type: editedTypes[i] ?? newTableColumnType(inferred[i] ?? 'text', dbType),
      nullable: true,
      hasDefault: false,
    }));
  }, [isNew, schemaCols, probe, checkResult, headers, editedTypes, dbType]);

  // Mapping: the automatic guess, until the user changes a row. Keyed on the PREVIEW's header (and
  // the targets), so the dry run growing the header does not throw away the user's choices.
  const mappingKey = probe && targets ? `${probe.headers.join('\u0001')}\u0002${targets.map((c) => c.name).join('\u0001')}` : '';
  const [override, setOverride] = useState<{ key: string; mapping: (number | null)[] } | null>(null);
  const mapping = useMemo(() => {
    if (!probe || !targets) return [];
    if (isNew) return targets.map((_, i) => i);
    if (override && override.key === mappingKey) return override.mapping;
    return autoMap(probe.headers, targets);
  }, [isNew, probe, targets, override, mappingKey]);
  const setMappingAt = (i: number, value: number | null) => {
    const next = [...mapping];
    next[i] = value;
    setOverride({ key: mappingKey, mapping: next });
  };
  const columns = useMemo(() => (targets ? mappedColumns(targets, mapping) : []), [targets, mapping]);

  // What the dry run is asked. For a new table its job is the TYPE GUESS — columns typed from the
  // whole file take every value in it by construction, so they are only checked once the user has
  // edited a type. Hence the key leaves the guessed types out: they come from this very run.
  const checkSpec = useMemo(() => {
    if (!probeCurrent || !targets) return null;
    if (isNew) return { columns: typesEdited ? columns : [], coerce, infer: true };
    return { columns, coerce, infer: false };
  }, [probeCurrent, targets, isNew, typesEdited, columns, coerce]);
  const checkKey = checkSpec ? JSON.stringify([optionsKey, checkSpec]) : '';
  useEffect(() => {
    if (!checkKey) return;
    const [opts, spec] = JSON.parse(checkKey) as [string, NonNullable<typeof checkSpec>];
    const id = crypto.randomUUID();
    let alive = true;
    // A burst of mapping changes starts one run, not one per change.
    const timer = setTimeout(() => {
      dbHelper
        .importFileCheck(id, path, JSON.parse(opts) as SourceOptions, spec, (p) => alive && setCheckProgress({ key: checkKey, ...p }))
        .then(
          (result) => alive && result && setCheckState({ key: checkKey, result }),
          (err) => alive && setCheckState({ key: checkKey, error: message(err) }),
        );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
      void dbHelper.importFileCheckCancel(id);
    };
  }, [path, checkKey]);
  const checkDone = checkState?.key === checkKey && !!checkState.result;
  const check = checkDone ? checkState!.result! : null;
  const checkError = checkState?.key === checkKey ? (checkState.error ?? null) : null;
  const checking = !!checkKey && !checkDone && !checkError;
  const progress = checking && checkProgress?.key === checkKey ? checkProgress : null;

  const issuesByColumn = check?.issuesByColumn ?? {};
  const missing = !isNew && targets ? missingRequired(targets, mapping) : [];
  const totalRows = check?.rows ?? null;
  const badRows = check?.badRows ?? 0;
  const readyRows = totalRows === null ? null : totalRows - badRows;
  const noRows = (probe?.complete && probe.sample.length === 0) || totalRows === 0;

  const blockReason =
    !probe || !targets
      ? null
      : noRows
        ? t('importTable.blockNoRows')
        : isNew && !newName.trim()
          ? t('importTable.blockNoName')
          : columns.length === 0
            ? t('importTable.blockNothingMapped')
            : missing.length > 0
              ? t('importTable.blockMissing', { cols: missing.join(', ') })
              : mode === 'atomic' && badRows > 0
                ? t('importTable.blockAtomicBad', { n: fmt(badRows) })
                : null;
  // A new table's types come from the whole file, so it waits for the dry run; an existing table
  // may be imported while the dry run is still counting (the import checks every row anyway).
  const canSubmit = probeCurrent && !!targets && !blockReason && (!isNew || checkDone);

  // ---- Run as a background job
  const submit = async () => {
    if (!canSubmit || !targets) return;
    const table = isNew ? newName.trim() : tableName;
    const n = readyRows === null ? null : fmt(mode === 'skip' ? readyRows : (totalRows ?? 0));
    let approval: JobApproval;
    try {
      approval = await approveJob(
        'import_step',
        connId,
        isNew
          ? t('importTable.approveNew', { n: n ?? '?', table })
          : n !== null
            ? t('importTable.approve', { n, table })
            : t('importTable.approveUnknown', { table }),
      );
    } catch {
      return;
    }
    // Everything the job reads is fixed now: the dialog closes, and its state goes with it.
    const source = { path, options: sourceOptions, columns, coerce };
    const create = isNew ? targets.map((c) => ({ name: c.name, type: c.type })) : null;
    const importMode = mode;
    const issueText = (iss: RowIssue) => `${iss.column}: ${t(ISSUE_KEY[iss.issue])} (${iss.value})`;

    startJob({
      kind: 'import-table',
      title: t('jobs.titleImportTable', { n: table }),
      db: table,
      conn: connKeyOfConn(connId),
      write: true,
      lockKey: `${connId}|${table}`,
      run: (ctx) =>
        withJobConnection(connId, [approval], async ({ connId: jobConnId }) => {
          const { handle } = await dbHelper.importBegin(
            jobConnId,
            table,
            columns.map((c) => c.target.name),
            importMode,
            tableSchema,
            source,
            create,
          );
          let finished = false;
          try {
            let inserted = 0;
            let skipped = 0;
            const failures: string[] = [];
            for (;;) {
              // A cancel rolls the whole import back — the `finally` aborts the transaction.
              ctx.throwIfCancelled();
              const r = await dbHelper.importStep(handle, STEP_ROWS);
              inserted += r.inserted;
              skipped += r.badRows + r.failed.length;
              for (const iss of r.issues) {
                if (failures.length < FAILURES_SHOWN) failures.push(t('importTable.failedRow', { row: fmt(iss.row), message: issueText(iss) }));
              }
              for (const f of r.failed) {
                if (failures.length < FAILURES_SHOWN) failures.push(t('importTable.failedRow', { row: fmt(f.row), message: f.error }));
              }
              if (r.stopped) {
                const f = r.failed[0];
                const iss = r.issues[0];
                throw new Error(
                  t('importTable.errAtomicStopped', {
                    row: fmt(f?.row ?? iss?.row ?? 0),
                    message: f ? f.error : iss ? issueText(iss) : '',
                  }),
                );
              }
              ctx.report({
                label: t('importTable.progress', { table }),
                current: r.bytesDone,
                total: r.bytesTotal || undefined,
                detail: t('importTable.progressRows', { n: fmt(inserted) }),
              });
              if (r.done) break;
            }
            await dbHelper.importFinish(handle, true);
            finished = true;
            window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId } }));
            return {
              message: isNew
                ? t('importTable.doneNew', { n: fmt(inserted), table })
                : skipped
                  ? t('importTable.doneSkipped', { n: fmt(inserted), table, skipped: fmt(skipped) })
                  : t('importTable.done', { n: fmt(inserted), table }),
              warning: failures.length ? failures.join('\n') : undefined,
            };
          } finally {
            if (!finished) await dbHelper.importAbort(handle);
          }
        }),
    });
    onClose();
  };

  // ---- Render
  const loadError = (probeState?.key === optionsKey ? probeState.error : null) ?? schemaError;
  const loading = !loadError && (!probe || !targets);
  const sampleOf = (src: number | null | undefined) => (src === null || src === undefined ? '' : (probe?.firstValues[src] ?? ''));
  const setTypeAt = (i: number, ty: string) => setTypeEdits({ key: typesKey, types: { ...editedTypes, [i]: ty } });

  const container =
    probe?.compression === 'zip'
      ? t('importTable.fromZip', { entry: probe.entry ?? '' })
      : probe?.compression === 'gzip'
        ? t('importTable.fromGzip')
        : null;

  return (
    <Modal
      title={isNew ? t('importTable.titleNew') : t('importTable.title', { table: tableName })}
      icon={<FileUp size={14} />}
      onClose={onClose}
      width="860px"
    >
      <ModalBody>
        <div className="imp-file">
          <strong>{fileBaseName(path)}</strong>
          {probe && <span>{formatSize(probe.fileBytes)}</span>}
          {container && <span>{container}</span>}
          {totalRows !== null ? (
            <span>{t('importTable.rowsInFile', { n: fmt(totalRows) })}</span>
          ) : (
            probe && <span>{t('importTable.rowsCounting')}</span>
          )}
        </div>

        {loadError && (
          <div className="imp-banner is-error">
            <AlertTriangle size={13} />
            <span>{t('importTable.errLoad', { message: loadError })}</span>
          </div>
        )}
        {loading && <div className="imp-muted">{t('importTable.loading')}</div>}

        {probe && targets && (
          <>
            {isNew && (
              <label className="imp-name">
                <span>{t('importTable.newTableName')}</span>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} spellCheck={false} />
              </label>
            )}

            <div className="imp-options">
              {kind === 'csv' && (
                <>
                  <label>
                    <span>{t('importTable.delimiter')}</span>
                    <select value={delimiterChoice} onChange={(e) => setDelimiterChoice(e.target.value as 'auto' | Delimiter)}>
                      <option value="auto">
                        {t('importTable.delimiterAuto', { d: delimiterLabel((probe.delimiter ?? ',') as Delimiter, t) })}
                      </option>
                      {DELIMITERS.map((d) => (
                        <option key={d} value={d}>{delimiterLabel(d, t)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t('importTable.encoding')}</span>
                    <select value={encoding} onChange={(e) => setEncoding(e.target.value as (typeof ENCODINGS)[number])}>
                      {ENCODINGS.map((enc) => (
                        <option key={enc} value={enc}>{enc}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {kind === 'xlsx' && probe.sheets.length > 1 && (
                <label>
                  <span>{t('importTable.sheet')}</span>
                  <select value={sheetIndex} onChange={(e) => setSheetIndex(Number(e.target.value))}>
                    {probe.sheets.map((s, i) => (
                      <option key={s} value={i}>{s}</option>
                    ))}
                  </select>
                </label>
              )}
              {kind !== 'json' && (
                <label className="imp-check">
                  <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
                  <span>{t('importTable.hasHeader')}</span>
                </label>
              )}
              <label>
                <span>{t('importTable.emptyAs')}</span>
                <select value={emptyAs} onChange={(e) => setEmptyAs(e.target.value as 'null' | 'empty')}>
                  <option value="null">{t('importTable.emptyAsNull')}</option>
                  <option value="empty">{t('importTable.emptyAsEmpty')}</option>
                </select>
              </label>
              <label className="imp-check">
                <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
                <span>{t('importTable.trim')}</span>
              </label>
            </div>

            <div className="imp-map">
              <table>
                <thead>
                  <tr>
                    <th>{t('importTable.colTarget')}</th>
                    <th>{t('importTable.colType')}</th>
                    {!isNew && <th>{t('importTable.colSource')}</th>}
                    <th>{t('importTable.colSample')}</th>
                    <th>{t('importTable.colProblems')}</th>
                  </tr>
                </thead>
                <tbody>
                  {targets.map((col, i) => {
                    const problems = issuesByColumn[col.name] ?? 0;
                    return (
                      <tr key={col.name} className={col.generated ? 'is-disabled' : undefined}>
                        <td>
                          <span className="imp-col-name">{col.name}</span>
                          {!col.nullable && !col.hasDefault && !col.generated && (
                            <span className="imp-badge">{t('importTable.required')}</span>
                          )}
                        </td>
                        {isNew ? (
                          <td>
                            <input
                              type="text"
                              className="imp-type-input"
                              value={col.type}
                              spellCheck={false}
                              onChange={(e) => setTypeAt(i, e.target.value)}
                            />
                          </td>
                        ) : (
                          <td className="imp-type" title={typeFamily(col.type)}>{col.type}</td>
                        )}
                        {!isNew && (
                          <td>
                            {col.generated ? (
                              <span className="imp-muted">{t('importTable.generated')}</span>
                            ) : (
                              <select
                                value={mapping[i] === null || mapping[i] === undefined ? '' : String(mapping[i])}
                                onChange={(e) => setMappingAt(i, e.target.value === '' ? null : Number(e.target.value))}
                              >
                                <option value="">{col.hasDefault ? t('importTable.skipDefault') : t('importTable.skip')}</option>
                                {/* Names are unique — the reader suffixes repeats — so they key the list. */}
                                {headers.map((h, hi) => (
                                  <option key={h} value={hi}>{h}</option>
                                ))}
                              </select>
                            )}
                          </td>
                        )}
                        <td className="imp-sample">{sampleOf(mapping[i])}</td>
                        <td className={problems ? 'imp-problems' : 'imp-muted'}>{problems ? fmt(problems) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {checking && (
              <ProgressBar
                progress={{
                  label: t('importTable.checking'),
                  current: progress?.bytesDone,
                  total: progress?.bytesTotal || undefined,
                  detail: progress ? t('importTable.checkingDetail', { n: fmt(progress.rows) }) : undefined,
                }}
              />
            )}
            {checkError && (
              <div className="imp-banner is-error">
                <AlertTriangle size={13} />
                <span>{t('importTable.errCheck', { message: checkError })}</span>
              </div>
            )}

            {check && (
              <div className="imp-summary">
                {badRows === 0
                  ? t('importTable.allGood', { n: fmt(check.rows) })
                  : t('importTable.someBad', { bad: fmt(badRows), n: fmt(check.rows) })}
              </div>
            )}

            {check && check.issues.length > 0 && (
              <div className="imp-issues">
                <table>
                  <thead>
                    <tr>
                      <th>{t('importTable.issueRow')}</th>
                      <th>{t('importTable.colTarget')}</th>
                      <th>{t('importTable.issueValue')}</th>
                      <th>{t('importTable.issueReason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.issues.map((iss) => (
                      <tr key={`${iss.row}:${iss.column}`}>
                        <td>{fmt(iss.row)}</td>
                        <td>{iss.column}</td>
                        <td className="imp-value">{iss.value === '' ? <span className="imp-muted">{t('importTable.emptyCell')}</span> : iss.value}</td>
                        <td>{t(ISSUE_KEY[iss.issue])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {check.issues.length < badRows && (
                  <div className="imp-muted">{t('importTable.moreIssues', { n: fmt(badRows) })}</div>
                )}
              </div>
            )}

            <div className="imp-mode">
              <label className="imp-check">
                <input type="radio" name="imp-mode" checked={mode === 'atomic'} onChange={() => setMode('atomic')} />
                <span>
                  <strong>{t('importTable.modeAtomic')}</strong> {isNew ? t('importTable.modeAtomicHintNew') : t('importTable.modeAtomicHint')}
                </span>
              </label>
              <label className="imp-check">
                <input type="radio" name="imp-mode" checked={mode === 'skip'} onChange={() => setMode('skip')} />
                <span>
                  <strong>{t('importTable.modeSkip')}</strong> {t('importTable.modeSkipHint')}
                </span>
              </label>
            </div>

            {blockReason && (
              <div className="imp-banner">
                <AlertTriangle size={13} />
                <span>{blockReason}</span>
              </div>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
          {readyRows === null
            ? isNew
              ? t('importTable.submitNewUnknown')
              : t('importTable.submitUnknown')
            : isNew
              ? t('importTable.submitNew', { n: fmt(mode === 'skip' ? readyRows : (totalRows ?? 0)) })
              : t('importTable.submit', { n: fmt(mode === 'skip' ? readyRows : (totalRows ?? 0)) })}
        </button>
      </ModalFooter>
    </Modal>
  );
};

function delimiterLabel(d: Delimiter, t: TFunction): string {
  switch (d) {
    case ',':
      return t('importTable.delimComma');
    case ';':
      return t('importTable.delimSemicolon');
    case '\t':
      return t('importTable.delimTab');
    case '|':
      return t('importTable.delimPipe');
  }
}
