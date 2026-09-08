import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import type { ERTable, ERRelationship, ERColumn } from './erTypes';
import { ERDiagramView } from './ERDiagramView';

interface ERDiagramTabProps {
  connId: string;
  /** Server identity from `utils/connKey.ts` — the localStorage scope for the saved layout. */
  storageScope: string;
  dbName?: string;
  schema?: string;
  onOpenTable?: (tableName: string) => void;
}

interface Loaded {
  tables: ERTable[];
  relationships: ERRelationship[];
}

type StaleCheck = () => boolean;

/**
 * Reads the schema for the diagram.
 *
 * `get_full_catalog` answers in two or three queries on MySQL/Postgres. It returns nothing on
 * SQLite (no `information_schema`), which is the only reason the per-table fallback exists — and
 * that one is deliberately sequential: one `Promise.all` over a few hundred tables would fire
 * that many concurrent reads at the user's database, which this app avoids everywhere else.
 */
async function loadDiagram(connId: string, isStale: StaleCheck): Promise<Loaded> {
  const fullCatalog = await dbHelper.getFullCatalog(connId);
  const rawCols = fullCatalog.columns || {};
  const rawFks = fullCatalog.foreignKeys || {};
  const tableNames = Object.keys(rawCols);

  const tables: ERTable[] = [];
  const relationships: ERRelationship[] = [];

  if (tableNames.length > 0) {
    for (const tableName of tableNames) {
      const colList = rawCols[tableName] || [];
      const cols: ERColumn[] = colList.map((col: any) => ({
        name: col.name,
        type: col.type,
        isPrimaryKey: !!col.isPrimaryKey,
        isForeignKey: false,
        nullable: col.nullable,
      }));
      const byName = new Map(cols.map((col) => [col.name.toLowerCase(), col]));

      for (const fk of rawFks[tableName] || []) {
        const matching = byName.get((fk.column || '').toLowerCase());
        if (matching) {
          matching.isForeignKey = true;
          matching.refTable = fk.refTable;
          matching.refColumn = fk.refColumn;
        }
        relationships.push({
          id: `${tableName}.${fk.column}->${fk.refTable}.${fk.refColumn || fk.column}`,
          name: fk.name,
          sourceTable: tableName,
          sourceColumn: fk.column,
          targetTable: fk.refTable,
          targetColumn: fk.refColumn || fk.column,
        });
      }

      tables.push({ id: tableName, name: tableName, columns: cols });
    }
    return { tables, relationships };
  }

  const dbTables = await dbHelper.getTables(connId);
  for (const tbl of dbTables) {
    if (isStale()) break;
    let schema: Awaited<ReturnType<typeof dbHelper.getTableSchema>> | null = null;
    try {
      schema = await dbHelper.getTableSchema(connId, tbl.name);
    } catch {
      continue;
    }
    if (!schema) continue;

    const fks = schema.foreignKeys || [];
    const cols: ERColumn[] = (schema.columns || []).map((col) => {
      const fkItem = fks.find((fk) => fk.column === col.name);
      return {
        name: col.name,
        type: col.type,
        isPrimaryKey: !!col.isPrimaryKey,
        isForeignKey: !!fkItem,
        refTable: fkItem?.refTable,
        refColumn: fkItem?.refColumn,
        nullable: col.nullable,
      };
    });

    tables.push({
      id: tbl.name,
      name: tbl.name,
      kind: tbl.type === 'view' ? 'view' : 'table',
      columns: cols,
    });

    for (const fk of fks) {
      relationships.push({
        id: `${tbl.name}.${fk.column}->${fk.refTable}.${fk.refColumn || fk.column}`,
        name: fk.name,
        sourceTable: tbl.name,
        sourceColumn: fk.column,
        targetTable: fk.refTable,
        targetColumn: fk.refColumn || fk.column,
      });
    }
  }

  return { tables, relationships };
}

export const ERDiagramTab: React.FC<ERDiagramTabProps> = ({
  connId,
  storageScope,
  dbName,
  schema,
  onOpenTable,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Loaded>({ tables: [], relationships: [] });

  const load = useCallback(async (isStale: StaleCheck = () => false) => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadDiagram(connId, isStale);
      if (isStale()) return;
      setData(next);
    } catch (err: any) {
      if (isStale()) return;
      console.error('Failed to load ER diagram data:', err);
      setError(err?.message || String(err));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [connId]);

  useEffect(() => {
    let active = true;
    // set-state-in-effect: reading the schema is async IPC on mount, which is the case the rule
    // cannot express — there is no value to derive during render and nothing but mounting can
    // trigger the read. The flag is what keeps a reload from a stale run writing over a new one.
    // eslint-disable-next-line react/set-state-in-effect
    void load(() => !active);
    return () => {
      active = false;
    };
  }, [load]);

  if (loading) {
    return (
      <div className="er-loading-container">
        <Loader2 size={24} className="er-loading-spinner" />
        <span>{t('er.loadingSchema')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="er-error-container">
        <AlertCircle size={28} className="er-error-icon" />
        <div className="er-error-title">{t('er.loadError')}</div>
        <div className="er-error-desc">{error}</div>
        <button type="button" className="btn btn-primary" onClick={() => void load()}>
          <RefreshCw size={13} />
          <span>{t('common.retry')}</span>
        </button>
      </div>
    );
  }

  if (data.tables.length === 0) {
    return (
      <div className="er-empty-container">
        <div className="er-empty-title">{t('er.emptyTitle')}</div>
        <div className="er-empty-desc">{t('er.emptyDesc')}</div>
      </div>
    );
  }

  return (
    <div className="er-tab-wrapper">
      <ERDiagramView
        connId={connId}
        storageScope={storageScope}
        database={dbName}
        schema={schema}
        tables={data.tables}
        relationships={data.relationships}
        onOpenTable={onOpenTable}
      />
    </div>
  );
};
