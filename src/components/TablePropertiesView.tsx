import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Columns3,
  Copy,
  Database,
  FileCode2,
  HardDrive,
  Hash,
  KeyRound,
  ListTree,
  RefreshCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { dbHelper, type TableProperties } from '../utils/dbHelper';

interface TablePropertiesViewProps {
  connId: string;
  tableName: string;
  /** `TableItem.schema` — set only for a Postgres session-temporary table (see `dbHelper`). */
  tableSchema?: string;
}

/**
 * One label/value line inside a card. `null`/`undefined` values never reach here: the cards filter
 * them out (see `visible`), because a dialect that has no answer for a field should not print a
 * row of dashes — a Postgres table has no ROW_FORMAT, and saying "-" implies it might.
 */
type PropRow = { key: string; label: string; value: React.ReactNode; mono?: boolean };

/**
 * The keywords the DDL block highlights.
 *
 * Deliberately a small hand-list rather than Monaco: the editor is lazy-loaded on purpose (see the
 * build notes in CLAUDE.md) and importing it from a panel `DataGrid` can render would drag the 4MB
 * chunk back into startup for every tab. This block is read-only text, so a tokenizer is enough.
 */
const SQL_KEYWORDS = new Set([
  'ADD', 'AFTER', 'ALTER', 'AND', 'AS', 'ASC', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'BEGIN', 'BIGINT',
  'BINARY', 'BLOB', 'BOOLEAN', 'BY', 'CASCADE', 'CASE', 'CHAR', 'CHARACTER', 'CHARSET', 'CHECK',
  'COLLATE', 'COLUMN', 'COMMENT', 'CONSTRAINT', 'CREATE', 'CURRENT_TIMESTAMP', 'DATA', 'DATE',
  'DATETIME', 'DECIMAL', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DOUBLE', 'DROP', 'ELSE', 'END',
  'ENGINE', 'ENUM', 'EXISTS', 'FALSE', 'FLOAT', 'FOREIGN', 'FROM', 'FULL', 'GENERATED', 'GROUP',
  'HAVING', 'IDENTITY', 'IF', 'IN', 'INDEX', 'INNER', 'INT', 'INTEGER', 'INTERVAL', 'INTO', 'IS',
  'JOIN', 'JSON', 'KEY', 'LEFT', 'LIKE', 'LIMIT', 'MATERIALIZED', 'NOT', 'NULL', 'NUMERIC', 'ON',
  'OR', 'ORDER', 'OUTER', 'PRIMARY', 'REAL', 'REFERENCES', 'RESTRICT', 'RIGHT', 'SELECT', 'SERIAL',
  'SET', 'SMALLINT', 'STORED', 'TABLE', 'TEMP', 'TEMPORARY', 'TEXT', 'THEN', 'TIME', 'TIMESTAMP',
  'TRUE', 'UNIQUE', 'UNSIGNED', 'UPDATE', 'USING', 'UUID', 'VALUES', 'VARCHAR', 'VIEW', 'WHEN',
  'WHERE', 'WITH', 'ZEROFILL',
]);

// Comment, single-quoted literal, quoted identifier, word — in that order, so a `--` inside a
// string is a string and a quote inside a comment is a comment. Anything not matched is copied
// through verbatim, which is what keeps the rendered text byte-identical to the DDL.
const TOKEN_RE = /(--.*$)|('(?:[^']|'')*')|("(?:[^"]|"")*"|`[^`]*`)|([A-Za-z_][A-Za-z0-9_$]*)/g;

function highlightSql(line: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = new RegExp(TOKEN_RE.source, 'g');
  let last = 0;
  let seq = 0;
  let m: RegExpExecArray | null = re.exec(line);
  while (m !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    const [tok, comment, str, quoted, word] = m;
    if (comment) parts.push(<span key={seq++} className="tp-cmt">{tok}</span>);
    else if (str) parts.push(<span key={seq++} className="tp-str">{tok}</span>);
    else if (!quoted && word && SQL_KEYWORDS.has(word.toUpperCase())) {
      parts.push(<span key={seq++} className="tp-kw">{tok}</span>);
    } else parts.push(tok);
    last = m.index + tok.length;
    m = re.exec(line);
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

/** Bytes as the shortest readable unit. `null` is "unknown", never 0 B. */
function formatBytes(bytes: number | null | undefined, locale: string): string | null {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return null;
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  const scaled = bytes / 1024 ** i;
  return `${scaled.toLocaleString(locale, { maximumFractionDigits: i === 0 ? 0 : 2 })} ${units[i]}`;
}

function formatCount(n: number | null | undefined, locale: string): string | null {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return n.toLocaleString(locale);
}

/**
 * A timestamp as the OS spells it locally.
 *
 * The backends disagree on the wire format (MySQL hands back `2024-05-01 10:00:00`, Postgres an ISO
 * string), so an unparseable value is shown verbatim rather than as "Invalid Date".
 */
function formatTime(raw: string | null | undefined, locale: string): string | null {
  if (!raw) return null;
  const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString(locale);
}

export const TablePropertiesView: React.FC<TablePropertiesViewProps> = ({
  connId,
  tableName,
  tableSchema,
}) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const [props, setProps] = useState<TableProperties | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exactRows, setExactRows] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [copied, setCopied] = useState<'ddl' | 'summary' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await dbHelper.getTableProperties(connId, tableName, tableSchema);
    if (res.success && res.properties) {
      setProps(res.properties);
      // A refresh must not keep a count taken before the table changed underneath it.
      setExactRows(res.properties.rowsExact ? res.properties.estimatedRows : null);
    } else {
      setProps(null);
      setError(res.error || t('tableProperties.loadFailed'));
    }
    setLoading(false);
  }, [connId, tableName, tableSchema, t]);

  useEffect(() => {
    // set-state-in-effect: this is the async-IPC-on-mount case the rule cannot express. The panel's
    // whole content comes from one backend round trip, so there is nothing to derive during render
    // and nothing to initialise state with — the fifth documented exception in CLAUDE.md, alongside
    // the four that already exist.
    // eslint-disable-next-line react/set-state-in-effect
    void load();
  }, [load]);

  const handleCountExact = async () => {
    setCounting(true);
    const res = await dbHelper.getExactTableRowCount(connId, tableName);
    setCounting(false);
    if (res.success && res.exact_rows !== undefined) setExactRows(res.exact_rows);
    else setError(res.error || t('tableProperties.countFailed'));
  };

  const flashCopied = (what: 'ddl' | 'summary') => {
    setCopied(what);
    window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600);
  };

  const handleCopyDdl = () => {
    if (!props?.ddl) return;
    navigator.clipboard.writeText(props.ddl).then(() => flashCopied('ddl')).catch(() => undefined);
  };


  /**
   * The property groups this dialect answered, in one frame.
   *
   * The groups are back after a version without them, and the reason is worth keeping: flattened
   * into one list they read left-to-right, so unrelated values landed side by side and there was no
   * chunk for the eye to hold. What made the old layout heavy was five bordered CARDS, not five
   * headings — so the headings stay and the frames are gone.
   *
   * `visible` drops a row whose value is null — see `PropRow` — and a group that ends up empty is
   * dropped with it, so a SQLite table shows no statistics group and a Postgres one no
   * storage-engine line, instead of a column of dashes.
   */
  const groups = useMemo(() => {
    if (!props) return [] as { id: string; title: string; rows: PropRow[] }[];

    const visible = (rows: (PropRow | null)[]): PropRow[] =>
      rows.filter((r): r is PropRow => r !== null && r.value !== null && r.value !== undefined);

    const textRow = (key: string, label: string, value: string | null | undefined, mono?: boolean): PropRow | null =>
      value ? { key, label, value, mono } : null;

    const bytesRow = (key: string, label: string, value: number | null | undefined): PropRow | null => {
      const formatted = formatBytes(value, locale);
      return formatted === null ? null : { key, label, value: formatted };
    };

    const countRow = (key: string, label: string, value: number | null | undefined): PropRow | null => {
      const formatted = formatCount(value, locale);
      return formatted === null ? null : { key, label, value: formatted };
    };

    const timeRow = (key: string, label: string, value: string | null | undefined): PropRow | null => {
      const formatted = formatTime(value, locale);
      return formatted === null ? null : { key, label, value: formatted };
    };

    // Neither the name nor the type has a row: the toolbar above already carries both, the name as
    // the heading and the type as a badge beside it. Repeating them here was two of this card's ten
    // lines saying what the reader had just read.
    const general = visible([
      textRow('schema', t('tableProperties.rowSchema'), props.schemaName, true),
      textRow('engine', t('tableProperties.rowEngine'), props.engine),
      textRow('rowFormat', t('tableProperties.rowRowFormat'), props.rowFormat),
      textRow('collation', t('tableProperties.rowCollation'), props.collation, true),
      textRow('charset', t('tableProperties.rowCharacterSet'), props.characterSet, true),
      textRow('tablespace', t('tableProperties.rowTablespace'), props.tablespace, true),
      textRow('createOptions', t('tableProperties.rowCreateOptions'), props.createOptions, true),
      textRow('filePath', t('tableProperties.rowFilePath'), props.filePath, true),
      textRow('comment', t('tableProperties.rowComment'), props.comment),
    ]);

    // Total size is the first tile, so the card carries the breakdown only.
    const storage = visible([
      bytesRow('data', t('tableProperties.rowDataSize'), props.dataSizeBytes),
      bytesRow('index', t('tableProperties.rowIndexSize'), props.indexSizeBytes),
      bytesRow('free', t('tableProperties.rowFreeSize'), props.freeSizeBytes),
      bytesRow('avgRow', t('tableProperties.rowAvgRowLength'), props.avgRowLengthBytes),
      countRow('autoInc', t('tableProperties.rowAutoIncrement'), props.autoIncrement),
    ]);

    // The row count lives in the second tile, which is also where an exact count replaces the
    // estimate. The estimate reappears HERE once that happens — at that point the two numbers side
    // by side are the interesting thing (how far off the planner was), which a single tile cannot
    // show. Before it happens there is nothing to compare and no row.
    const rows = visible([
      exactRows !== null && !props.rowsExact
        ? {
            key: 'estimated',
            label: t('tableProperties.rowEstimatedRows'),
            value: `~${formatCount(props.estimatedRows, locale) ?? ''}`,
          }
        : null,
      countRow('live', t('tableProperties.rowLiveTuples'), props.liveTuples),
      countRow('dead', t('tableProperties.rowDeadTuples'), props.deadTuples),
      countRow('seqScan', t('tableProperties.rowSeqScans'), props.seqScans),
      countRow('idxScan', t('tableProperties.rowIndexScans'), props.indexScans),
    ]);

    // Column and index counts are the third and fourth tiles; this card holds what a number cannot
    // say — which columns the key is made of, and which way the foreign keys point.
    const keys = visible([
      props.primaryKeys.length > 0
        ? {
            key: 'pk',
            label: t('tableProperties.rowPrimaryKeys'),
            value: (
              <span className="tp-badges">
                {props.primaryKeys.map((col) => (
                  <span key={col} className="tp-badge tp-badge-key">{col}</span>
                ))}
              </span>
            ),
          }
        : { key: 'pk', label: t('tableProperties.rowPrimaryKeys'), value: t('tableProperties.noPrimaryKey') },
      countRow('fkOut', t('tableProperties.rowForeignKeys'), props.foreignKeyCount),
      countRow('fkIn', t('tableProperties.rowReferencedBy'), props.referencedByCount),
    ]);

    const maintenance = visible([
      timeRow('created', t('tableProperties.rowCreateTime'), props.createTime),
      timeRow('updated', t('tableProperties.rowUpdateTime'), props.updateTime),
      timeRow('checked', t('tableProperties.rowCheckTime'), props.checkTime),
      timeRow('vacuum', t('tableProperties.rowLastVacuum'), props.lastVacuum),
      timeRow('analyze', t('tableProperties.rowLastAnalyze'), props.lastAnalyze),
    ]);

    return [
      { id: 'general', title: t('tableProperties.groupGeneral'), rows: general },
      { id: 'storage', title: t('tableProperties.groupStorage'), rows: storage },
      { id: 'keys', title: t('tableProperties.groupKeys'), rows: keys },
      { id: 'stats', title: t('tableProperties.groupStats'), rows },
      { id: 'maintenance', title: t('tableProperties.groupMaintenance'), rows: maintenance },
    ].filter((group) => group.rows.length > 0);
  }, [props, exactRows, locale, t]);

  /**
   * The whole panel as a Markdown table, for pasting into a ticket or a migration note.
   *
   * It reads the same `groups` the panel renders — one source, so what is copied is what was on
   * screen. Rows whose value is a node rather than a string (the PK badges) are rendered from the
   * data instead, since a React element has no text form.
   */
  const handleCopySummary = () => {
    if (!props) return;
    // The four headline numbers are written explicitly: they are tiles, not detail rows, so walking
    // `details` alone would produce a summary missing the size and the row count.
    const headline: [string, string][] = [
      [t('tableProperties.rowType'), props.tableType],
      [t('tableProperties.rowTotalSize'), formatBytes(props.totalSizeBytes, locale) ?? '—'],
      [
        props.rowsExact || exactRows !== null
          ? t('tableProperties.rowRowCount')
          : t('tableProperties.rowEstimatedRows'),
        `${props.rowsExact || exactRows !== null ? '' : '~'}${
          formatCount(exactRows ?? props.estimatedRows, locale) ?? '—'
        }`,
      ],
      [t('tableProperties.rowColumnCount'), formatCount(props.columnCount, locale) ?? '—'],
      [t('tableProperties.rowIndexCount'), formatCount(props.indexCount, locale) ?? '—'],
    ];
    const lines = [
      `# ${props.tableName}`,
      '',
      `| ${t('tableProperties.summaryProperty')} | ${t('tableProperties.summaryValue')} |`,
      '| --- | --- |',
      ...headline.map(([label, value]) => `| ${label} | ${value} |`),
      // The group name goes in as a bold cell rather than as a heading between tables: one table
      // pastes into a ticket or a PR description intact, five do not.
      ...groups.flatMap((group) => [
        `| **${group.title}** | |`,
        ...group.rows.map(
          (row) =>
            `| ${row.label} | ${
              typeof row.value === 'string' ? row.value : props.primaryKeys.join(', ')
            } |`
        ),
      ]),
    ];
    if (props.ddl) lines.push('', '```sql', props.ddl, '```');
    navigator.clipboard
      .writeText(lines.join('\n'))
      .then(() => flashCopied('summary'))
      .catch(() => undefined);
  };

  if (loading && !props) {
    return (
      <div className="tp-container">
        <div className="tp-state">
          <RefreshCw size={22} className="loading-spinner" />
          <span>{t('tableProperties.loading')}</span>
        </div>
      </div>
    );
  }

  if (!props) {
    return (
      <div className="tp-container">
        <div className="tp-state">
          <AlertTriangle size={22} />
          <span className="tp-state-error">{error || t('tableProperties.loadFailed')}</span>
          <button type="button" className="tp-btn" onClick={() => void load()}>
            <RefreshCw size={12} />
            <span>{t('tableProperties.refresh')}</span>
          </button>
        </div>
      </div>
    );
  }

  const ddlLines = props.ddl ? props.ddl.split('\n') : [];
  const totalSize = formatBytes(props.totalSizeBytes, locale);
  const shownRows = exactRows ?? props.estimatedRows;
  const rowsAreExact = props.rowsExact || exactRows !== null;

  return (
    <div className="tp-container">
      <div className="tp-toolbar">
        <div className="tp-toolbar-left">
          <div className="tp-title">
            <Database size={13} className="tp-title-icon" />
            <span className="tp-title-name">{props.tableName}</span>
          </div>
          <span className="tp-badge tp-badge-kind">{props.tableType}</span>
          {props.isTemporary && (
            <span className="tp-badge tp-badge-temp">{t('tableProperties.badgeTemporary')}</span>
          )}
          {props.isView && (
            <span className="tp-badge tp-badge-view">{t('tableProperties.badgeView')}</span>
          )}
        </div>

        <div className="tp-toolbar-actions">
          <button type="button" className="tp-btn" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'loading-spinner' : undefined} />
            <span>{t('tableProperties.refresh')}</span>
          </button>

          {/* Hidden when the number on screen was already counted for real (SQLite always, a MySQL
              temp table) — a button that recomputes what it already shows only invites doubt. */}
          {!props.rowsExact && !props.isView && (
            <button
              type="button"
              className="tp-btn tp-btn-primary"
              onClick={() => void handleCountExact()}
              disabled={counting}
              title={t('tableProperties.countExactTitle')}
            >
              <Hash size={12} className={counting ? 'loading-spinner' : undefined} />
              <span>{counting ? t('tableProperties.counting') : t('tableProperties.countExact')}</span>
            </button>
          )}

          <button type="button" className="tp-btn" onClick={handleCopySummary}>
            {copied === 'summary' ? <Check size={12} /> : <ClipboardCopy size={12} />}
            <span>{copied === 'summary' ? t('tableProperties.copied') : t('tableProperties.copySummary')}</span>
          </button>

          <button type="button" className="tp-btn" onClick={handleCopyDdl} disabled={!props.ddl}>
            {copied === 'ddl' ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied === 'ddl' ? t('tableProperties.copied') : t('tableProperties.copyDdl')}</span>
          </button>
        </div>
      </div>

      <div className="tp-content">
        {error && <div className="tp-state-error">{error}</div>}

        {/* The four numbers worth reading first. Each one is deliberately the ONLY place it appears:
            the cards below carry the breakdown, not a second copy of the headline. Every tile's icon
            is the icon of the card that details it, so the eye can follow one to the other. */}
        <div className="tp-metrics">
          <div className="tp-metric">
            <div className="tp-metric-head tp-metric-head-size">
              <HardDrive size={14} className="tp-metric-icon" />
              <span className="tp-metric-label">{t('tableProperties.metricTotalSize')}</span>
            </div>
            <span className="tp-metric-val">{totalSize ?? '—'}</span>
            <span className="tp-metric-sub">{props.engine ?? props.dbType}</span>
          </div>
          <div className="tp-metric">
            <div className="tp-metric-head tp-metric-head-rows">
              <Hash size={14} className="tp-metric-icon" />
              <span className="tp-metric-label">{t('tableProperties.metricRows')}</span>
            </div>
            <span className="tp-metric-val">
              {rowsAreExact ? '' : '~'}
              {formatCount(shownRows, locale)}
            </span>
            <span className="tp-metric-sub">
              {rowsAreExact ? t('tableProperties.rowsExactHint') : t('tableProperties.rowsEstimateHint')}
            </span>
          </div>
          <div className="tp-metric">
            <div className="tp-metric-head tp-metric-head-cols">
              <Columns3 size={14} className="tp-metric-icon" />
              <span className="tp-metric-label">{t('tableProperties.metricColumns')}</span>
            </div>
            <span className="tp-metric-val">{formatCount(props.columnCount, locale)}</span>
            <span className="tp-metric-sub">
              {props.primaryKeys.length > 0
                ? t('tableProperties.pkColumns', { n: props.primaryKeys.length })
                : t('tableProperties.noPrimaryKey')}
            </span>
          </div>
          <div className="tp-metric">
            <div className="tp-metric-head tp-metric-head-idx">
              <KeyRound size={14} className="tp-metric-icon" />
              <span className="tp-metric-label">{t('tableProperties.metricIndexes')}</span>
            </div>
            <span className="tp-metric-val">{formatCount(props.indexCount, locale) ?? '—'}</span>
            <span className="tp-metric-sub">
              {t('tableProperties.fkCount', { n: props.foreignKeyCount ?? 0 })}
            </span>
          </div>
        </div>

        {/* The title bar is not decoration: the Definition card below has one, so without it this
            card read as an unfinished box sitting on a finished one. The two are siblings and now
            look like it. Each group inside is its own grid item, which is what makes it a column
            rather than a full-width band. */}
        <section className="tp-card">
          <div className="tp-card-title">
            <ListTree size={12} className="tp-card-title-icon" />
            <span>{t('tableProperties.cardDetails')}</span>
            <span className="tp-card-title-note">
              {t('tableProperties.propertyCount', {
                n: groups.reduce((total, group) => total + group.rows.length, 0),
              })}
            </span>
          </div>
          <div className="tp-details">
            {groups.map((group) => (
              <div key={group.id} className="tp-group">
                <div className="tp-group-head">{group.title}</div>
                {group.rows.map((row) => (
                  <div key={row.key} className="tp-row">
                    <span className="tp-label">{row.label}</span>
                    <span className={row.mono ? 'tp-val tp-val-mono' : 'tp-val'}>{row.value}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="tp-card">
          <div className="tp-card-title">
            <FileCode2 size={12} className="tp-card-title-icon" />
            <span>{t('tableProperties.cardDefinition')}</span>
            {ddlLines.length > 0 && (
              <span className="tp-card-title-note">
                {t('tableProperties.lineCount', { n: ddlLines.length })}
              </span>
            )}
          </div>
          {props.ddl ? (
            <pre className="tp-codeblock">
              {/* The index IS the identity here: this is a numbered listing of lines, and two
                  identical lines of DDL are two different lines. */}
              {ddlLines.map((line, idx) => (
                // eslint-disable-next-line react/no-array-index-key
                <div key={idx} className="tp-code-line">
                  <span className="tp-code-gutter">{idx + 1}</span>
                  <span className="tp-code-text">{highlightSql(line)}</span>
                </div>
              ))}
            </pre>
          ) : (
            <div className="tp-card-body">
              <div className="tp-row tp-row-full">
                <span className="tp-val tp-val-muted">{t('tableProperties.noDefinition')}</span>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
