import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, FileUp } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import { readXlsxSheets } from '../utils/xlsxReader';
import {
  DELIMITERS,
  autoMap,
  buildRows,
  detectDelimiter,
  displayRowNumber,
  jsonToMatrix,
  missingRequired,
  parseDelimited,
  toSourceTable,
  typeFamily,
  type CellIssue,
  type CoerceOptions,
  type Delimiter,
  type TargetColumn,
} from '../utils/tableImport';
import { startJob } from '../utils/jobs';
import { withJobConnection } from '../utils/jobConnection';
import { approveJob, connKeyOfConn, type JobApproval } from '../utils/safeMode';

/**
 * Import a CSV / Excel / JSON file into an EXISTING table, with the columns mapped, the values
 * converted to each column's type, and every row checked before anything is written.
 *
 * All the rules are in `utils/tableImport.ts` (tested); this component draws them. The write is a
 * background job on a connection of its own, through `table_import.rs`: one transaction for the
 * whole file, in chunks, with the failing row found by position.
 *
 * It replaced two copies of an import (DataGrid's and App's) that used the file's header names as
 * the INSERT column list, sent every value as a string, and committed every 500 rows — so a failure
 * part-way left half a file in the table and said "error after 3,500 rows" without naming the row.
 */

interface Props {
  connId: string;
  tableName: string;
  /** A session-temporary table's own schema (Postgres `pg_temp_N`); normally absent. */
  tableSchema?: string | null;
  file: File;
  onClose: () => void;
}

type SourceKind = 'csv' | 'xlsx' | 'json';

/** Encodings worth offering. Windows-1258 is what Vietnamese Excel on Windows writes by default. */
const ENCODINGS = ['utf-8', 'utf-16le', 'windows-1258', 'windows-1252', 'shift_jis', 'gb18030'] as const;

/** Rows converted and sent per IPC call; the backend splits each into INSERTs of its own size. */
const CHUNK_ROWS = 2000;

/** Problems listed in the dialog; all of them are counted. */
const ISSUES_SHOWN = 50;

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

const kindOf = (name: string): SourceKind => {
  const n = name.toLowerCase();
  if (n.endsWith('.xlsx')) return 'xlsx';
  if (n.endsWith('.json')) return 'json';
  return 'csv';
};

export const ImportTableDataDialog: React.FC<Props> = ({ connId, tableName, tableSchema, file, onClose }) => {
  const { t, i18n } = useTranslation();
  const fmt = (n: number) => n.toLocaleString(i18n.language);
  const kind = kindOf(file.name);

  // ---- What was read: the file's bytes (CSV, decoded per the chosen encoding) or its parsed form,
  //      and the table's columns. Both arrive asynchronously when the dialog opens.
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [sheets, setSheets] = useState<{ name: string; rows: unknown[][] }[] | null>(null);
  const [jsonMatrix, setJsonMatrix] = useState<unknown[][] | null>(null);
  const [targets, setTargets] = useState<TargetColumn[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [schema, buf] = await Promise.all([
          dbHelper.getTableSchema(connId, tableName, tableSchema),
          file.arrayBuffer(),
        ]);
        if (!alive) return;
        const cols: TargetColumn[] = (schema.columns || []).map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          hasDefault: c.defaultValue !== null || !!c.autoIncrement || !!c.identityAlways,
          generated: !!c.generated,
        }));
        if (kind === 'xlsx') {
          const read = await readXlsxSheets(buf);
          if (!alive) return;
          setSheets(read);
        } else if (kind === 'json') {
          const parsed = JSON.parse(new TextDecoder().decode(buf));
          if (!alive) return;
          setJsonMatrix(jsonToMatrix(parsed));
        } else {
          setBytes(buf);
        }
        // set-state-in-effect: the schema and the file both arrive by async IPC/file reads when the
        // dialog opens, which is the case the rule cannot cover — neither is derivable from props.
        // eslint-disable-next-line react/set-state-in-effect
        setTargets(cols);
      } catch (err: any) {
        if (alive) setLoadError(String(err?.message ?? err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [connId, tableName, tableSchema, file, kind]);

  // ---- Source options
  const [encoding, setEncoding] = useState<(typeof ENCODINGS)[number]>('utf-8');
  const [delimiterChoice, setDelimiterChoice] = useState<'auto' | Delimiter>('auto');
  const [hasHeader, setHasHeader] = useState(true);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [emptyAs, setEmptyAs] = useState<CoerceOptions['emptyAs']>('null');
  const [trim, setTrim] = useState(true);
  const [mode, setMode] = useState<'atomic' | 'skip'>('atomic');
  const opts: CoerceOptions = useMemo(() => ({ emptyAs, trim }), [emptyAs, trim]);

  const csvText = useMemo(() => (bytes ? new TextDecoder(encoding).decode(bytes) : null), [bytes, encoding]);
  const delimiter: Delimiter = useMemo(
    () => (delimiterChoice !== 'auto' ? delimiterChoice : csvText ? detectDelimiter(csvText) : ','),
    [delimiterChoice, csvText],
  );

  const source = useMemo(() => {
    if (kind === 'csv') return csvText === null ? null : toSourceTable(parseDelimited(csvText, delimiter), hasHeader);
    if (kind === 'json') return jsonMatrix ? toSourceTable(jsonMatrix, true) : null;
    const sheet = sheets?.[sheetIndex] ?? sheets?.[0];
    return sheet ? toSourceTable(sheet.rows, hasHeader) : null;
  }, [kind, csvText, delimiter, hasHeader, jsonMatrix, sheets, sheetIndex]);

  // ---- Mapping: the automatic guess, until the user changes a row. Stored WITH the headers and
  //      targets it was made for, so changing the delimiter or the header toggle — which changes
  //      the source columns — goes back to a fresh guess instead of keeping indexes into columns
  //      that no longer mean the same thing.
  const mappingKey = source && targets ? `${source.headers.join('\u0001')}\u0002${targets.map((c) => c.name).join('\u0001')}` : '';
  const [override, setOverride] = useState<{ key: string; mapping: (number | null)[] } | null>(null);
  const mapping = useMemo(() => {
    if (!source || !targets) return [];
    if (override && override.key === mappingKey) return override.mapping;
    return autoMap(source.headers, targets);
  }, [source, targets, override, mappingKey]);
  const setMappingAt = (i: number, value: number | null) => {
    const next = [...mapping];
    next[i] = value;
    setOverride({ key: mappingKey, mapping: next });
  };

  // ---- The dry run over the whole file
  const check = useMemo(
    () => (source && targets ? buildRows(source, targets, mapping, opts, 0, source.rows.length, ISSUES_SHOWN) : null),
    [source, targets, mapping, opts],
  );
  const issuesByColumn = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of check?.issues ?? []) m.set(i.column, (m.get(i.column) ?? 0) + 1);
    return m;
  }, [check]);
  const missing = targets ? missingRequired(targets, mapping) : [];
  const mappedCount = mapping.filter((m) => m !== null).length;
  const totalRows = source?.rows.length ?? 0;
  const badRows = check?.badRows ?? 0;
  const readyRows = totalRows - badRows;

  const blockReason =
    !source || !targets
      ? null
      : totalRows === 0
        ? t('importTable.blockNoRows')
        : mappedCount === 0
          ? t('importTable.blockNothingMapped')
          : missing.length > 0
            ? t('importTable.blockMissing', { cols: missing.join(', ') })
            : mode === 'atomic' && badRows > 0
              ? t('importTable.blockAtomicBad', { n: fmt(badRows) })
              : null;

  /** First non-empty value of a source column, to show what it holds. */
  const sampleOf = (srcIndex: number | null) => {
    if (srcIndex === null || !source) return '';
    for (const r of source.rows.slice(0, 50)) {
      const v = r[srcIndex];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return s.length > 40 ? `${s.slice(0, 40)}…` : s;
      }
    }
    return '';
  };

  // ---- Run as a background job
  const submit = async () => {
    if (!source || !targets || blockReason) return;
    let approval: JobApproval;
    try {
      approval = await approveJob('import_chunk', connId, t('importTable.approve', { n: fmt(readyRows), table: tableName }));
    } catch {
      return;
    }
    // Everything the job reads is fixed now: the dialog closes, and its state goes with it.
    const src = source;
    const cols = targets;
    const map = [...mapping];
    const convert = opts;
    const importMode = mode;
    const header = hasHeader || kind === 'json';
    const rowLabel = (index: number) => fmt(displayRowNumber(index, header));

    startJob({
      kind: 'import-table',
      title: t('jobs.titleImportTable', { n: tableName }),
      db: tableName,
      conn: connKeyOfConn(connId),
      write: true,
      lockKey: `${connId}|${tableName}`,
      run: (ctx) =>
        withJobConnection(connId, [approval], async ({ connId: jobConnId }) => {
          const columns = buildRows(src, cols, map, convert, 0, 0).columns;
          const { handle } = await dbHelper.importBegin(jobConnId, tableName, columns, importMode, tableSchema);
          let finished = false;
          try {
            let inserted = 0;
            let clientSkipped = 0;
            let dbFailed = 0;
            const failures: string[] = [];
            for (let from = 0; from < src.rows.length; from += CHUNK_ROWS) {
              // A cancel rolls the whole import back — the `finally` aborts the transaction.
              ctx.throwIfCancelled();
              ctx.report({
                label: t('importTable.progress', { table: tableName }),
                current: from,
                total: src.rows.length,
                detail: t('importTable.progressDetail', { done: fmt(from), total: fmt(src.rows.length) }),
              });
              const part = buildRows(src, cols, map, convert, from, from + CHUNK_ROWS, 0);
              clientSkipped += part.badRows;
              if (part.rows.length === 0) continue;
              // Sequential on purpose: one transaction, chunk after chunk, in file order.
              const res = await dbHelper.importChunk(handle, part.rows, 0);
              inserted += res.inserted;
              for (const f of res.failed) {
                dbFailed++;
                if (failures.length < 8) {
                  failures.push(t('importTable.failedRow', { row: rowLabel(part.indexes[f.row] ?? from), message: f.error }));
                }
              }
              if (res.stopped) {
                const f = res.failed[0];
                throw new Error(
                  t('importTable.errAtomicStopped', {
                    row: rowLabel(part.indexes[f?.row ?? 0] ?? from),
                    message: f?.error ?? '',
                  }),
                );
              }
            }
            await dbHelper.importFinish(handle, true);
            finished = true;
            window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId } }));
            const skipped = clientSkipped + dbFailed;
            return {
              message: skipped
                ? t('importTable.doneSkipped', { n: fmt(inserted), table: tableName, skipped: fmt(skipped) })
                : t('importTable.done', { n: fmt(inserted), table: tableName }),
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
  const loading = !loadError && (!source || !targets);

  return (
    <Modal
      title={t('importTable.title', { table: tableName })}
      icon={<FileUp size={14} />}
      onClose={onClose}
      width="860px"
    >
      <ModalBody>
        <div className="imp-file">
          <strong>{file.name}</strong>
          {source && <span>{t('importTable.rowsInFile', { n: fmt(totalRows) })}</span>}
        </div>

        {loadError && (
          <div className="imp-banner is-error">
            <AlertTriangle size={13} />
            <span>{t('importTable.errLoad', { message: loadError })}</span>
          </div>
        )}
        {loading && <div className="imp-muted">{t('importTable.loading')}</div>}

        {source && targets && (
          <>
            <div className="imp-options">
              {kind === 'csv' && (
                <>
                  <label>
                    <span>{t('importTable.delimiter')}</span>
                    <select value={delimiterChoice} onChange={(e) => setDelimiterChoice(e.target.value as 'auto' | Delimiter)}>
                      <option value="auto">{t('importTable.delimiterAuto', { d: delimiterLabel(delimiter, t) })}</option>
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
              {kind === 'xlsx' && sheets && sheets.length > 1 && (
                <label>
                  <span>{t('importTable.sheet')}</span>
                  <select value={sheetIndex} onChange={(e) => setSheetIndex(Number(e.target.value))}>
                    {sheets.map((s, i) => (
                      <option key={s.name} value={i}>{s.name}</option>
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
                <select value={emptyAs} onChange={(e) => setEmptyAs(e.target.value as CoerceOptions['emptyAs'])}>
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
                    <th>{t('importTable.colSource')}</th>
                    <th>{t('importTable.colSample')}</th>
                    <th>{t('importTable.colProblems')}</th>
                  </tr>
                </thead>
                <tbody>
                  {targets.map((col, i) => {
                    const problems = issuesByColumn.get(col.name) ?? 0;
                    return (
                      <tr key={col.name} className={col.generated ? 'is-disabled' : undefined}>
                        <td>
                          <span className="imp-col-name">{col.name}</span>
                          {!col.nullable && !col.hasDefault && !col.generated && (
                            <span className="imp-badge">{t('importTable.required')}</span>
                          )}
                        </td>
                        <td className="imp-type" title={typeFamily(col.type)}>{col.type}</td>
                        <td>
                          {col.generated ? (
                            <span className="imp-muted">{t('importTable.generated')}</span>
                          ) : (
                            <select
                              value={mapping[i] === null || mapping[i] === undefined ? '' : String(mapping[i])}
                              onChange={(e) => setMappingAt(i, e.target.value === '' ? null : Number(e.target.value))}
                            >
                              <option value="">{col.hasDefault ? t('importTable.skipDefault') : t('importTable.skip')}</option>
                              {/* Names are unique — 	oSourceTable suffixes repeats — so they key the list. */}
                              {source.headers.map((h, hi) => (
                                <option key={h} value={hi}>{h}</option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="imp-sample">{sampleOf(mapping[i] ?? null)}</td>
                        <td className={problems ? 'imp-problems' : 'imp-muted'}>{problems ? fmt(problems) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="imp-summary">
              {badRows === 0
                ? t('importTable.allGood', { n: fmt(totalRows) })
                : t('importTable.someBad', { bad: fmt(badRows), n: fmt(totalRows) })}
            </div>

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
                      <tr key={`${iss.index}:${iss.column}`}>
                        <td>{fmt(displayRowNumber(iss.index, hasHeader || kind === 'json'))}</td>
                        <td>{iss.column}</td>
                        <td className="imp-value">{iss.value === '' ? <span className="imp-muted">{t('importTable.emptyCell')}</span> : iss.value}</td>
                        <td>{t(ISSUE_KEY[iss.issue])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {badRows > check.issues.length && (
                  <div className="imp-muted">{t('importTable.moreIssues', { n: fmt(badRows) })}</div>
                )}
              </div>
            )}

            <div className="imp-mode">
              <label className="imp-check">
                <input type="radio" name="imp-mode" checked={mode === 'atomic'} onChange={() => setMode('atomic')} />
                <span>
                  <strong>{t('importTable.modeAtomic')}</strong> {t('importTable.modeAtomicHint')}
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
        <button
          type="button"
          className="btn btn-primary"
          disabled={!source || !targets || !!blockReason}
          onClick={() => void submit()}
        >
          {t('importTable.submit', { n: fmt(mode === 'skip' ? readyRows : totalRows) })}
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
