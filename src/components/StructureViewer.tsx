import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SchemaInfo, ColumnInfo, TriggerInfo, PartitionInfo, CheckConstraintInfo } from '../utils/dbHelper';
import * as catalog from '../sql/catalog';
import { dbHelper } from '../utils/dbHelper';
import { Save, Plus, Trash2, RotateCcw, AlertTriangle, CheckCircle2, Key, Search, X, Table2, ArrowRight, Copy, Pencil } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { splitType, joinType, typeBase } from '../utils/columnType';

type StructureSection = 'columns' | 'indexes' | 'fks' | 'check_constraints' | 'triggers' | 'partitions' | 'ddl';

// Sentinel option value of the data-type dropdown — a type the dialect list does not
// carry is still reachable, the same escape hatch the default-value cell uses.
const CUSTOM_TYPE = '__custom_type__';

interface StructureViewerProps {
  /** The connection this component acts on. Passed explicitly, never read from the ambient id (§4.1). */
  connId: string;
  tableName: string;
  schema: SchemaInfo;
  dbType: 'sqlite' | 'postgres' | 'mysql' | 'duckdb';
  onSchemaChanged: () => void;
  readOnly?: boolean;
  activeSection?: StructureSection;
  onSectionChange?: (sec: StructureSection) => void;
}

const HighlightSqlView: React.FC<{ sql: string; loading?: boolean; emptyText?: string }> = ({ sql, loading, emptyText }) => {
  if (loading) {
    return <div className="st-ddl-codeblock" style={{ padding: '16px', color: 'var(--win-text-disabled)' }}>Loading DDL...</div>;
  }
  if (!sql) {
    return <div className="st-ddl-codeblock" style={{ padding: '16px', color: 'var(--win-text-disabled)' }}>{emptyText || 'Empty SQL'}</div>;
  }

  let raw = sql.trim();
  if (!raw.includes('\n')) {
    raw = raw
      .replace(/\s*\(\s*/g, ' (\n  ')
      .replace(/,\s*(?=(?:[^']*'[^']*')*[^']*$)/g, ',\n  ')
      .replace(/\s*\)\s*/g, '\n)\n');
  }

  const lines = raw.split('\n');

  const processLineTokens = (line: string) => {
    const regex = /(`[^`]+`)|('[^']*')|(\b(?:CREATE TABLE|PRIMARY KEY|FOREIGN KEY|KEY|CONSTRAINT|REFERENCES|ON DELETE|ON UPDATE|CASCADE|RESTRICT|SET NULL|SET DEFAULT|NOT NULL|AUTO_INCREMENT|DEFAULT|ENGINE|CHARSET|COLLATE|UNSIGNED|NULL|DROP TABLE|TRUNCATE|ALTER TABLE|ADD COLUMN|DROP COLUMN|MODIFY COLUMN|INDEX|UNIQUE|FULLTEXT|SPATIAL)\b)|(\b(?:smallint|varchar|text|year|tinyint|decimal|enum|set|timestamp|datetime|date|time|int|bigint|mediumint|char|blob|longtext|mediumtext|tinytext|json|boolean|bit|float|double)\b)|(\b\d+\b)/gi;

    const elements: React.ReactNode[] = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(line)) !== null) {
      const idx = match.index;
      if (idx > lastIdx) {
        elements.push(line.slice(lastIdx, idx));
      }

      const [full, identifier, strVal, keyword, dataType, numberVal] = match;

      if (identifier) {
        elements.push(<span key={idx} style={{ color: 'var(--win-accent, #60a5fa)', fontWeight: 600 }}>{identifier}</span>);
      } else if (strVal) {
        elements.push(<span key={idx} style={{ color: '#f59e0b' }}>{strVal}</span>);
      } else if (keyword) {
        elements.push(<span key={idx} style={{ color: '#c084fc', fontWeight: 700 }}>{keyword.toUpperCase()}</span>);
      } else if (dataType) {
        elements.push(<span key={idx} style={{ color: '#2dd4bf', fontWeight: 600 }}>{dataType.toLowerCase()}</span>);
      } else if (numberVal) {
        elements.push(<span key={idx} style={{ color: '#fb923c' }}>{numberVal}</span>);
      } else {
        elements.push(full);
      }

      lastIdx = regex.lastIndex;
    }

    if (lastIdx < line.length) {
      elements.push(line.slice(lastIdx));
    }

    return elements;
  };

  return (
    <div className="st-ddl-codeblock">
      <table className="st-ddl-table">
        <tbody>
          {lines.map((line, idx) => (
            <tr key={idx}>
              <td className="st-ddl-linenum">{idx + 1}</td>
              <td className="st-ddl-linecontent">{processLineTokens(line)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const StructureViewer: React.FC<StructureViewerProps> = ({
  connId,
  tableName,
  schema,
  dbType,
  onSchemaChanged,
  readOnly = false,
  activeSection,
  onSectionChange,
}) => {
  const { t } = useTranslation();

  // Columns state
  const [cols, setCols] = useState<ColumnInfo[]>([]);
  const [deletedColNames, setDeletedColNames] = useState<string[]>([]);
  const [editingColCell, setEditingColCell] = useState<{ rowIndex: number; field: 'name' | 'type' | 'length' | 'nullable' | 'defaultValue' | 'comment' } | null>(null);
  const [editColValue, setEditColValue] = useState<string>('');

  // Indexes state
  const [idxs, setIdxs] = useState<{ name: string; columns: string; unique: boolean }[]>([]);
  const [deletedIdxNames, setDeletedIdxNames] = useState<string[]>([]);
  const [editingIdxCell, setEditingIdxCell] = useState<{ rowIndex: number; field: 'name' | 'columns' | 'unique' } | null>(null);
  const [editIdxValue, setEditIdxValue] = useState<string>('');
  const [idxModalData, setIdxModalData] = useState<{ index: number; name: string; origName?: string; columns: string[]; type: string; isNew: boolean } | null>(null);

  // Foreign Keys state
  const [fks, setFks] = useState<{ name: string; column: string; refTable: string; refColumn: string }[]>([]);
  const [deletedFkNames, setDeletedFkNames] = useState<string[]>([]);
  const [editingFkCell, setEditingFkCell] = useState<{ rowIndex: number; field: 'name' | 'column' | 'refTable' | 'refColumn' | 'onUpdate' | 'onDelete' } | null>(null);
  const [editFkValue, setEditFkValue] = useState<string>('');

  // Triggers, Partitions, Check Constraints state
  const [triggers, setTriggers] = useState<TriggerInfo[]>([]);
  const [triggerModalData, setTriggerModalData] = useState<{ isNew: boolean; origName?: string; name: string; timing: string; event: string; body: string } | null>(null);

  const [partitions, setPartitions] = useState<PartitionInfo[]>([]);
  const [showAddPartitionModal, setShowAddPartitionModal] = useState<boolean>(false);
  const [newPartition, setNewPartition] = useState<{ name: string; valClause: string }>({ name: '', valClause: '' });

  const [constraints, setConstraints] = useState<CheckConstraintInfo[]>([]);
  const [checkModalData, setCheckModalData] = useState<{ isNew: boolean; origName?: string; name: string; expression: string } | null>(null);

  /**
   * Object waiting for a drop confirmation — one state for all three kinds, since the
   * dialog has the same shape and only the wording differs.
   *
   * `window.confirm()` cannot be used: inside the Tauri webview it is replaced by a call to
   * `plugin:dialog|confirm`, which the dialog plugin does not ship (only `message`/`open`/
   * `save`), so the call throws "Command not found" and the user sees nothing at all.
   */
  const [dropTarget, setDropTarget] = useState<{ kind: 'check' | 'trigger' | 'partition'; name: string } | null>(null);

  // Active pane + controlled sync
  const [internalSection, setInternalSection] = useState<StructureSection>('columns');
  const section = activeSection ?? internalSection;
  const setSection = (sec: StructureSection) => {
    setInternalSection(sec);
    onSectionChange?.(sec);
  };

  const [filter, setFilter] = useState('');

  // FK Popover & Modal state
  const [fkPopoverCol, setFkPopoverCol] = useState<string | null>(null);
  const [fkPopoverPos, setFkPopoverPos] = useState<{ top: number; left: number } | null>(null);

  // Structure Viewer Context Menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: 'column' | 'index' | 'fk';
    rowIndex: number;
    name: string;
  } | null>(null);

  const handleRowContextMenu = (e: React.MouseEvent, type: 'column' | 'index' | 'fk', rowIndex: number, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 180;
    const menuHeight = 180;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);
    setContextMenu({ x, y, type, rowIndex, name });
  };

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, []);

  interface FkModalState {
    name?: string;
    column: string;
    refTable: string;
    refColumn: string;
    onUpdate: string;
    onDelete: string;
    isNew: boolean;
    origName?: string;
  }
  const [fkModalData, setFkModalData] = useState<FkModalState | null>(null);

  // `getColumnsOf` is defined far below and is a plain function, so its identity changes on every
  // render. The effect reads it through a ref: putting it in the deps would loop forever, while
  // leaving it out means that after a connection switch the effect still calls the old closure and
  // reads columns from the previous connection.
  const getColumnsOfRef = useRef<((table: string) => Promise<string[]>) | null>(null);

  // Automatically fetch referenced table columns whenever fkModalData refTable changes or modal opens
  useEffect(() => {
    if (fkModalData?.refTable) {
      void getColumnsOfRef.current?.(fkModalData.refTable).then(refCols => {
        setRefColumns(refCols);
      });
    } else {
      setRefColumns([]);
    }
  }, [fkModalData?.refTable]);

  // Status messages
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [previewSqls, setPreviewSqls] = useState<string[] | null>(null);
  const [definitionSql, setDefinitionSql] = useState<string | null>(null);
  const [alterPreview, setAlterPreview] = useState<string[] | null>(null);
  const [ddlLoading, setDdlLoading] = useState(false);
  const [allTables, setAllTables] = useState<string[]>([]);
  const [refColumns, setRefColumns] = useState<string[]>([]);

  // Error messages dismiss themselves after 6 seconds
  useEffect(() => {
    if (!errorMsg) return;
    const timer = setTimeout(() => setErrorMsg(null), 6000);
    return () => clearTimeout(timer);
  }, [errorMsg]);

  // Load all tables for foreign key referenced table dropdown selection
  useEffect(() => {
    const fetchAllTables = async () => {
      try {
        const list = await dbHelper.getTables(connId);
        setAllTables(list.map(tbl => tbl.name));
      } catch (err) {
        console.error("Lỗi lấy danh sách bảng:", err);
      }
    };
    fetchAllTables();
  }, [connId]);

  // Database specific type lists. Base types WITHOUT a sample length — the length is
  // its own cell now, so an option like `VARCHAR(255)` would fight with it.
  const getTypesForDb = () => {
    switch (dbType) {
      case 'postgres':
        return [
          'INTEGER', 'BIGINT', 'SMALLINT', 'VARCHAR', 'CHAR', 'TEXT',
          'BOOLEAN', 'NUMERIC', 'REAL', 'DOUBLE PRECISION', 'DATE',
          'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL', 'UUID', 'JSON', 'JSONB', 'BYTEA'
        ];
      case 'mysql':
        return [
          'BIGINT', 'BINARY', 'BIT', 'BLOB', 'BOOLEAN', 'CHAR', 'DATE', 'DATETIME',
          'DECIMAL', 'DOUBLE', 'ENUM', 'FLOAT', 'GEOMETRY', 'GEOMETRYCOLLECTION',
          'INT', 'JSON', 'LINESTRING', 'LONGBLOB', 'LONGTEXT', 'MEDIUMBLOB',
          'MEDIUMINT', 'MEDIUMTEXT', 'MULTILINESTRING', 'MULTIPOINT', 'MULTIPOLYGON',
          'POINT', 'POLYGON', 'SET', 'SMALLINT', 'TINYBLOB', 'TINYINT', 'TINYTEXT',
          'VARCHAR', 'YEAR'
        ];
      case 'sqlite':
      default:
        return ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'VARCHAR', 'BOOLEAN', 'DATE', 'TIMESTAMP'];
    }
  };

  const dbTypes = getTypesForDb();



  const applyTypePick = (rowIndex: number, picked: string) => {
    const raw = cols[rowIndex]?.type || '';
    if (picked === CUSTOM_TYPE) {
      const custom = prompt(t('structure.promptCustomType'), raw);
      if (custom !== null && custom.trim()) setColField(rowIndex, 'type', custom.trim());
    } else if (picked.toLowerCase() !== typeBase(raw).toLowerCase()) {
      // A different base type drops the old length on purpose: carrying `255` over from
      // varchar to text would build `text(255)`. Re-picking the same type keeps it.
      setColField(rowIndex, 'type', picked);
    }
    setEditingColCell(null);
  };

  // Table Name state
  const [pendingTableName, setPendingTableName] = useState<string>(tableName);

  // Initialize from schema
  useEffect(() => {
    setPendingTableName(tableName);
    setCols(schema.columns.map(c => ({ ...c })));
    setDeletedColNames([]);
    setEditingColCell(null);

    setIdxs((schema.indexes || []).map(i => ({ ...i })));
    setDeletedIdxNames([]);
    setEditingIdxCell(null);

    setFks((schema.foreignKeys || []).map((f, index) => ({
      name: f.name || `fk_${tableName}_col_${f.column}_${index}`,
      column: f.column,
      refTable: f.refTable,
      refColumn: f.refColumn
    })));
    setDeletedFkNames([]);
    setEditingFkCell(null);

    setDefinitionSql(null);
    setAlterPreview(null);

    if (tableName) {
      dbHelper.getTableTriggers(connId, tableName).then(setTriggers);
      dbHelper.getTablePartitions(connId, tableName).then(setPartitions);
      dbHelper.getCheckConstraints(connId, tableName).then(setConstraints);
    }
  }, [connId, schema, tableName]);

  // Track pending changes
  const hasChanges = () => {
    if (pendingTableName.trim() && pendingTableName.trim() !== tableName) return true;
    if (deletedColNames.length > 0 || deletedIdxNames.length > 0 || deletedFkNames.length > 0) return true;
    if (cols.length !== schema.columns.length) return true;
    if (idxs.length !== (schema.indexes || []).length) return true;
    if (fks.length !== (schema.foreignKeys || []).length) return true;

    // Check columns
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const orig = schema.columns[i];
      if (
        !orig || 
        col.name !== orig.name || 
        col.type.toLowerCase() !== orig.type.toLowerCase() || 
        col.nullable !== orig.nullable || 
        String(col.defaultValue) !== String(orig.defaultValue) ||
        !!col.autoIncrement !== !!orig.autoIncrement ||
        col.comment !== orig.comment ||
        col.isPrimaryKey !== orig.isPrimaryKey
      ) {
        return true;
      }
    }

    // Check indexes
    const origIndexes = schema.indexes || [];
    for (let i = 0; i < idxs.length; i++) {
      const idx = idxs[i];
      const orig = origIndexes[i];
      if (!orig || idx.name !== orig.name || idx.columns !== orig.columns || idx.unique !== orig.unique) {
        return true;
      }
    }

    // Check foreign keys
    const origFks = schema.foreignKeys || [];
    for (let i = 0; i < fks.length; i++) {
      const fk = fks[i];
      const orig = origFks[i];
      if (!orig || fk.column !== orig.column || fk.refTable !== orig.refTable || fk.refColumn !== orig.refColumn) {
        return true;
      }
    }

    return false;
  };

  const handleDiscard = () => {
    setPendingTableName(tableName);
    setCols(schema.columns.map(c => ({ ...c })));
    setDeletedColNames([]);
    setEditingColCell(null);

    setIdxs((schema.indexes || []).map(i => ({ ...i })));
    setDeletedIdxNames([]);
    setEditingIdxCell(null);

    setFks((schema.foreignKeys || []).map((f, index) => ({
      name: f.name || `fk_${tableName}_col_${f.column}_${index}`,
      column: f.column,
      refTable: f.refTable,
      refColumn: f.refColumn
    })));
    setDeletedFkNames([]);
    setEditingFkCell(null);

    setErrorMsg(null);
    setSuccessMsg(t('structure.restored'));
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // -------------------------------------------------------------
  // COLUMNS HANDLERS
  // -------------------------------------------------------------
  const handleAddColumn = () => {
    let baseName = 'new_column';
    let counter = 1;
    while (cols.some(c => c.name === `${baseName}_${counter}`)) {
      counter++;
    }
    const newCol: ColumnInfo = {
      name: `${baseName}_${counter}`,
      type: dbTypes[0],
      nullable: true,
      isPrimaryKey: false,
      defaultValue: null
    };
    const newCols = [...cols, newCol];
    setCols(newCols);
    // The column-name input is opened straight away, as handleAddIndex does — pressing "Add column"
    // and getting a row that just sits there leaves the user unaware they must double-click to edit.
    setTimeout(() => startEditCol(newCols.length - 1, 'name', newCol.name), 50);
  };

  const handleDeleteColumn = (colName: string, isNewColumn: boolean) => {
    setCols(cols.filter(c => c.name !== colName));
    if (!isNewColumn) {
      setDeletedColNames([...deletedColNames, colName]);
    }
  };

  const handleDuplicateColumn = (colIndex: number) => {
    const target = cols[colIndex];
    if (!target) return;
    let newName = `${target.name}_copy`;
    let c = 1;
    while (cols.some(col => col.name === newName)) {
      newName = `${target.name}_copy${c++}`;
    }
    const dup: ColumnInfo = {
      ...target,
      name: newName,
      isPrimaryKey: false,
    };
    setCols([...cols, dup]);
    setContextMenu(null);
  };

  // Cells open on a single click now, so the click that lands INSIDE an already-open
  // editor bubbles up to the cell as well — without this guard it would re-seed the
  // buffer from the stored value and wipe whatever was being typed.
  const startEditCol = (rowIndex: number, field: 'name' | 'type' | 'length' | 'nullable' | 'defaultValue' | 'comment', val: any) => {
    if (editingColCell?.rowIndex === rowIndex && editingColCell?.field === field) return;
    setEditingColCell({ rowIndex, field });
    setEditColValue(val === null ? '' : String(val));
  };

  const saveEditCol = (rowIndex: number, field: 'name' | 'type' | 'length' | 'nullable' | 'defaultValue' | 'comment') => {
    if (!editingColCell) return;
    setCols(prev => prev.map((col, idx) => {
      if (idx === rowIndex) {
        // "length" is not a field of its own — it is the parenthesised part of `type`,
        // put back where the paren was so `int(10) unsigned` keeps its modifier.
        if (field === 'length') {
          const { head, tail } = splitType(col.type);
          return { ...col, type: joinType(head, editColValue, tail) };
        }
        let updatedVal: any = editColValue;
        if (field === 'nullable') {
          updatedVal = editColValue === 'true';
        } else if (field === 'defaultValue') {
          updatedVal = editColValue.trim() === '' ? null : editColValue;
        } else if (field === 'comment') {
          updatedVal = editColValue.trim() === '' ? null : editColValue;
        }
        return { ...col, [field]: updatedVal };
      }
      return col;
    }));
    setEditingColCell(null);
  };

  // Direct writes from the controls that are not double-click-to-edit cells
  // (the PK key icon and the two checkboxes).
  const setColField = (rowIndex: number, field: keyof ColumnInfo, value: any) => {
    setCols(prev => prev.map((col, idx) => (idx === rowIndex ? { ...col, [field]: value } : col)));
  };

  const handleTogglePrimaryKey = (rowIndex: number) => {
    setColField(rowIndex, 'isPrimaryKey', !cols[rowIndex]?.isPrimaryKey);
  };

  // -------------------------------------------------------------
  // INDEXES HANDLERS
  // -------------------------------------------------------------
  const handleAddIndex = () => {
    let baseName = `idx_${tableName}_new`;
    let counter = 1;
    while (idxs.some(i => i.name === `${baseName}_${counter}`)) {
      counter++;
    }
    const newIdx = {
      name: `${baseName}_${counter}`,
      columns: cols[0]?.name || '',
      unique: false
    } as any;
    const newIdxs = [...idxs, newIdx];
    setIdxs(newIdxs);
    // Auto-start editing the name cell of the new row
    setTimeout(() => {
      setEditingIdxCell({ rowIndex: newIdxs.length - 1, field: 'name' });
      setEditIdxValue(newIdx.name);
    }, 50);
  };

  const handleDeleteIndex = (idxName: string, isNewIndex: boolean) => {
    setIdxs(idxs.filter(i => i.name !== idxName));
    if (!isNewIndex) {
      setDeletedIdxNames([...deletedIdxNames, idxName]);
    }
  };

  const startEditIdx = (rowIndex: number, field: 'name' | 'columns' | 'unique', val: any) => {
    // See startEditCol: a click inside the open editor must not restart it.
    if (editingIdxCell?.rowIndex === rowIndex && editingIdxCell?.field === field) return;
    setEditingIdxCell({ rowIndex, field });
    setEditIdxValue(String(val));
  };

  const saveEditIdx = (rowIndex: number, field: 'name' | 'columns' | 'unique') => {
    if (!editingIdxCell) return;
    setIdxs(prev => prev.map((idx, idxVal) => {
      if (idxVal === rowIndex) {
        let updatedVal: any = editIdxValue;
        if (field === 'unique') {
          updatedVal = editIdxValue === 'true';
        }
        return { ...idx, [field]: updatedVal };
      }
      return idx;
    }));
    setEditingIdxCell(null);
  };

  // -------------------------------------------------------------
  // FOREIGN KEYS HANDLERS
  // -------------------------------------------------------------
  const handleAddFK = () => {
    let baseName = `fk_${tableName}_new`;
    let counter = 1;
    while (fks.some(f => f.name === `${baseName}_${counter}`)) {
      counter++;
    }
    setFks([...fks, {
      name: `${baseName}_${counter}`,
      column: cols[0]?.name || '',
      refTable: '',
      refColumn: ''
    }]);
  };

  const handleDeleteFK = (fkName: string, isNewFk: boolean) => {
    setFks(fks.filter(f => f.name !== fkName));
    if (!isNewFk) {
      setDeletedFkNames([...deletedFkNames, fkName]);
    }
  };

  // Fetches a table's columns for the "Referenced column" picker.
  // The old version called getTableSchema(refTable) on EVERY double-click — one round trip to the
  // database each time, and getTableSchema also fetches indexes and foreign keys when only column
  // names are wanted here. Against a remote database, every dropdown meant a wait.
  // It now uses getFullCatalog(): the columns of ALL tables in a few queries, cached — so only the
  // very first time is slow and every table after it is instant.
  const [loadingRefCols, setLoadingRefCols] = useState(false);

  /**
   * Columns of a referenced table, for the foreign-key editor.
   *
   * Reads the shared catalog instead of keeping a private one. This component used to hold its own
   * `catalogRef` — a second copy of exactly what `src/sql/catalog.ts` already caches (same
   * `getFullCatalog` call, same per-table `getTableSchema` fallback) — and that copy went stale in
   * two ways the shared one does not:
   *
   * - it survived a connection switch, so the editor offered columns of the previous database;
   * - it ignored `table-renamed` / `database-restored`, which the shared cache listens to, so it
   *   also offered columns of a table that had just been renamed out from under it.
   *
   * Neither showed an error — only wrong column names. Deleting the duplicate removes both, rather
   * than patching one of them.
   */
  const getColumnsOf = async (table: string): Promise<string[]> => {
    if (!table) return [];
    setLoadingRefCols(true);
    try {
      const info = await catalog.getSchema(connId, table);
      return (info?.columns || []).map(c => c.name);
    } finally {
      setLoadingRefCols(false);
    }
  };
  getColumnsOfRef.current = getColumnsOf;

  const startEditFk = async (rowIndex: number, field: 'name' | 'column' | 'refTable' | 'refColumn' | 'onUpdate' | 'onDelete', val: any) => {
    // See startEditCol: a click inside the open editor must not restart it.
    if (editingFkCell?.rowIndex === rowIndex && editingFkCell?.field === field) return;
    setEditingFkCell({ rowIndex, field });
    setEditFkValue(String(val || ''));

    if (field === 'refColumn') {
      const fkRow = fks[rowIndex];
      setRefColumns(await getColumnsOf(fkRow?.refTable || ''));
    }
  };

  const saveEditFk = async (rowIndex: number, field: 'name' | 'column' | 'refTable' | 'refColumn' | 'onUpdate' | 'onDelete', specificVal?: string) => {
    if (!editingFkCell) return;
    const finalVal = specificVal !== undefined ? specificVal : editFkValue;
    setFks(prev => prev.map((fk, idxVal) => {
      if (idxVal === rowIndex) {
        return { ...fk, [field]: finalVal };
      }
      return fk;
    }));
    setEditingFkCell(null);

    // A referenced table was just picked -> load its columns at once, so the "Referenced column" list
    // is already there when the user opens it, with no wait.
    if (field === 'refTable' && finalVal) {
      void getColumnsOf(finalVal).then(setRefColumns);
    }
  };

  // -------------------------------------------------------------
  // SAVE SCHEMA
  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // SAVE SCHEMA
  // -------------------------------------------------------------
  const buildPayload = () => {
    const added: any[] = [];
    const renamed: any[] = [];
    const modified: any[] = [];
    const dropped = [...deletedColNames];

    const addedIndexes: any[] = [];
    const droppedIndexes = [...deletedIdxNames];

    const addedFKs: any[] = [];
    const droppedFKs: any[] = [];

    const warnings: string[] = [];

    // Columns DDL preparation
    cols.forEach((col, index) => {
      // Match by name first (unchanged or same-name columns)
      // Fall back to positional match only if name not found (user renamed the column)
      const origByName = schema.columns.find(c => c.name === col.name);
      const origByPos = index < schema.columns.length ? schema.columns[index] : undefined;
      const orig = origByName || origByPos;
      const isNew = !origByName && !origByPos;

      if (isNew) {
        added.push({
          name: col.name,
          type: col.type,
          nullable: col.nullable,
          defaultValue: col.defaultValue,
          autoIncrement: col.autoIncrement,
          comment: col.comment
        });
      } else if (orig) {
        if (col.name !== orig.name) {
          renamed.push({ oldName: orig.name, newName: col.name });
        }

        const typeChanged = col.type.toLowerCase() !== orig.type.toLowerCase();
        const nullabilityChanged = col.nullable !== orig.nullable;
        
        const normColDefault = col.defaultValue === null || col.defaultValue === undefined ? null : String(col.defaultValue);
        const normOrigDefault = orig.defaultValue === null || orig.defaultValue === undefined ? null : String(orig.defaultValue);
        const defaultChanged = normColDefault !== normOrigDefault;
        
        const autoIncrementChanged = !!col.autoIncrement !== !!orig.autoIncrement;
        const commentChanged = (col.comment || null) !== (orig.comment || null);

        if (typeChanged || nullabilityChanged || defaultChanged || autoIncrementChanged || commentChanged) {
          if (dbType === 'sqlite' && (typeChanged || nullabilityChanged || autoIncrementChanged || commentChanged)) {
            warnings.push(t('structure.errSqlitePerColumn', { col: col.name }));
          } else {
            modified.push({
              name: col.name,
              type: col.type,
              nullable: col.nullable,
              defaultValue: col.defaultValue,
              autoIncrement: col.autoIncrement,
              comment: col.comment
            });
          }
        }
      }
    });

    // Primary Keys Alteration check
    const origPks = schema.columns.filter(c => c.isPrimaryKey).map(c => c.name).sort();
    const newPks = cols.filter(c => c.isPrimaryKey).map(c => c.name).sort();
    const pkChanged = origPks.join(',') !== newPks.join(',');
    const primaryKeys = pkChanged ? cols.filter(c => c.isPrimaryKey).map(c => c.name) : undefined;

    // Indexes DDL preparation
    const origIndexes = schema.indexes || [];
    idxs.forEach(idx => {
      const orig = origIndexes.find(i => i.name === idx.name);
      const isMethodChanged = orig ? (idx as any).method !== (orig as any).method : false;
      const isTypeChanged = orig ? (idx as any).type !== (orig as any).type : false;

      if (!orig) {
        addedIndexes.push({
          name: idx.name,
          columns: idx.columns,
          unique: idx.unique,
          type: (idx as any).type || (idx.unique ? 'UNIQUE' : 'INDEX'),
          method: (idx as any).method || 'BTREE'
        });
      } else if (idx.columns !== orig.columns || idx.unique !== orig.unique || isMethodChanged || isTypeChanged) {
        // Edit index is simulated by dropping and recreating it
        droppedIndexes.push(orig.name);
        addedIndexes.push({
          name: idx.name,
          columns: idx.columns,
          unique: idx.unique,
          type: (idx as any).type || (idx.unique ? 'UNIQUE' : 'INDEX'),
          method: (idx as any).method || 'BTREE'
        });
      }
    });

    // Foreign Keys DDL preparation
    const origFks = schema.foreignKeys || [];
    fks.forEach(fk => {
      const orig = origFks.find(f => (f.name && f.name === fk.name) || (f.column === fk.column && f.refTable === fk.refTable));
      if (!orig) {
        addedFKs.push({
          column: fk.column,
          refTable: fk.refTable,
          refColumn: fk.refColumn,
          onUpdate: (fk as any).onUpdate || 'NO ACTION',
          onDelete: (fk as any).onDelete || 'NO ACTION'
        });
      } else if (fk.column !== orig.column || fk.refTable !== orig.refTable || fk.refColumn !== orig.refColumn) {
        // Edit FK is simulated by dropping and recreating it
        const origName = orig.name || fk.name;
        droppedFKs.push({ name: origName, column: orig.column });
        addedFKs.push({
          column: fk.column,
          refTable: fk.refTable,
          refColumn: fk.refColumn,
          onUpdate: (fk as any).onUpdate || 'NO ACTION',
          onDelete: (fk as any).onDelete || 'NO ACTION'
        });
      }
    });

    // Process dropped FKs from deletion array
    deletedFkNames.forEach(fkName => {
      const orig = origFks.find((f, idx) => (f.name === fkName) || `fk_${tableName}_col_${f.column}_${idx}` === fkName);
      if (orig) {
        const origName = orig.name || fkName;
        droppedFKs.push({ name: origName, column: orig.column });
      }
    });

    return {
      payload: {
        added, dropped, renamed, modified,
        addedIndexes, droppedIndexes,
        addedFKs, droppedFKs,
        primaryKeys
      },
      warnings
    };
  };

  const handleSaveStructure = async () => {
    if (readOnly) {
      setErrorMsg(t('structure.errReadOnlyAlter'));
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    const isRename = pendingTableName.trim() && pendingTableName.trim() !== tableName;
    const newTableName = pendingTableName.trim();
    const { payload, warnings } = buildPayload();

    if (warnings.length > 0) {
      setErrorMsg(warnings.join('\n'));
      setLoading(false);
      return;
    }

    const hasSchemaChanges = (
      payload.added.length > 0 || payload.dropped.length > 0 || payload.renamed.length > 0 || payload.modified.length > 0 ||
      payload.addedIndexes.length > 0 || payload.droppedIndexes.length > 0 ||
      payload.addedFKs.length > 0 || payload.droppedFKs.length > 0
    );

    if (!hasSchemaChanges && !isRename) {
      setSuccessMsg(t('structure.noChanges'));
      setLoading(false);
      return;
    }

    if (hasSchemaChanges) {
      try {
        const res = await dbHelper.previewAlterTableSchema(connId, tableName, payload);
        if (res.success && res.sqls) {
          let sqls = [...res.sqls];
          if (isRename) {
            sqls.push(`RENAME TABLE \`${tableName}\` TO \`${newTableName}\`;`);
          }
          setPreviewSqls(sqls);
        } else {
          throw new Error(res.error || t('structure.errPreviewFailed'));
        }
      } catch (err: any) {
        setErrorMsg(t('structure.errAlter', { message: err.message }));
      } finally {
        setLoading(false);
      }
    } else if (isRename) {
      setPreviewSqls([`RENAME TABLE \`${tableName}\` TO \`${newTableName}\`;`]);
      setLoading(false);
    }
  };

  const handleExecuteAlter = async () => {
    if (!previewSqls) return;
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    setPreviewSqls(null);

    const isRename = pendingTableName.trim() && pendingTableName.trim() !== tableName;
    const newTableName = pendingTableName.trim();
    const { payload } = buildPayload();

    const hasSchemaChanges = (
      payload.added.length > 0 || payload.dropped.length > 0 || payload.renamed.length > 0 || payload.modified.length > 0 ||
      payload.addedIndexes.length > 0 || payload.droppedIndexes.length > 0 ||
      payload.addedFKs.length > 0 || payload.droppedFKs.length > 0
    );

    try {
      if (hasSchemaChanges) {
        const res = await dbHelper.alterTableSchema(connId, tableName, payload);
        if (!res.success) {
          throw new Error(res.error || t('structure.errUnknown'));
        }
      }

      if (isRename) {
        const renameRes = await dbHelper.renameTable(connId, tableName, newTableName);
        if (!renameRes.success) {
          throw new Error(renameRes.error || t('structure.errRename', { message: '' }));
        }
        window.dispatchEvent(new CustomEvent('table-renamed', { detail: { connId, oldName: tableName, newName: newTableName } }));
      }

      setSuccessMsg(t('structure.alterSuccess'));
      setTimeout(() => setSuccessMsg(null), 3000);
      onSchemaChanged();
    } catch (err: any) {
      setErrorMsg(t('structure.errExecuteSql', { message: err.message }));
    } finally {
      setLoading(false);
    }
  };

  // The DDL pane is both "show me the CREATE TABLE" and a live preview of what Save
  // would run: with pending edits it renders the ALTER statements from the same
  // preview_alter_schema call the confirm dialog uses, so the two can never disagree.
  // Edits are committed on blur, not per keystroke, so this fires once per change.
  useEffect(() => {
    if (section !== 'ddl') return;
    let cancelled = false;

    const load = async () => {
      setDdlLoading(true);
      try {
        if (hasChanges()) {
          const { payload } = buildPayload();
          const res = await dbHelper.previewAlterTableSchema(connId, tableName, payload);
          if (!cancelled) setAlterPreview(res.success && res.sqls ? res.sqls : []);
        } else {
          if (cancelled) return;
          setAlterPreview(null);
          if (definitionSql === null) {
            const res = await dbHelper.getTableDefinition(connId, tableName);
            if (cancelled) return;
            if (res.success && res.sql) setDefinitionSql(res.sql);
            else setErrorMsg(res.error || t('structure.errNoDefinition'));
          }
        }
      } catch {
        if (!cancelled) setErrorMsg(t('structure.errPreviewFailed'));
      } finally {
        if (!cancelled) setDdlLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
    // hasChanges/buildPayload/t are re-created on every render; the real inputs are the
    // edit buffers listed here. definitionSql is read as a cache probe, not tracked —
    // adding it would re-run the effect with the value it just wrote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, tableName, schema, cols, idxs, fks, deletedColNames, deletedIdxNames, deletedFkNames]);

  // Builds the per-dialect dump scripts (used in the DDL pane)
  const q = dbType === 'mysql' ? '`' : '"';
  const dropScript = `DROP TABLE ${q}${tableName}${q};`;
  const truncateScript = dbType === 'sqlite'
    ? `DELETE FROM ${q}${tableName}${q};`
    : `TRUNCATE TABLE ${q}${tableName}${q};`;

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setSuccessMsg(t('structure.copied', { label }));
    setTimeout(() => setSuccessMsg(null), 2500);
  };

  const isOriginalColumn = (colName: string) => schema.columns.some(c => c.name === colName);
  const isOriginalIndex = (idxName: string) => (schema.indexes || []).some(i => i.name === idxName);
  const isOriginalFk = (fkName: string) => (schema.foreignKeys || []).some((f, idx) => (f.name || `fk_${tableName}_col_${f.column}_${idx}`) === fkName);

  const changed = hasChanges();

  const handleAddCheckConstraint = () => {
    let baseName = `chk_${tableName}`;
    let counter = 1;
    while (constraints.some(c => c.name === `${baseName}_${counter}`)) {
      counter++;
    }
    const defaultCol = cols[0]?.name ? (dbType === 'mysql' ? `\`${cols[0].name}\`` : `"${cols[0].name}"`) : '';
    setCheckModalData({
      isNew: true,
      name: `${baseName}_${counter}`,
      expression: defaultCol ? `${defaultCol} > 0` : ''
    });
  };

  const handleEditCheckConstraint = (c: CheckConstraintInfo) => {
    setCheckModalData({
      isNew: false,
      origName: c.name,
      name: c.name,
      expression: c.expression
    });
  };

  const insertIntoCheckExpr = (text: string) => {
    setCheckModalData(prev => {
      if (!prev) return null;
      const current = prev.expression.trim();
      return {
        ...prev,
        expression: current ? `${current} ${text}` : text
      };
    });
  };

  const handleSaveOrUpdateCheck = async () => {
    if (!checkModalData || !checkModalData.expression.trim()) return;
    const isNew = checkModalData.isNew;
    const name = checkModalData.name.trim() || `chk_${tableName}_${Date.now()}`;
    const expr = checkModalData.expression.trim();

    if (isNew) {
      const sql = dbType === 'mysql'
        ? `ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${name}\` CHECK (${expr});`
        : `ALTER TABLE "${tableName}" ADD CONSTRAINT "${name}" CHECK (${expr});`;
      const res = await dbHelper.executeQuery(connId, sql);
      if (res.success) {
        setSuccessMsg('Đã thêm Check Constraint thành công');
        setCheckModalData(null);
        dbHelper.getCheckConstraints(connId, tableName).then(setConstraints);
        setTimeout(() => setSuccessMsg(null), 3000);
      } else {
        setErrorMsg(res.error || 'Lỗi khi thêm Check Constraint');
      }
    } else {
      const origName = checkModalData.origName || name;
      const dropSql = dbType === 'mysql'
        ? `ALTER TABLE \`${tableName}\` DROP CHECK \`${origName}\`;`
        : `ALTER TABLE "${tableName}" DROP CONSTRAINT "${origName}";`;
      const addSql = dbType === 'mysql'
        ? `ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${name}\` CHECK (${expr});`
        : `ALTER TABLE "${tableName}" ADD CONSTRAINT "${name}" CHECK (${expr});`;

      const dropRes = await dbHelper.executeQuery(connId, dropSql);
      if (!dropRes.success) {
        setErrorMsg(dropRes.error || 'Lỗi khi cập nhật Check Constraint (xóa bản cũ)');
        return;
      }
      const addRes = await dbHelper.executeQuery(connId, addSql);
      if (addRes.success) {
        setSuccessMsg(`Đã cập nhật Check Constraint ${name} thành công`);
        setCheckModalData(null);
        dbHelper.getCheckConstraints(connId, tableName).then(setConstraints);
        setTimeout(() => setSuccessMsg(null), 3000);
      } else {
        setErrorMsg(addRes.error || 'Lỗi khi tạo lại Check Constraint');
        dbHelper.getCheckConstraints(connId, tableName).then(setConstraints);
      }
    }
  };

  const doDropCheckConstraint = async (name: string) => {
    const sql = dbType === 'mysql'
      ? `ALTER TABLE ${tableName} DROP CHECK \`${name}\`;`
      : `ALTER TABLE ${tableName} DROP CONSTRAINT "${name}";`;
    const res = await dbHelper.executeQuery(connId, sql);
    if (res.success) {
      setSuccessMsg(`Đã xóa Check constraint ${name}`);
      dbHelper.getCheckConstraints(connId, tableName).then(setConstraints);
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi xóa Check constraint');
    }
  };

  const handleAddTrigger = () => {
    let baseName = `trg_${tableName}`;
    let counter = 1;
    while (triggers.some(tbl => tbl.name === `${baseName}_${counter}`)) {
      counter++;
    }
    setTriggerModalData({
      isNew: true,
      name: `${baseName}_${counter}`,
      timing: 'BEFORE',
      event: 'INSERT',
      body: 'BEGIN\n  -- trigger logic\nEND;'
    });
  };

  const handleEditTrigger = (trg: TriggerInfo) => {
    setTriggerModalData({
      isNew: false,
      origName: trg.name,
      name: trg.name,
      timing: trg.timing,
      event: trg.event,
      body: trg.statement
    });
  };

  const insertIntoTriggerBody = (text: string) => {
    setTriggerModalData(prev => {
      if (!prev) return null;
      const current = prev.body.trim();
      return {
        ...prev,
        body: current ? `${current}\n${text}` : text
      };
    });
  };

  const handleSaveOrUpdateTrigger = async () => {
    if (!triggerModalData || !triggerModalData.name.trim() || !triggerModalData.body.trim()) return;
    const isNew = triggerModalData.isNew;
    const name = triggerModalData.name.trim();
    const timing = triggerModalData.timing;
    const event = triggerModalData.event;
    const body = triggerModalData.body.trim();

    const triggerSql = dbType === 'mysql'
      ? `CREATE TRIGGER \`${name}\` ${timing} ${event} ON \`${tableName}\` FOR EACH ROW ${body}`
      : `CREATE TRIGGER "${name}" ${timing} ${event} ON "${tableName}" FOR EACH ROW ${body};`;

    if (isNew) {
      const res = await dbHelper.saveTrigger(connId, triggerSql);
      if (res.success) {
        setSuccessMsg('Đã thêm Trigger thành công');
        setTriggerModalData(null);
        dbHelper.getTableTriggers(connId, tableName).then(setTriggers);
        setTimeout(() => setSuccessMsg(null), 3000);
      } else {
        setErrorMsg(res.error || 'Lỗi khi tạo Trigger');
      }
    } else {
      const origName = triggerModalData.origName || name;
      const dropRes = await dbHelper.dropTrigger(connId, origName);
      if (!dropRes.success) {
        setErrorMsg(dropRes.error || 'Lỗi khi cập nhật Trigger (xóa bản cũ)');
        return;
      }
      const saveRes = await dbHelper.saveTrigger(connId, triggerSql);
      if (saveRes.success) {
        setSuccessMsg(`Đã cập nhật Trigger ${name} thành công`);
        setTriggerModalData(null);
        dbHelper.getTableTriggers(connId, tableName).then(setTriggers);
        setTimeout(() => setSuccessMsg(null), 3000);
      } else {
        setErrorMsg(saveRes.error || 'Lỗi khi lưu Trigger mới');
        dbHelper.getTableTriggers(connId, tableName).then(setTriggers);
      }
    }
  };

  const doDropTrigger = async (triggerName: string) => {
    const res = await dbHelper.dropTrigger(connId, triggerName);
    if (res.success) {
      setSuccessMsg(`Đã xóa Trigger ${triggerName}`);
      dbHelper.getTableTriggers(connId, tableName).then(setTriggers);
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi xóa Trigger');
    }
  };

  const handleAddPartition = () => {
    setShowAddPartitionModal(true);
  };

  const handleSavePartition = async () => {
    if (!newPartition.name.trim()) return;
    const sql = `ALTER TABLE ${tableName} ADD PARTITION (PARTITION ${newPartition.name.trim()} VALUES ${newPartition.valClause.trim() || 'LESS THAN MAXVALUE'});`;
    const res = await dbHelper.executeQuery(connId, sql);
    if (res.success) {
      setSuccessMsg('Đã thêm Partition thành công');
      setShowAddPartitionModal(false);
      setNewPartition({ name: '', valClause: '' });
      dbHelper.getTablePartitions(connId, tableName).then(setPartitions);
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi thêm Partition');
    }
  };

  const doDropPartition = async (partitionName: string) => {
    const sql = `ALTER TABLE ${tableName} DROP PARTITION ${partitionName};`;
    const res = await dbHelper.executeQuery(connId, sql);
    if (res.success) {
      setSuccessMsg(`Đã xóa Partition ${partitionName}`);
      dbHelper.getTablePartitions(connId, tableName).then(setPartitions);
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi xóa Partition');
    }
  };

  // The three menu entries only open the dialog; the doDrop* above run on confirm.
  const handleDropCheckConstraint = (name: string) => setDropTarget({ kind: 'check', name });
  const handleDropTrigger = (name: string) => setDropTarget({ kind: 'trigger', name });
  const handleDropPartition = (name: string) => setDropTarget({ kind: 'partition', name });

  const confirmDrop = () => {
    if (!dropTarget) return;
    const { kind, name } = dropTarget;
    setDropTarget(null);
    if (kind === 'check') doDropCheckConstraint(name);
    else if (kind === 'trigger') doDropTrigger(name);
    else doDropPartition(name);
  };

  const sections: { id: StructureSection; label: string; count?: number }[] = [
    { id: 'columns', label: t('structure.columnsSection'), count: cols.length },
    { id: 'indexes', label: t('structure.indexesSection'), count: idxs.length },
    { id: 'fks', label: t('structure.fkSection'), count: fks.length },
    { id: 'check_constraints', label: 'Check Constraints', count: constraints.length },
    { id: 'triggers', label: 'Triggers', count: triggers.length },
    { id: 'partitions', label: 'Partitions', count: partitions.length },
    { id: 'ddl', label: t('structure.ddlSection') },
  ];

  // One "Add" button that follows the active pane, instead of three permanent ones.
  const addAction =
    section === 'columns' ? { onClick: handleAddColumn, label: t('structure.addColumn') } :
    section === 'indexes' ? { onClick: handleAddIndex, label: t('structure.addIndex') } :
    section === 'fks' ? { onClick: handleAddFK, label: t('structure.addForeignKey') } :
    section === 'check_constraints' ? { onClick: handleAddCheckConstraint, label: 'Thêm Check Constraint' } :
    section === 'triggers' ? { onClick: handleAddTrigger, label: 'Thêm Trigger' } :
    section === 'partitions' ? { onClick: handleAddPartition, label: 'Thêm Partition' } :
    null;

  const ddlText = changed
    ? (alterPreview || []).map(s => (s.trim().endsWith(';') ? s : `${s};`)).join('\n\n')
    : (definitionSql || '');

  // The filter keeps each row's ORIGINAL index: every edit handler addresses a row by
  // its position in cols/idxs/fks, so mapping over a filtered array would write to the
  // wrong row (and the "#" column would lie about the ordinal).
  const needle = filter.trim().toLowerCase();
  const hit = (...fields: (string | null | undefined)[]) =>
    !needle || fields.some(f => (f || '').toLowerCase().includes(needle));

  const visibleCols = cols
    .map((col, index) => ({ col, index }))
    .filter(({ col }) => hit(col.name, col.type, col.comment, col.defaultValue == null ? null : String(col.defaultValue)));

  const visibleIdxs = idxs
    .map((idx, index) => ({ idx, index }))
    .filter(({ idx }) => hit(idx.name, idx.columns, (idx as any).type));

  const visibleFks = fks
    .map((fk, index) => ({ fk, index }))
    .filter(({ fk }) => hit(fk.name, fk.column, fk.refTable, fk.refColumn));

  return (
    // padding/gap 0: .structure-view-container's own 24px inset pushed the toolbar off
    // the edges, so its bottom border stopped short of the pane on both sides.
    <div className="structure-view-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', padding: 0, gap: 0 }}>
      {/* Header Toolbar */}
      <div className="sql-toolbar st-toolbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'nowrap', flexShrink: 0 }}>
          <div className="st-table-name-wrapper" title="Table Name">
            <Table2 size={13} className="st-table-icon" />
            <span className="st-toolbar-label">{t('structure.tableNameLabel')}</span>
            <input
              type="text"
              className="st-tablename-input"
              value={pendingTableName}
              onChange={(e) => setPendingTableName(e.target.value)}
              placeholder={tableName}
              title={t('structure.tableNameLabel')}
            />
          </div>
          <div className="st-pk-summary-badge" title="Primary key columns">
            <Key size={11} className="st-pk-badge-icon" />
            <span className="st-pk-badge-label">Primary:</span>
            <span className="st-pk-badge-val">{cols.filter(c => c.isPrimaryKey).map(c => c.name).join(', ') || 'none'}</span>
          </div>
          <div className="st-divider" />

          {!activeSection && (
            <div className="segmented-control">
              {sections.map(s => (
                <button
                  key={s.id}
                  className={`segment-btn${section === s.id ? ' active' : ''}`}
                  onClick={() => { setSection(s.id); setFilter(''); }}
                >
                  {s.label}
                  {s.count !== undefined && <span className="st-seg-count">{s.count}</span>}
                </button>
              ))}
            </div>
          )}

          {section !== 'ddl' && (
            <div className="st-filter">
              <Search size={12} style={{ opacity: 0.7 }} />
              <input
                type="text"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                onKeyDown={e => e.key === 'Escape' && setFilter('')}
                placeholder={t('structure.filterPlaceholder')}
              />
              {filter && (
                <button type="button" onClick={() => setFilter('')} title={t('structure.filterClear')}>
                  <X size={11} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Action buttons aligned right */}
        <div style={{ display: 'flex', gap: '5px', alignItems: 'center', flexWrap: 'nowrap', flexShrink: 0, marginLeft: 'auto' }}>
          {changed && (
            <span className="st-dirty" style={{ fontSize: '11px', padding: '2px 6px', whiteSpace: 'nowrap' }}>
              <span className="st-dirty-dot" />
              {t('structure.unsavedChanges')}
            </span>
          )}
          {addAction && (
            <button
              className="btn btn-secondary"
              onClick={addAction.onClick}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', borderRadius: '5px', height: '26px', padding: '0 8px', fontSize: '11px', whiteSpace: 'nowrap' }}
            >
              <Plus size={12} />
              <span>{addAction.label}</span>
            </button>
          )}
          <button
            className="btn btn-secondary"
            onClick={handleDiscard}
            disabled={loading || !changed}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', borderRadius: '5px', height: '26px', padding: '0 8px', fontSize: '11px', whiteSpace: 'nowrap' }}
          >
            <RotateCcw size={12} />
            <span>{t('structure.discard')}</span>
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSaveStructure}
            disabled={loading || !changed}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              borderRadius: '5px',
              height: '26px',
              padding: '0 10px',
              fontSize: '11px',
              whiteSpace: 'nowrap',
              background: 'var(--st-ok, #10b981)',
              borderColor: 'var(--st-ok, #10b981)',
              boxShadow: changed ? '0 2px 6px rgba(16, 185, 129, 0.3)' : 'none'
            }}
          >
            <Save size={13} />
            <span>{loading ? t('structure.saving') : t('structure.saveStructure')}</span>
          </button>
        </div>
      </div>

      {/* Messages */}
      {successMsg && (
        <div className="info-bar" style={{ background: 'rgba(16, 185, 129, 0.1)', borderLeftColor: 'var(--st-ok)', margin: '8px 12px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={16} style={{ color: 'var(--st-ok)' }} />
            <span>{successMsg}</span>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="info-bar" style={{ background: 'rgba(239, 68, 68, 0.1)', borderLeftColor: 'var(--st-danger)', margin: '8px 12px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={16} style={{ color: 'var(--st-danger)' }} />
            <span style={{ whiteSpace: 'pre-line' }}>{errorMsg}</span>
          </div>
        </div>
      )}

      {/* Active pane — grid panes run edge to edge under a sticky header, like the
          Data tab; only the DDL pane is inset (see .st-pane in index.css). */}
      <div className={`st-pane${section === 'ddl' ? ' st-pane-ddl' : ''}`}>

        {/* COLUMNS */}
        {section === 'columns' && (
          <>
            <table className="structure-table">
              <thead>
                <tr>
                  <th style={{ width: '56px', textAlign: 'center' }} title={t('structure.togglePk')}>#</th>
                  <th style={{ minWidth: '150px', whiteSpace: 'nowrap' }}>{t('structure.colName')}</th>
                  <th style={{ minWidth: '160px', whiteSpace: 'nowrap' }}>data_type</th>
                  <th style={{ minWidth: '130px', whiteSpace: 'nowrap' }}>character_set</th>
                  <th style={{ minWidth: '180px', whiteSpace: 'nowrap' }}>collation</th>
                  <th style={{ width: '56px', textAlign: 'center' }} title={t('structure.colNullable')}>{t('structure.colNullShort')}</th>
                  <th style={{ width: '76px', textAlign: 'center' }} title={t('structure.colAutoIncrement')}>{t('structure.colAutoIncShort')}</th>
                  <th style={{ minWidth: '160px', whiteSpace: 'nowrap' }}>{t('structure.colDefault')}</th>
                  <th style={{ minWidth: '220px', whiteSpace: 'nowrap' }}>extra</th>
                  <th style={{ minWidth: '150px', whiteSpace: 'nowrap' }}>foreign_key</th>
                  <th style={{ minWidth: '120px', whiteSpace: 'nowrap' }}>{t('structure.colComment')}</th>
                  <th style={{ width: '40px', textAlign: 'center' }} aria-label={t('structure.colActions')} />
                </tr>
              </thead>
              <tbody>
                {visibleCols.map(({ col, index }) => {
                  const isNew = !isOriginalColumn(col.name);
                  const isEditing = editingColCell?.rowIndex === index;

                  return (
                    <tr
                      key={col.name + '_' + index}
                      className={isNew ? 'structure-row-new' : ''}
                      onContextMenu={(e) => handleRowContextMenu(e, 'column', index, col.name)}
                    >
                      {/* Ordinal + primary key toggle */}
                      <td className="st-gutter">
                        <span className="st-ord">{index + 1}</span>
                        <button
                          type="button"
                          className={`st-pk-btn${col.isPrimaryKey ? ' on' : ''}`}
                          onClick={() => handleTogglePrimaryKey(index)}
                          title={t('structure.togglePk')}
                        >
                          <Key size={12} />
                        </button>
                      </td>

                      {/* Column Name */}
                      <td
                        className={`st-edit ${isEditing && editingColCell?.field === 'name' ? 'is-editing' : ''}`}
                        onClick={() => startEditCol(index, 'name', col.name)}
                        title={t('structure.editHint')}
                        style={{ fontWeight: 600, color: 'var(--win-text-primary)', whiteSpace: 'nowrap', position: 'relative' }}
                      >
                        {isEditing && editingColCell?.field === 'name' ? (
                          <>
                            <span className="st-cell-ghost">{col.name}</span>
                            <input
                              type="text"
                              className="form-input st-cell-input st-cell-input-overlay"
                              value={editColValue}
                              onChange={e => setEditColValue(e.target.value)}
                              onBlur={() => saveEditCol(index, 'name')}
                              onKeyDown={e => e.key === 'Enter' && saveEditCol(index, 'name')}
                              onClick={e => e.stopPropagation()}
                              ref={el => { if (el) { el.focus(); el.select(); } }}
                            />
                          </>
                        ) : (
                          <span>{col.name}</span>
                        )}
                      </td>

                      {/* Data Type — Direct select showing full data_type */}
                      <td>
                        <select
                          className="st-select st-select-type"
                          value={col.type}
                          onChange={e => applyTypePick(index, e.target.value)}
                        >
                          {!dbTypes.includes(col.type) && (
                            <option value={col.type}>{col.type}</option>
                          )}
                          {dbTypes.map(ty => (
                            <option key={ty} value={ty}>{ty}</option>
                          ))}
                          <option value={CUSTOM_TYPE}>{t('structure.optTypeCustom')}</option>
                        </select>
                      </td>

                      {/* character_set */}
                      <td style={{ whiteSpace: 'nowrap', fontFamily: 'var(--win-font-mono)', fontSize: '12px' }}>
                        {col.characterSet ? (
                          <span>{col.characterSet}</span>
                        ) : (
                          <span className="st-empty-dash" style={{ fontStyle: 'normal' }}>NULL</span>
                        )}
                      </td>

                      {/* collation */}
                      <td style={{ whiteSpace: 'nowrap', fontFamily: 'var(--win-font-mono)', fontSize: '12px' }}>
                        {col.collation ? (
                          <span>{col.collation}</span>
                        ) : (
                          <span className="st-empty-dash" style={{ fontStyle: 'normal' }}>NULL</span>
                        )}
                      </td>

                      {/* Nullable */}
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          className="st-check"
                          checked={!!col.nullable}
                          onChange={e => setColField(index, 'nullable', e.target.checked)}
                          title={t('structure.toggleNullable')}
                        />
                      </td>

                      {/* Auto increment */}
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          className="st-check"
                          checked={!!col.autoIncrement}
                          onChange={e => setColField(index, 'autoIncrement', e.target.checked)}
                          title={t('structure.toggleAutoIncrement')}
                        />
                      </td>

                      {/* Default Value — Direct 1-click select */}
                      <td>
                        <select
                          className={`st-select st-select-default ${col.defaultValue === null ? 'is-null' : ''}`}
                          value={col.defaultValue === null ? 'NULL' : String(col.defaultValue)}
                          onChange={e => {
                            const val = e.target.value;
                            if (val === 'NULL') {
                              setColField(index, 'defaultValue', null);
                            } else if (val === 'CUSTOM') {
                              const customVal = prompt(t('structure.promptCustomDefault'), '');
                              if (customVal !== null) {
                                setColField(index, 'defaultValue', customVal);
                              }
                            } else {
                              setColField(index, 'defaultValue', val);
                            }
                          }}
                        >
                          <option value="NULL">{t('structure.optDefaultNull')}</option>
                          <option value="CURRENT_TIMESTAMP">{t('structure.optDefaultNow')}</option>
                          <option value="''">{t('structure.optDefaultEmptyString')}</option>
                          <option value="0">{t('structure.optDefaultZero')}</option>
                          <option value="false">{t('structure.optDefaultFalse')}</option>
                          <option value="true">{t('structure.optDefaultTrue')}</option>
                          {col.defaultValue !== null && !['CURRENT_TIMESTAMP', "''", '0', 'false', 'true'].includes(String(col.defaultValue)) && (
                            <option value={String(col.defaultValue)}>{String(col.defaultValue)}</option>
                          )}
                          <option value="CUSTOM">{t('structure.optDefaultCustom')}</option>
                        </select>
                      </td>

                      {/* extra */}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {col.extra ? (
                          <span className="st-badge-extra">{col.extra}</span>
                        ) : col.autoIncrement ? (
                          <span className="st-badge-extra">auto_increment</span>
                        ) : (
                          <span className="st-empty-dash">-</span>
                        )}
                      </td>

                      {/* foreign_key */}
                      {(() => {
                        const matchingFk = fks.find(f => f.column === col.name);
                        return (
                          <td
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setFkPopoverCol(col.name);
                              const topPos = Math.min(window.innerHeight - 100, rect.bottom + 2);
                              setFkPopoverPos({ top: topPos, left: Math.max(8, rect.left) });
                            }}
                            title="Click to view/manage Foreign Key"
                          >
                            {matchingFk ? (
                              <div className="st-fk-chip active">
                                <span>{`${matchingFk.refTable}(${matchingFk.refColumn})`}</span>
                                <ArrowRight size={11} className="st-fk-arrow" />
                              </div>
                            ) : (
                              <div className="st-fk-chip empty">
                                <span className="st-empty-dash">-</span>
                              </div>
                            )}
                          </td>
                        );
                      })()}

                      {/* Comment */}
                      <td
                        className={`st-edit ${isEditing && editingColCell?.field === 'comment' ? 'is-editing' : ''}`}
                        onClick={() => startEditCol(index, 'comment', col.comment)}
                        style={{ color: 'var(--win-text-secondary)', position: 'relative' }}
                        title={t('structure.commentHint')}
                      >
                        {isEditing && editingColCell?.field === 'comment' ? (
                          <>
                            <span className="st-cell-ghost">{col.comment || '-'}</span>
                            <input
                              type="text"
                              className="form-input st-cell-input st-cell-input-overlay"
                              value={editColValue}
                              onChange={e => setEditColValue(e.target.value)}
                              onBlur={() => saveEditCol(index, 'comment')}
                              onKeyDown={e => e.key === 'Enter' && saveEditCol(index, 'comment')}
                              onClick={e => e.stopPropagation()}
                              autoFocus
                              placeholder={t('structure.commentPlaceholder')}
                            />
                          </>
                        ) : (
                          col.comment ? (
                            <span>{col.comment}</span>
                          ) : (
                            <span className="st-empty-dash">-</span>
                          )
                        )}
                      </td>

                      {/* Delete Column Action */}
                      <td style={{ textAlign: 'center' }}>
                        <button
                          className="st-row-del"
                          onClick={() => handleDeleteColumn(col.name, isNew)}
                          disabled={col.isPrimaryKey}
                          title={col.isPrimaryKey ? t('structure.cannotDropPk') : t('structure.dropColumn')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {visibleCols.length === 0 && (
                  <tr><td colSpan={11} className="st-empty">
                    {cols.length === 0 ? t('structure.noColumns') : t('structure.filterNoMatch')}
                  </td></tr>
                )}
              </tbody>
            </table>
          </>
        )}

        {/* INDEXES */}
        {section === 'indexes' && (
          <table className="structure-table">
            <thead>
              <tr>
                <th style={{ minWidth: '180px', whiteSpace: 'nowrap' }}>{t('structure.idxName')}</th>
                <th style={{ minWidth: '200px', whiteSpace: 'nowrap' }}>{t('structure.idxColumns')}</th>
                <th style={{ minWidth: '140px', whiteSpace: 'nowrap' }}>{t('structure.idxType')}</th>
                <th style={{ width: '36px' }} aria-label={t('structure.colActions')} />
              </tr>
            </thead>
            <tbody>
              {visibleIdxs.map(({ idx, index }) => {
                const isNew = !isOriginalIndex(idx.name);
                const isEditing = editingIdxCell?.rowIndex === index;
                // Add default type/method properties if missing
                const idxType = (idx as any).type || (idx.unique ? 'UNIQUE' : 'INDEX');

                return (
                  <tr
                    key={idx.name + '_' + index}
                    className={isNew ? 'structure-row-new' : ''}
                    onDoubleClick={() => {
                      if (idx.name === 'PRIMARY') return;
                      const colList = idx.columns ? idx.columns.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
                      setIdxModalData({
                        index,
                        name: idx.name,
                        origName: idx.name,
                        columns: colList.length > 0 ? colList : (cols[0]?.name ? [cols[0].name] : []),
                        type: idxType,
                        isNew
                      });
                    }}
                    onContextMenu={(e) => handleRowContextMenu(e, 'index', index, idx.name)}
                    style={{ cursor: idx.name === 'PRIMARY' ? 'default' : 'pointer' }}
                    title={idx.name === 'PRIMARY' ? undefined : "Nhấp đúp hoặc bấm biểu tượng bút để chỉnh sửa Index"}
                  >
                    {/* Index Name */}
                    <td
                      className={`st-edit ${isEditing && editingIdxCell?.field === 'name' ? 'is-editing' : ''}`}
                      onClick={() => startEditIdx(index, 'name', idx.name)}
                      title={t('structure.editHint')}
                      style={{ fontWeight: 600, color: idxType === 'PRIMARY' ? '#f59e0b' : 'var(--st-warn)', position: 'relative' }}
                    >
                      {isEditing && editingIdxCell?.field === 'name' ? (
                        <>
                          <span className="st-cell-ghost">{idx.name}</span>
                          <input
                            type="text"
                            className="form-input st-cell-input st-cell-input-overlay"
                            value={editIdxValue}
                            onChange={e => setEditIdxValue(e.target.value)}
                            onBlur={() => saveEditIdx(index, 'name')}
                            onKeyDown={e => e.key === 'Enter' && saveEditIdx(index, 'name')}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          />
                        </>
                      ) : (
                        <span>{idx.name}</span>
                      )}
                    </td>

                    {/* Target Columns */}
                    <td
                      className={`st-edit st-edit-select ${isEditing && editingIdxCell?.field === 'columns' ? 'is-editing' : ''}`}
                      onClick={() => startEditIdx(index, 'columns', idx.columns)}
                      title={t('structure.editHint')}
                      style={{ fontFamily: 'var(--win-font-mono)', position: 'relative' }}
                    >
                      {isEditing && editingIdxCell?.field === 'columns' ? (
                        <>
                          <span className="st-cell-ghost">{idx.columns}</span>
                          <select
                            className="st-select st-select-type st-select-overlay"
                            value={editIdxValue}
                            onChange={e => {
                              const val = e.target.value;
                              setEditIdxValue(val);
                              setIdxs(prev => prev.map((item, i) => i === index ? { ...item, columns: val } : item));
                              setEditingIdxCell(null);
                            }}
                            onBlur={() => saveEditIdx(index, 'columns')}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          >
                            {cols.map(c => (
                              <option key={c.name} value={c.name}>{c.name}</option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <span>{idx.columns}</span>
                      )}
                    </td>

                    {/* Index Type */}
                    <td
                      className={`st-edit st-edit-select ${isEditing && editingIdxCell?.field === 'unique' ? 'is-editing' : ''}`}
                      onClick={() => idxType !== 'PRIMARY' && startEditIdx(index, 'unique', idxType)}
                      title={t('structure.editHint')}
                      style={{ position: 'relative' }}
                    >
                      {isEditing && editingIdxCell?.field === 'unique' ? (
                        <>
                          <span className="st-cell-ghost">{idxType}</span>
                          <select
                            className="st-select st-select-type st-select-overlay"
                            value={editIdxValue}
                            onChange={e => {
                              const val = e.target.value;
                              setEditIdxValue(val);
                              setIdxs(prev => prev.map((item, i) => i === index ? { ...item, unique: val === 'UNIQUE', type: val } as any : item));
                              setEditingIdxCell(null);
                            }}
                            onBlur={() => setEditingIdxCell(null)}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          >
                            <option value="INDEX">{t('structure.optIndexPlain')}</option>
                            <option value="UNIQUE">{t('structure.optIndexUnique')}</option>
                            {dbType === 'mysql' && <option value="FULLTEXT">FULLTEXT</option>}
                            {dbType === 'mysql' && <option value="SPATIAL">SPATIAL</option>}
                          </select>
                        </>
                      ) : (
                        <span
                          className="badge-pk"
                          style={{
                            background: idxType === 'PRIMARY' ? 'rgba(245, 158, 11, 0.15)' : idxType === 'UNIQUE' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                            color: idxType === 'PRIMARY' ? '#f59e0b' : idxType === 'UNIQUE' ? '#10b981' : 'var(--win-accent)',
                            borderColor: idxType === 'PRIMARY' ? 'rgba(245, 158, 11, 0.3)' : idxType === 'UNIQUE' ? 'rgba(16, 185, 129, 0.25)' : 'rgba(59, 130, 246, 0.25)'
                          }}
                        >
                          {idxType}
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <button
                          className="st-row-edit"
                          onClick={(e) => {
                            e.stopPropagation();
                            const colList = idx.columns ? idx.columns.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
                            setIdxModalData({
                              index,
                              name: idx.name,
                              origName: idx.name,
                              columns: colList.length > 0 ? colList : (cols[0]?.name ? [cols[0].name] : []),
                              type: idxType,
                              isNew
                            });
                          }}
                          disabled={idx.name === 'PRIMARY'}
                          title={idx.name === 'PRIMARY' ? 'Primary Key không thể sửa dạng index thường' : "Chỉnh sửa Index"}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="st-row-del"
                          onClick={() => handleDeleteIndex(idx.name, isNew)}
                          disabled={idx.name === 'PRIMARY'}
                          title={idx.name === 'PRIMARY' ? 'Cannot drop primary key index' : t('structure.dropIndex')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {visibleIdxs.length === 0 && (
                <tr><td colSpan={4} className="st-empty">
                  {idxs.length === 0 ? t('structure.noIndexes') : t('structure.filterNoMatch')}
                </td></tr>
              )}
            </tbody>
          </table>
        )}

        {/* FOREIGN KEYS */}
        {section === 'fks' && (
          <table className="structure-table">
            <thead>
              <tr>
                <th style={{ minWidth: '160px', whiteSpace: 'nowrap' }}>{t('structure.fkName')}</th>
                <th style={{ minWidth: '150px', whiteSpace: 'nowrap' }}>{t('structure.fkColumn')}</th>
                <th style={{ minWidth: '160px', whiteSpace: 'nowrap' }}>{t('structure.fkRefTable')}</th>
                <th style={{ minWidth: '150px', whiteSpace: 'nowrap' }}>{t('structure.fkRefColumn')}</th>
                <th style={{ minWidth: '120px', whiteSpace: 'nowrap' }}>On Update</th>
                <th style={{ minWidth: '120px', whiteSpace: 'nowrap' }}>On Delete</th>
                <th style={{ width: '36px' }} aria-label={t('structure.colActions')} />
              </tr>
            </thead>
            <tbody>
              {visibleFks.map(({ fk, index }) => {
                const isNew = !isOriginalFk(fk.name);
                const isEditing = editingFkCell?.rowIndex === index;
                // Default actions if missing
                const onUpdateAct = (fk as any).onUpdate || 'NO ACTION';
                const onDeleteAct = (fk as any).onDelete || 'NO ACTION';

                return (
                  <tr
                    key={fk.name + '_' + index}
                    className={isNew ? 'structure-row-new' : ''}
                    onDoubleClick={() => {
                      setFkModalData({
                        name: fk.name,
                        origName: fk.name,
                        column: fk.column,
                        refTable: fk.refTable,
                        refColumn: fk.refColumn,
                        onUpdate: (fk as any).onUpdate || 'NO ACTION',
                        onDelete: (fk as any).onDelete || 'NO ACTION',
                        isNew: false
                      });
                    }}
                    onContextMenu={(e) => handleRowContextMenu(e, 'fk', index, fk.name)}
                    style={{ cursor: 'pointer' }}
                    title="Nhấp đúp hoặc bấm biểu tượng bút để mở hộp thoại Foreign Key"
                  >
                    {/* FK Name */}
                    <td
                      className={`st-edit ${isEditing && editingFkCell?.field === 'name' ? 'is-editing' : ''}`}
                      onClick={() => startEditFk(index, 'name', fk.name)}
                      title={t('structure.editHint')}
                      style={{ fontWeight: 600, color: 'var(--win-text-primary)', position: 'relative' }}
                    >
                      {isEditing && editingFkCell?.field === 'name' ? (
                        <>
                          <span className="st-cell-ghost">{fk.name}</span>
                          <input
                            type="text"
                            className="form-input st-cell-input st-cell-input-overlay"
                            value={editFkValue}
                            onChange={e => setEditFkValue(e.target.value)}
                            onBlur={() => saveEditFk(index, 'name')}
                            onKeyDown={e => e.key === 'Enter' && saveEditFk(index, 'name')}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          />
                        </>
                      ) : (
                        <span>{fk.name}</span>
                      )}
                    </td>

                    {/* Local Source Column */}
                    <td
                      className={`st-edit st-edit-select ${isEditing && editingFkCell?.field === 'column' ? 'is-editing' : ''}`}
                      onClick={() => startEditFk(index, 'column', fk.column)}
                      title={t('structure.editHint')}
                      style={{ fontWeight: 600, position: 'relative' }}
                    >
                      {isEditing && editingFkCell?.field === 'column' ? (
                        <>
                          <span className="st-cell-ghost">{fk.column}</span>
                          <select
                            className="st-select st-select-type st-select-overlay"
                            value={editFkValue}
                            onChange={e => {
                              const val = e.target.value;
                              setEditFkValue(val);
                              saveEditFk(index, 'column', val);
                            }}
                            onBlur={() => saveEditFk(index, 'column')}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          >
                            {cols.map(c => (
                              <option key={c.name} value={c.name}>{c.name}</option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <span>{fk.column}</span>
                      )}
                    </td>

                    {/* Referenced Table */}
                    <td
                      className={`st-edit st-edit-select ${isEditing && editingFkCell?.field === 'refTable' ? 'is-editing' : ''}`}
                      onClick={() => startEditFk(index, 'refTable', fk.refTable)}
                      title={t('structure.editHint')}
                      style={{ color: 'var(--win-accent)', fontWeight: 600, position: 'relative' }}
                    >
                      {isEditing && editingFkCell?.field === 'refTable' ? (
                        <>
                          <span className="st-cell-ghost">{fk.refTable || t('structure.fkNotSet')}</span>
                          <select
                            className="st-select st-select-type st-select-overlay"
                            value={editFkValue}
                            onChange={e => {
                              const val = e.target.value;
                              setEditFkValue(val);
                              saveEditFk(index, 'refTable', val);
                            }}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          >
                            <option value="">{t('structure.selectTable')}</option>
                            {allTables.map(tblName => (
                              <option key={tblName} value={tblName}>{tblName}</option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <span>{fk.refTable || <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>{t('structure.fkNotSet')}</span>}</span>
                      )}
                    </td>

                    {/* Referenced Column */}
                    <td
                      className={`st-edit st-edit-select ${isEditing && editingFkCell?.field === 'refColumn' ? 'is-editing' : ''}`}
                      onClick={() => startEditFk(index, 'refColumn', fk.refColumn)}
                      title={t('structure.editHint')}
                      style={{ fontFamily: 'var(--win-font-mono)', position: 'relative' }}
                    >
                      {isEditing && editingFkCell?.field === 'refColumn' ? (
                        <>
                          <span className="st-cell-ghost">{fk.refColumn || t('structure.fkNotSet')}</span>
                          <select
                            className="st-select st-select-type st-select-overlay"
                            value={editFkValue}
                            onChange={e => {
                              const val = e.target.value;
                              setEditFkValue(val);
                              saveEditFk(index, 'refColumn', val);
                            }}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          >
                            <option value="">{loadingRefCols ? t('structure.loadingColumns') : t('structure.selectColumn')}</option>
                            {refColumns.map(colName => (
                              <option key={colName} value={colName}>{colName}</option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <span>{fk.refColumn || <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>{t('structure.fkNotSet')}</span>}</span>
                      )}
                    </td>

                    {/* On Update Action */}
                    <td
                      className={`st-edit st-edit-select ${isEditing && editingFkCell?.field === ('onUpdate' as any) ? 'is-editing' : ''}`}
                      onClick={() => startEditFk(index, 'onUpdate' as any, onUpdateAct)}
                      title={t('structure.editHint')}
                      style={{ fontSize: '11px', position: 'relative' }}
                    >
                      {isEditing && editingFkCell?.field === ('onUpdate' as any) ? (
                        <>
                          <span className="st-cell-ghost">{onUpdateAct}</span>
                          <select
                            className="st-select st-select-type st-select-overlay"
                            value={editFkValue}
                            onChange={e => {
                              const val = e.target.value;
                              setEditFkValue(val);
                              setFks(prev => prev.map((item, i) => i === index ? { ...item, onUpdate: val } as any : item));
                              setEditingFkCell(null);
                            }}
                            onBlur={() => setEditingFkCell(null)}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          >
                            <option value="NO ACTION">NO ACTION</option>
                            <option value="RESTRICT">RESTRICT</option>
                            <option value="CASCADE">CASCADE</option>
                            <option value="SET NULL">SET NULL</option>
                            <option value="SET DEFAULT">SET DEFAULT</option>
                          </select>
                        </>
                      ) : (
                        <span style={{ color: onUpdateAct === 'CASCADE' ? '#10b981' : 'var(--win-text-secondary)' }}>{onUpdateAct}</span>
                      )}
                    </td>

                    {/* On Delete Action */}
                    <td
                      className={`st-edit st-edit-select ${isEditing && editingFkCell?.field === ('onDelete' as any) ? 'is-editing' : ''}`}
                      onClick={() => startEditFk(index, 'onDelete' as any, onDeleteAct)}
                      title={t('structure.editHint')}
                      style={{ fontSize: '11px', position: 'relative' }}
                    >
                      {isEditing && editingFkCell?.field === ('onDelete' as any) ? (
                        <>
                          <span className="st-cell-ghost">{onDeleteAct}</span>
                          <select
                            className="st-select st-select-type st-select-overlay"
                            value={editFkValue}
                            onChange={e => {
                              const val = e.target.value;
                              setEditFkValue(val);
                              setFks(prev => prev.map((item, i) => i === index ? { ...item, onDelete: val } as any : item));
                              setEditingFkCell(null);
                            }}
                            onBlur={() => setEditingFkCell(null)}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          >
                            <option value="NO ACTION">NO ACTION</option>
                            <option value="RESTRICT">RESTRICT</option>
                            <option value="CASCADE">CASCADE</option>
                            <option value="SET NULL">SET NULL</option>
                            <option value="SET DEFAULT">SET DEFAULT</option>
                          </select>
                        </>
                      ) : (
                        <span style={{ color: onDeleteAct === 'CASCADE' ? '#ef4444' : 'var(--win-text-secondary)' }}>{onDeleteAct}</span>
                      )}
                    </td>

                    {/* Actions */}
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <button
                          className="st-row-edit"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFkModalData({
                              name: fk.name,
                              origName: fk.name,
                              column: fk.column,
                              refTable: fk.refTable,
                              refColumn: fk.refColumn,
                              onUpdate: (fk as any).onUpdate || 'NO ACTION',
                              onDelete: (fk as any).onDelete || 'NO ACTION',
                              isNew: false
                            });
                          }}
                          title="Chỉnh sửa Khóa ngoại"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="st-row-del"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteFK(fk.name, isNew);
                          }}
                          title={t('structure.dropFk')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {visibleFks.length === 0 && (
                <tr><td colSpan={7} className="st-empty">
                  {fks.length === 0 ? t('structure.noForeignKeys') : t('structure.filterNoMatch')}
                </td></tr>
              )}
            </tbody>
          </table>
        )}

        {section === 'check_constraints' && (
          <table className="structure-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}>#</th>
                <th>Tên Constraint</th>
                <th>Biểu thức Check</th>
                <th style={{ width: '100px' }}>Thực thi</th>
                <th style={{ width: '80px', textAlign: 'center' }}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {constraints.map((c, idx) => (
                <tr
                  key={c.name || idx}
                  onDoubleClick={() => handleEditCheckConstraint(c)}
                  style={{ cursor: 'pointer' }}
                  title="Nhấp đúp hoặc bấm biểu tượng bút để chỉnh sửa Check Constraint"
                >
                  <td style={{ textAlign: 'center', color: 'var(--win-text-disabled)' }}>{idx + 1}</td>
                  <td style={{ fontWeight: 600, color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{c.name}</td>
                  <td style={{ fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)' }}>{c.expression}</td>
                  <td><span className={`st-badge ${c.enforced ? 'st-badge-enforced' : 'st-badge-warn'}`}>{c.enforced ? 'ENFORCED' : 'DISABLED'}</span></td>
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <button
                        className="st-row-edit"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditCheckConstraint(c);
                        }}
                        title="Chỉnh sửa Check Constraint"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="st-row-del"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDropCheckConstraint(c.name);
                        }}
                        title="Xóa Check Constraint"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {constraints.length === 0 && (
                <tr><td colSpan={5} className="st-empty">Không có Check Constraint nào cho bảng này.</td></tr>
              )}
            </tbody>
          </table>
        )}

        {section === 'triggers' && (
          <table className="structure-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}>#</th>
                <th>Tên Trigger</th>
                <th style={{ width: '100px' }}>Thời điểm</th>
                <th style={{ width: '100px' }}>Sự kiện</th>
                <th>Nội dung Trigger Body</th>
                <th style={{ width: '80px', textAlign: 'center' }}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((trg, idx) => (
                <tr
                  key={trg.name || idx}
                  onDoubleClick={() => handleEditTrigger(trg)}
                  style={{ cursor: 'pointer' }}
                  title="Nhấp đúp hoặc bấm biểu tượng bút để chỉnh sửa Trigger"
                >
                  <td style={{ textAlign: 'center', color: 'var(--win-text-disabled)' }}>{idx + 1}</td>
                  <td style={{ fontWeight: 600, color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{trg.name}</td>
                  <td><span style={{ fontWeight: 600, color: '#60a5fa' }}>{trg.timing}</span></td>
                  <td><span style={{ fontWeight: 600, color: '#f59e0b' }}>{trg.event}</span></td>
                  <td style={{ fontFamily: 'var(--win-font-mono)', fontSize: '11px', whiteSpace: 'pre-wrap', color: 'var(--win-text-primary)' }}>{trg.statement}</td>
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <button
                        className="st-row-edit"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditTrigger(trg);
                        }}
                        title="Chỉnh sửa Trigger"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="st-row-del"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDropTrigger(trg.name);
                        }}
                        title="Xóa Trigger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {triggers.length === 0 && (
                <tr><td colSpan={6} className="st-empty">Không có Trigger nào được kích hoạt trên bảng này.</td></tr>
              )}
            </tbody>
          </table>
        )}

        {section === 'partitions' && (
          <table className="structure-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}>#</th>
                <th>Tên Partition</th>
                <th>Phương thức</th>
                <th>Biểu thức / Điều kiện</th>
                <th>Mô tả giới hạn</th>
                <th>Ước tính dòng</th>
                <th style={{ width: '70px', textAlign: 'center' }}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {partitions.map((pt, idx) => (
                <tr key={pt.name || idx}>
                  <td style={{ textAlign: 'center', color: 'var(--win-text-disabled)' }}>{idx + 1}</td>
                  <td style={{ fontWeight: 600, color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{pt.name}</td>
                  <td><span className="st-badge st-badge-info">{pt.method}</span></td>
                  <td style={{ fontFamily: 'var(--win-font-mono)' }}>{pt.expression || 'N/A'}</td>
                  <td style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{pt.description || 'N/A'}</td>
                  <td>{pt.tableRows.toLocaleString()} dòng</td>
                  <td style={{ textAlign: 'center' }}>
                    <button className="st-row-del" onClick={() => handleDropPartition(pt.name)} title="Xóa Partition">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {partitions.length === 0 && (
                <tr><td colSpan={7} className="st-empty">Bảng này không phân vùng (Non-partitioned Table).</td></tr>
              )}
            </tbody>
          </table>
        )}

        {/* DDL — current definition, or the SQL that Save is about to run */}
        {section === 'ddl' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <span style={{
                fontSize: '11px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                color: changed ? 'var(--st-warn)' : 'var(--win-text-secondary)'
              }}>
                {changed
                  ? t('structure.ddlPending', { n: alterPreview?.length ?? 0 })
                  : t('structure.ddlCurrent')}
              </span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {changed ? (
                  <button className="btn btn-secondary" onClick={() => copyText(ddlText, 'ALTER TABLE')} disabled={!ddlText}>
                    <Copy size={13} /> {t('common.copy')}
                  </button>
                ) : (
                  <>
                    <button className="btn btn-secondary" onClick={() => copyText(ddlText, 'CREATE TABLE')} disabled={!ddlText}>
                      <Copy size={13} /> {t('structure.copyCreate')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => copyText(dropScript, 'DROP TABLE')}>
                      <Copy size={13} /> {t('structure.copyDrop')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => copyText(truncateScript, 'TRUNCATE')}>
                      <Trash2 size={13} /> {t('structure.copyTruncate')}
                    </button>
                  </>
                )}
              </div>
            </div>
            <HighlightSqlView sql={ddlText} loading={ddlLoading} emptyText={t('structure.previewEmpty')} />
          </div>
        )}

      </div>

      {/* SQL Preview Modal */}
      {previewSqls && (
        <Modal
          title={t('structure.previewTitle')}
          onClose={() => setPreviewSqls(null)}
          closeDisabled={loading}
          width="600px"
          maxWidth="90%"
          maxHeight="80vh"
          zIndex={9999}
        >
          <ModalBody style={{ gap: 0, flex: 1, background: 'var(--win-bg-window)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', color: 'var(--win-text-primary)' }}>
            {previewSqls.length === 0 ? (
              <div style={{ color: 'var(--win-text-disabled)' }}>{t('structure.previewEmpty')}</div>
            ) : (
              previewSqls.map((sql, idx) => (
                <pre key={idx} style={{ margin: '0 0 12px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', paddingBottom: '8px', borderBottom: idx < previewSqls.length - 1 ? '1px dashed var(--win-border)' : 'none' }}>
                  {sql}
                </pre>
              ))
            )}
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setPreviewSqls(null)} disabled={loading}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleExecuteAlter} disabled={loading || previewSqls.length === 0} style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }}>
              {loading ? t('structure.executing') : t('structure.confirmExecute')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* Foreign Key Popover Menu */}
      {fkPopoverCol && fkPopoverPos && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99990 }}
            onClick={() => { setFkPopoverCol(null); setFkPopoverPos(null); }}
          />
          <div
            className="st-fk-popover"
            style={{
              position: 'fixed',
              top: `${fkPopoverPos.top}px`,
              left: `${fkPopoverPos.left}px`,
              zIndex: 99991,
            }}
          >
            {(() => {
              const existingFk = fks.find(f => f.column === fkPopoverCol);
              return existingFk ? (
                <>
                  <div
                    className="st-popover-item"
                    style={{ fontWeight: 600, color: 'var(--win-accent)' }}
                    onClick={() => {
                      const fkRow = existingFk;
                      setFkModalData({
                        name: fkRow.name,
                        origName: fkRow.name,
                        column: fkRow.column,
                        refTable: fkRow.refTable,
                        refColumn: fkRow.refColumn,
                        onUpdate: (fkRow as any).onUpdate || 'NO ACTION',
                        onDelete: (fkRow as any).onDelete || 'NO ACTION',
                        isNew: false
                      });
                      setFkPopoverCol(null);
                      setFkPopoverPos(null);
                    }}
                  >
                    {`${existingFk.refTable}(${existingFk.refColumn})`}
                  </div>
                  <div style={{ height: '1px', background: 'var(--win-border)', margin: '4px 6px', opacity: 0.5 }} />
                </>
              ) : null;
            })()}

            <div
              className="st-popover-item"
              style={{ color: 'var(--win-text-primary)' }}
              onClick={() => {
                setFkModalData({
                  column: fkPopoverCol,
                  refTable: '',
                  refColumn: '',
                  onUpdate: 'NO ACTION',
                  onDelete: 'NO ACTION',
                  isNew: true
                });
                setFkPopoverCol(null);
                setFkPopoverPos(null);
              }}
            >
              {`Create a new foreign key on ${fkPopoverCol}`}
            </div>
          </div>
        </>,
        document.body
      )}

      {/* Foreign Key Window Modal */}
      {fkModalData && (
        <Modal
          title="Foreign Key Window"
          onClose={() => setFkModalData(null)}
          width="500px"
          zIndex={9999}
        >
          <ModalBody style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px 20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Name</span>
              <input
                type="text"
                className="form-input"
                value={fkModalData.name || `fk_${tableName}_col_${fkModalData.column}`}
                onChange={e => setFkModalData({ ...fkModalData, name: e.target.value })}
                style={{ width: '100%', padding: '4px 8px', height: '30px' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Column</span>
              <select
                className="form-input"
                value={fkModalData.column}
                onChange={e => setFkModalData({ ...fkModalData, column: e.target.value })}
                style={{ width: '100%', padding: '4px 8px', height: '30px' }}
              >
                {cols.map(c => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Referenced Table</span>
              <select
                className="form-input"
                value={fkModalData.refTable}
                onChange={async (e) => {
                  const newTbl = e.target.value;
                  setFkModalData({ ...fkModalData, refTable: newTbl, refColumn: '' });
                  if (newTbl) {
                    setRefColumns(await getColumnsOf(newTbl));
                  }
                }}
                style={{ width: '100%', padding: '4px 8px', height: '30px' }}
              >
                <option value="">Select a table...</option>
                {allTables.map(tbl => (
                  <option key={tbl} value={tbl}>{tbl}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Referenced Columns</span>
              <select
                className="form-input"
                value={fkModalData.refColumn}
                onChange={e => setFkModalData({ ...fkModalData, refColumn: e.target.value })}
                disabled={!fkModalData.refTable}
                style={{ width: '100%', padding: '4px 8px', height: '30px' }}
              >
                <option value="">{loadingRefCols ? t('structure.loadingColumns') : (fkModalData.refTable ? 'Select column...' : 'Select a table first...')}</option>
                {refColumns.map(col => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>On Update</span>
              <select
                className="form-input"
                value={fkModalData.onUpdate}
                onChange={e => setFkModalData({ ...fkModalData, onUpdate: e.target.value })}
                style={{ width: '100%', padding: '4px 8px', height: '30px' }}
              >
                <option value="NO ACTION">NO ACTION</option>
                <option value="RESTRICT">RESTRICT</option>
                <option value="CASCADE">CASCADE</option>
                <option value="SET NULL">SET NULL</option>
                <option value="SET DEFAULT">SET DEFAULT</option>
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>On Delete</span>
              <select
                className="form-input"
                value={fkModalData.onDelete}
                onChange={e => setFkModalData({ ...fkModalData, onDelete: e.target.value })}
                style={{ width: '100%', padding: '4px 8px', height: '30px' }}
              >
                <option value="NO ACTION">NO ACTION</option>
                <option value="RESTRICT">RESTRICT</option>
                <option value="CASCADE">CASCADE</option>
                <option value="SET NULL">SET NULL</option>
                <option value="SET DEFAULT">SET DEFAULT</option>
              </select>
            </div>
          </ModalBody>
          <ModalFooter style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 20px' }}>
            {!fkModalData.isNew && (
              <button
                className="btn btn-secondary"
                style={{ color: 'var(--st-danger)', borderColor: 'rgba(239, 68, 68, 0.3)' }}
                onClick={() => {
                  if (fkModalData.origName) {
                    handleDeleteFK(fkModalData.origName, false);
                  }
                  setFkModalData(null);
                }}
              >
                Delete
              </button>
            )}
            <button
              className="btn btn-primary"
              disabled={!fkModalData.refTable || !fkModalData.refColumn}
              onClick={() => {
                if (fkModalData.isNew) {
                  let baseName = fkModalData.name || `fk_${tableName}_col_${fkModalData.column}`;
                  setFks(prev => [
                    ...prev,
                    {
                      name: baseName,
                      column: fkModalData.column,
                      refTable: fkModalData.refTable,
                      refColumn: fkModalData.refColumn,
                      onUpdate: fkModalData.onUpdate,
                      onDelete: fkModalData.onDelete
                    } as any
                  ]);
                } else {
                  setFks(prev => prev.map(f => {
                    if (f.name === fkModalData.origName || f.column === fkModalData.column) {
                      return {
                        ...f,
                        name: fkModalData.name,
                        refTable: fkModalData.refTable,
                        refColumn: fkModalData.refColumn,
                        onUpdate: fkModalData.onUpdate,
                        onDelete: fkModalData.onDelete
                      } as any;
                    }
                    return f;
                  }));
                }
                setFkModalData(null);
              }}
            >
              OK
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* The index modal (visually adding or editing an index) */}
      {idxModalData && (
        <Modal
          title={idxModalData.isNew ? "Thêm Index Mới" : "Chỉnh sửa Index"}
          onClose={() => setIdxModalData(null)}
          width="500px"
          zIndex={9999}
        >
          <ModalBody style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '16px 20px' }}>
            {/* Index name */}
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Tên Index</span>
              <input
                type="text"
                className="form-input"
                value={idxModalData.name}
                onChange={e => setIdxModalData({ ...idxModalData, name: e.target.value })}
                placeholder="vd: idx_table_col"
                style={{ width: '100%', padding: '4px 8px', height: '30px' }}
              />
            </div>

            {/* Index type */}
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Loại Index</span>
              <select
                className="form-input"
                value={idxModalData.type}
                onChange={e => setIdxModalData({ ...idxModalData, type: e.target.value })}
                style={{ width: '100%', padding: '4px 8px', height: '30px' }}
              >
                <option value="INDEX">INDEX (Bình thường)</option>
                <option value="UNIQUE">UNIQUE (Duy nhất)</option>
                {dbType === 'mysql' && <option value="FULLTEXT">FULLTEXT (Toàn văn)</option>}
                {dbType === 'mysql' && <option value="SPATIAL">SPATIAL (Không gian)</option>}
              </select>
            </div>

            {/* Target columns (a multi-column selector) */}
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'flex-start', gap: '12px' }}>
              <span style={{ fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right', paddingTop: '4px' }}>Cột chỉ mục</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div className="st-chips-row">
                  {cols.map(c => {
                    const isSelected = idxModalData.columns.includes(c.name);
                    return (
                      <button
                        key={c.name}
                        type="button"
                        className={`st-chip-btn ${isSelected ? 'operator' : ''}`}
                        onClick={() => {
                          const exists = idxModalData.columns.includes(c.name);
                          const nextCols = exists
                            ? idxModalData.columns.filter(n => n !== c.name)
                            : [...idxModalData.columns, c.name];
                          setIdxModalData({
                            ...idxModalData,
                            columns: nextCols
                          });
                        }}
                        style={{
                          background: isSelected ? 'var(--win-accent-glow)' : undefined,
                          borderColor: isSelected ? 'var(--win-accent)' : undefined,
                          fontWeight: isSelected ? 600 : 400
                        }}
                      >
                        <span>{isSelected ? '✓' : '+'}</span> {c.name}
                      </button>
                    );
                  })}
                </div>
                {idxModalData.columns.length > 0 ? (
                  <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                    Thứ tự cột: <strong style={{ color: 'var(--win-accent)' }}>{idxModalData.columns.join(', ')}</strong>
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', color: 'var(--st-danger)' }}>
                    Vui lòng chọn ít nhất 1 cột
                  </div>
                )}
              </div>
            </div>
          </ModalBody>
          <ModalFooter style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 20px' }}>
            <button className="btn btn-secondary" onClick={() => setIdxModalData(null)}>Hủy</button>
            <button
              className="btn btn-primary"
              disabled={!idxModalData.name.trim() || idxModalData.columns.length === 0}
              onClick={() => {
                const colsStr = idxModalData.columns.join(', ');
                const isUnique = idxModalData.type === 'UNIQUE';
                const typeStr = idxModalData.type;

                if (idxModalData.isNew) {
                  setIdxs(prev => [
                    ...prev,
                    {
                      name: idxModalData.name.trim(),
                      columns: colsStr,
                      unique: isUnique,
                      type: typeStr
                    } as any
                  ]);
                } else {
                  setIdxs(prev => prev.map((item, i) => {
                    if (i === idxModalData.index) {
                      return {
                        ...item,
                        name: idxModalData.name.trim(),
                        columns: colsStr,
                        unique: isUnique,
                        type: typeStr
                      } as any;
                    }
                    return item;
                  }));
                }
                setIdxModalData(null);
              }}
            >
              {idxModalData.isNew ? "Tạo Index" : "Lưu thay đổi"}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* The check-constraint modal (visually adding and editing) */}
      {checkModalData && (
        <Modal
          title={checkModalData.isNew ? "Thêm Check Constraint" : "Chỉnh sửa Check Constraint"}
          onClose={() => setCheckModalData(null)}
          width="540px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '14px' }}>
            {/* Constraint name */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Tên Constraint:</label>
              <input
                type="text"
                placeholder={`chk_${tableName}_...`}
                value={checkModalData.name}
                onChange={e => setCheckModalData({ ...checkModalData, name: e.target.value })}
                style={{ padding: '7px 10px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
              />
            </div>

            {/* Quick Columns helper chips */}
            {cols.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Chọn nhanh cột trong bảng:</label>
                <div className="st-chips-row">
                  {cols.map(c => (
                    <button
                      key={c.name}
                      type="button"
                      className="st-chip-btn"
                      onClick={() => insertIntoCheckExpr(dbType === 'mysql' ? `\`${c.name}\`` : `"${c.name}"`)}
                      title={`Chèn cột ${c.name}`}
                    >
                      <span>+</span> {c.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Quick Operators helper chips */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Toán tử nhanh:</label>
              <div className="st-chips-row">
                {['>', '<', '>=', '<=', '=', '<>', 'BETWEEN', 'IN', 'IS NOT NULL', 'LIKE', 'AND', 'OR'].map(op => (
                  <button
                    key={op}
                    type="button"
                    className="st-chip-btn operator"
                    onClick={() => insertIntoCheckExpr(op)}
                    title={`Chèn toán tử ${op}`}
                  >
                    {op}
                  </button>
                ))}
              </div>
            </div>

            {/* Common condition templates */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Mẫu kiểm tra phổ biến:</label>
              <div className="st-chips-row">
                <button
                  type="button"
                  className="st-tpl-btn"
                  onClick={() => {
                    const col = cols[0]?.name ? (dbType === 'mysql' ? `\`${cols[0].name}\`` : `"${cols[0].name}"`) : 'col';
                    setCheckModalData({ ...checkModalData, expression: `${col} > 0` });
                  }}
                >
                  💡 Lớn hơn 0 (col &gt; 0)
                </button>
                <button
                  type="button"
                  className="st-tpl-btn"
                  onClick={() => {
                    const col = cols[0]?.name ? (dbType === 'mysql' ? `\`${cols[0].name}\`` : `"${cols[0].name}"`) : 'col';
                    setCheckModalData({ ...checkModalData, expression: `${col} >= 0` });
                  }}
                >
                  💡 Không âm (col &ge; 0)
                </button>
                <button
                  type="button"
                  className="st-tpl-btn"
                  onClick={() => {
                    const col = cols[0]?.name ? (dbType === 'mysql' ? `\`${cols[0].name}\`` : `"${cols[0].name}"`) : 'col';
                    setCheckModalData({ ...checkModalData, expression: `${col} BETWEEN 1 AND 100` });
                  }}
                >
                  💡 Trong khoảng (BETWEEN)
                </button>
                <button
                  type="button"
                  className="st-tpl-btn"
                  onClick={() => {
                    const col = cols[0]?.name ? (dbType === 'mysql' ? `\`${cols[0].name}\`` : `"${cols[0].name}"`) : 'col';
                    setCheckModalData({ ...checkModalData, expression: `${col} IN ('A', 'B', 'C')` });
                  }}
                >
                  💡 Danh sách (IN)
                </button>
              </div>
            </div>

            {/* The check expression */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Biểu thức Check (Expression):</label>
              <textarea
                rows={3}
                placeholder={dbType === 'mysql' ? "vd: `amount` > 0 AND `status` <> 'CANCELLED'" : 'vd: "amount" > 0 AND "status" <> \'CANCELLED\''}
                value={checkModalData.expression}
                onChange={e => setCheckModalData({ ...checkModalData, expression: e.target.value })}
                style={{ padding: '8px 10px', fontSize: '12px', fontFamily: 'var(--win-font-mono)', borderRadius: '6px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setCheckModalData(null)}>Hủy</button>
            <button
              className="btn btn-primary"
              disabled={!checkModalData.expression.trim()}
              onClick={handleSaveOrUpdateCheck}
              style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}
            >
              {checkModalData.isNew ? "Tạo Constraint" : "Lưu thay đổi"}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* The trigger modal (visually adding and editing) */}
      {triggerModalData && (
        <Modal
          title={triggerModalData.isNew ? "Thêm Trigger Mới" : "Chỉnh sửa Trigger"}
          onClose={() => setTriggerModalData(null)}
          width="580px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '14px' }}>
            {/* Trigger name */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Tên Trigger:</label>
              <input
                type="text"
                placeholder="vd: trg_update_timestamp"
                value={triggerModalData.name}
                onChange={e => setTriggerModalData({ ...triggerModalData, name: e.target.value })}
                style={{ padding: '7px 10px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
              />
            </div>

            {/* Timing & Event */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Thời điểm (Timing):</label>
                <select
                  value={triggerModalData.timing}
                  onChange={e => setTriggerModalData({ ...triggerModalData, timing: e.target.value })}
                  style={{ padding: '7px 10px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
                >
                  <option value="BEFORE">BEFORE</option>
                  <option value="AFTER">AFTER</option>
                  <option value="INSTEAD OF">INSTEAD OF</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Sự kiện (Event):</label>
                <select
                  value={triggerModalData.event}
                  onChange={e => setTriggerModalData({ ...triggerModalData, event: e.target.value })}
                  style={{ padding: '7px 10px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
                >
                  <option value="INSERT">INSERT</option>
                  <option value="UPDATE">UPDATE</option>
                  <option value="DELETE">DELETE</option>
                </select>
              </div>
            </div>

            {/* Quick Column Badges */}
            {cols.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Chèn nhanh trường dữ liệu:</label>
                <div className="st-chips-row">
                  {cols.slice(0, 10).map(c => (
                    <React.Fragment key={c.name}>
                      <button
                        type="button"
                        className="st-chip-btn"
                        onClick={() => insertIntoTriggerBody(`NEW.${c.name}`)}
                        title={`Chèn NEW.${c.name}`}
                      >
                        <span>+</span> NEW.{c.name}
                      </button>
                      <button
                        type="button"
                        className="st-chip-btn"
                        onClick={() => insertIntoTriggerBody(`OLD.${c.name}`)}
                        title={`Chèn OLD.${c.name}`}
                      >
                        <span>+</span> OLD.{c.name}
                      </button>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}

            {/* Common trigger templates */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Mẫu câu lệnh thường dùng:</label>
              <div className="st-chips-row">
                <button
                  type="button"
                  className="st-tpl-btn"
                  onClick={() => {
                    setTriggerModalData({
                      ...triggerModalData,
                      timing: 'BEFORE',
                      event: 'UPDATE',
                      body: 'BEGIN\n  SET NEW.updated_at = NOW();\nEND;'
                    });
                  }}
                >
                  💡 Cập nhật timestamp (updated_at)
                </button>
                <button
                  type="button"
                  className="st-tpl-btn"
                  onClick={() => {
                    const col = cols[0]?.name || 'id';
                    setTriggerModalData({
                      ...triggerModalData,
                      body: `BEGIN\n  IF NEW.${col} IS NULL THEN\n    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Giá trị không được để trống';\n  END IF;\nEND;`
                    });
                  }}
                >
                  💡 Kiểm tra & Chặn dữ liệu (SIGNAL)
                </button>
              </div>
            </div>

            {/* The trigger body */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Thân Trigger (Action Statement):</label>
              <textarea
                rows={6}
                placeholder="BEGIN\n  -- SQL statements\nEND;"
                value={triggerModalData.body}
                onChange={e => setTriggerModalData({ ...triggerModalData, body: e.target.value })}
                style={{ padding: '8px 10px', fontSize: '12px', fontFamily: 'var(--win-font-mono)', borderRadius: '6px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', lineHeight: 1.5 }}
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setTriggerModalData(null)}>Hủy</button>
            <button
              className="btn btn-primary"
              disabled={!triggerModalData.name.trim() || !triggerModalData.body.trim()}
              onClick={handleSaveOrUpdateTrigger}
              style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}
            >
              {triggerModalData.isNew ? "Tạo Trigger" : "Lưu thay đổi"}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* Add Partition Modal */}
      {showAddPartitionModal && (
        <Modal title="Thêm Partition Mới" onClose={() => setShowAddPartitionModal(false)} width="480px" zIndex={999999}>
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Tên Partition:</label>
              <input type="text" placeholder="vd: p2026" value={newPartition.name} onChange={e => setNewPartition({ ...newPartition, name: e.target.value })} style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Điều kiện giá trị (VALUES Clause):</label>
              <input type="text" placeholder="vd: LESS THAN (2027) hoặc IN ('HN', 'HCM')" value={newPartition.valClause} onChange={e => setNewPartition({ ...newPartition, valClause: e.target.value })} style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }} />
            </div>
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setShowAddPartitionModal(false)}>Hủy</button>
            <button className="btn btn-primary" onClick={handleSavePartition} style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}>Tạo Partition</button>
          </ModalFooter>
        </Modal>
      )}

      {/* Right-click Context Menu */}
      {contextMenu && createPortal(
        <div
          className="st-context-menu"
          style={{
            top: contextMenu.y,
            left: contextMenu.x,
          }}
        >
          {contextMenu.type === 'column' && (
            <>
              <div
                className="st-context-menu-item"
                onClick={() => { handleAddColumn(); setContextMenu(null); }}
              >
                <Plus size={13} />
                <span>{t('structure.addColumn')}</span>
              </div>
              <div
                className="st-context-menu-item"
                onClick={() => handleDuplicateColumn(contextMenu.rowIndex)}
              >
                <Copy size={13} />
                <span>Duplicate column</span>
              </div>
              <div
                className="st-context-menu-item"
                onClick={() => { handleTogglePrimaryKey(contextMenu.rowIndex); setContextMenu(null); }}
              >
                <Key size={13} style={{ color: '#f59e0b' }} />
                <span>Toggle Primary Key</span>
              </div>
              <div style={{ height: '1px', background: 'var(--win-border, rgba(255,255,255,0.1))', margin: '2px 0' }} />
              <div
                className="st-context-menu-item"
                onClick={() => { navigator.clipboard.writeText(contextMenu.name); setContextMenu(null); }}
              >
                <Copy size={13} />
                <span>Copy column name</span>
              </div>
              <div style={{ height: '1px', background: 'var(--win-border, rgba(255,255,255,0.1))', margin: '2px 0' }} />
              <div
                className="st-context-menu-item danger"
                onClick={() => { handleDeleteColumn(contextMenu.name, !isOriginalColumn(contextMenu.name)); setContextMenu(null); }}
              >
                <Trash2 size={13} />
                <span>Drop column</span>
              </div>
            </>
          )}
          {contextMenu.type === 'index' && (
            <>
              <div
                className="st-context-menu-item"
                onClick={() => { handleAddIndex(); setContextMenu(null); }}
              >
                <Plus size={13} />
                <span>{t('structure.addIndex')}</span>
              </div>
              <div
                className="st-context-menu-item"
                onClick={() => { navigator.clipboard.writeText(contextMenu.name); setContextMenu(null); }}
              >
                <Copy size={13} />
                <span>Copy index name</span>
              </div>
              {contextMenu.name !== 'PRIMARY' && (
                <div
                  className="st-context-menu-item danger"
                  onClick={() => { handleDeleteIndex(contextMenu.name, !isOriginalIndex(contextMenu.name)); setContextMenu(null); }}
                >
                  <Trash2 size={13} />
                  <span>Drop index</span>
                </div>
              )}
            </>
          )}
          {contextMenu.type === 'fk' && (
            <>
              <div
                className="st-context-menu-item"
                onClick={() => { handleAddFK(); setContextMenu(null); }}
              >
                <Plus size={13} />
                <span>Add Foreign Key</span>
              </div>
              <div
                className="st-context-menu-item"
                onClick={() => { navigator.clipboard.writeText(contextMenu.name); setContextMenu(null); }}
              >
                <Copy size={13} />
                <span>Copy FK name</span>
              </div>
              <div
                className="st-context-menu-item danger"
                onClick={() => { handleDeleteFK(contextMenu.name, !isOriginalFk(contextMenu.name)); setContextMenu(null); }}
              >
                <Trash2 size={13} />
                <span>Drop Foreign Key</span>
              </div>
            </>
          )}
        </div>,
        document.body
      )}

      {/* Drop confirmation for check constraints / triggers / partitions. */}
      {dropTarget && (
        <ConfirmDialog
          open
          danger
          title={
            dropTarget.kind === 'check' ? t('structure.confirmDropCheckTitle')
              : dropTarget.kind === 'trigger' ? t('structure.confirmDropTriggerTitle')
                : t('structure.confirmDropPartitionTitle')
          }
          message={
            dropTarget.kind === 'check' ? t('structure.confirmDropCheckMessage', { name: dropTarget.name })
              : dropTarget.kind === 'trigger' ? t('structure.confirmDropTriggerMessage', { name: dropTarget.name })
                : t('structure.confirmDropPartitionMessage', { name: dropTarget.name })
          }
          note={dropTarget.kind === 'partition' ? t('structure.confirmDropPartitionNote') : undefined}
          onConfirm={confirmDrop}
          onCancel={() => setDropTarget(null)}
        />
      )}
    </div>
  );
};
