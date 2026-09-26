import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dbHelper } from '../utils/dbHelper';
import { Plus, Trash2 } from 'lucide-react';
import { nextRowId, withoutRowIds, type WithRowId } from '../utils/rowIds';

interface ColumnInfo {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  autoIncrement: boolean;
  nullable: boolean;
  defaultValue?: string;
  comment?: string;
}

interface IndexInfo {
  name: string;
  columns: string;
  unique: boolean;
}

interface FkInfo {
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
}

interface CreateTableModalProps {
  isOpen: boolean;
  onClose: () => void;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  onTableCreated: (tableName: string) => void;
}

export const CreateTableModal: React.FC<CreateTableModalProps> = ({
  isOpen,
  onClose,
  dbType,
  onTableCreated,
}) => {
  const { t } = useTranslation();
  const [tableName, setTableName] = useState('');
  const [activeTab, setActiveTab] = useState<'columns' | 'indexes' | 'foreignKeys'>('columns');

  // Columns state - default to first id column
  // Every row carries a `rowId` for its React key (see `utils/rowIds.ts`): keyed by position,
  // deleting a middle row gave its inputs to the row below it.
  const [cols, setCols] = useState<WithRowId<ColumnInfo>[]>(() => [
    { rowId: nextRowId(), name: 'id', type: dbType === 'postgres' ? 'INTEGER' : 'INTEGER', isPrimaryKey: true, autoIncrement: true, nullable: false }
  ]);

  // Indexes state
  const [idxs, setIdxs] = useState<WithRowId<IndexInfo>[]>([]);

  // FKs state
  const [fks, setFks] = useState<WithRowId<FkInfo>[]>([]);

  if (!isOpen) return null;

  const getTypesForDb = () => {
    switch (dbType) {
      case 'postgres':
        return [
          'INTEGER', 'BIGINT', 'SMALLINT', 'VARCHAR(255)', 'CHAR(10)', 'TEXT', 
          'BOOLEAN', 'NUMERIC(10,2)', 'REAL', 'DOUBLE PRECISION', 'DATE', 
          'TIME', 'TIMESTAMP', 'UUID', 'JSONB', 'BYTEA'
        ];
      case 'mysql':
        return [
          'INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'DECIMAL(10,2)', 'FLOAT', 
          'DOUBLE', 'VARCHAR(255)', 'CHAR(10)', 'TEXT', 'LONGTEXT', 'BLOB', 
          'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'JSON'
        ];
      case 'sqlite':
      default:
        return ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'VARCHAR(255)', 'BOOLEAN', 'TIMESTAMP'];
    }
  };

  const dbTypes = getTypesForDb();

  const handleAddColumn = () => {
    setCols([
      ...cols,
      { rowId: nextRowId(), name: `col_${cols.length + 1}`, type: dbTypes[0], isPrimaryKey: false, autoIncrement: false, nullable: true }
    ]);
  };

  const handleRemoveColumn = (index: number) => {
    setCols(cols.filter((_, idx) => idx !== index));
  };

  const handleColChange = (index: number, field: keyof ColumnInfo, value: any) => {
    setCols(cols.map((col, idx) => {
      if (idx === index) {
        return { ...col, [field]: value };
      }
      return col;
    }));
  };

  const handleAddIndex = () => {
    setIdxs([
      ...idxs,
      { rowId: nextRowId(), name: `idx_${tableName || 'table'}_col_${idxs.length + 1}`, columns: '', unique: false }
    ]);
  };

  const handleRemoveIndex = (index: number) => {
    setIdxs(idxs.filter((_, idx) => idx !== index));
  };

  const handleIdxChange = (index: number, field: keyof IndexInfo, value: any) => {
    setIdxs(idxs.map((idxInfo, idx) => {
      if (idx === index) {
        return { ...idxInfo, [field]: value };
      }
      return idxInfo;
    }));
  };

  const handleAddFk = () => {
    setFks([
      ...fks,
      { rowId: nextRowId(), name: `fk_${tableName || 'table'}_col_${fks.length + 1}`, column: '', refTable: '', refColumn: '' }
    ]);
  };

  const handleRemoveFk = (index: number) => {
    setFks(fks.filter((_, idx) => idx !== index));
  };

  const handleFkChange = (index: number, field: keyof FkInfo, value: any) => {
    setFks(fks.map((fk, idx) => {
      if (idx === index) {
        return { ...fk, [field]: value };
      }
      return fk;
    }));
  };

  const handleSubmit = async () => {
    const name = tableName.trim();
    if (!name) {
      alert(t('createTable.errNoName'));
      return;
    }
    if (cols.length === 0) {
      alert(t('createTable.errNoColumn'));
      return;
    }

    try {
      // Send only the indexes and foreign keys that are fully filled in, so no broken SQL is generated
      const validIdxs = idxs.filter(i => i.name.trim() && i.columns.trim());
      const validFks = fks.filter(f => f.column.trim() && f.refTable.trim() && f.refColumn.trim());
      const res = await dbHelper.createTable(name, withoutRowIds(cols), withoutRowIds(validIdxs), withoutRowIds(validFks));
      if (res.success) {
        alert(t('createTable.created'));
        onTableCreated(name);
        onClose();
      } else {
        alert(t('createTable.errCreate', { message: res.error }));
      }
    } catch (e: any) {
      alert(t('common.connectionError', { message: e.message }));
    }
  };

  return (
    <div className="ctm-backdrop">
      <div className="ctm-dialog">
        {/* Header */}
        <div className="ctm-head">
          <span className="ctm-title">{t('createTable.title')}</span>
          <button className="ctm-close" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}>
            ×
          </button>
        </div>

        {/* Content Area */}
        <div className="ctm-body">
          {/* Table Name Input */}
          <div className="form-group ctm-name">
            <label>{t('createTable.tableName')}</label>
            <input
              type="text"
              className="form-input"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder={t('createTable.tableNamePlaceholder')}
              autoFocus
            />
          </div>

          {/* Tabs header */}
          <div className="ctm-tabs">
            <button
              className={`ctm-tab ${activeTab === 'columns' ? 'active' : ''}`}
              onClick={() => setActiveTab('columns')}
            >
              {t('createTable.tabColumns')} <span className="ctm-tab-count">{cols.length}</span>
            </button>
            <button
              className={`ctm-tab ${activeTab === 'indexes' ? 'active' : ''}`}
              onClick={() => setActiveTab('indexes')}
            >
              {t('createTable.tabIndexes')} <span className="ctm-tab-count">{idxs.length}</span>
            </button>
            <button
              className={`ctm-tab ${activeTab === 'foreignKeys' ? 'active' : ''}`}
              onClick={() => setActiveTab('foreignKeys')}
            >
              {t('createTable.tabForeignKeys')} <span className="ctm-tab-count">{fks.length}</span>
            </button>
          </div>

          {/* Active Tab Panel */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {activeTab === 'columns' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleAddColumn}
                    style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '0 8px' }}
                  >
                    <Plus size={10} />
                    <span>{t('createTable.addColumn')}</span>
                  </button>
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.colName')}</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.colType')}</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>{t('createTable.colNullable')}</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>{t('createTable.colPrimaryKey')}</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>{t('createTable.colAutoIncrement')}</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.colDefault')}</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.colComment')}</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>{t('createTable.colDelete')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cols.map((col, idx) => (
                      <tr key={col.rowId} style={{ borderBottom: '1px solid var(--win-border)' }}>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={col.name} 
                            onChange={(e) => handleColChange(idx, 'name', e.target.value)}
                            style={{ width: '100px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <select 
                            value={col.type} 
                            onChange={(e) => handleColChange(idx, 'type', e.target.value)}
                            style={{ fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px', borderRadius: '3px', cursor: 'pointer' }}
                          >
                            {dbTypes.map(typeOpt => <option key={typeOpt} value={typeOpt} style={{ background: 'var(--win-bg-card)', color: 'var(--win-text-primary)' }}>{typeOpt}</option>)}
                          </select>
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            checked={col.nullable} 
                            onChange={(e) => handleColChange(idx, 'nullable', e.target.checked)}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            checked={col.isPrimaryKey} 
                            onChange={(e) => {
                              handleColChange(idx, 'isPrimaryKey', e.target.checked);
                              if (e.target.checked) {
                                handleColChange(idx, 'nullable', false);
                              }
                            }}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            checked={col.autoIncrement} 
                            onChange={(e) => handleColChange(idx, 'autoIncrement', e.target.checked)}
                            disabled={col.type !== 'INTEGER' && col.type !== 'INT' && col.type !== 'BIGINT'}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={col.defaultValue || ''} 
                            placeholder="NULL"
                            onChange={(e) => handleColChange(idx, 'defaultValue', e.target.value)}
                            style={{ width: '80px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={col.comment || ''} 
                            onChange={(e) => handleColChange(idx, 'comment', e.target.value)}
                            style={{ width: '100px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <button 
                            onClick={() => handleRemoveColumn(idx)}
                            style={{ background: 'transparent', border: 'none', color: 'var(--st-danger)', cursor: 'pointer' }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'indexes' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleAddIndex}
                    style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '0 8px' }}
                  >
                    <Plus size={10} />
                    <span>{t('createTable.addIndex')}</span>
                  </button>
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.idxName')}</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.idxColumns')}</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>{t('createTable.idxUnique')}</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>{t('createTable.colDelete')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {idxs.map((idxInfo, idx) => (
                      <tr key={idxInfo.rowId} style={{ borderBottom: '1px solid var(--win-border)' }}>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={idxInfo.name} 
                            onChange={(e) => handleIdxChange(idx, 'name', e.target.value)}
                            style={{ width: '200px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={idxInfo.columns} 
                            placeholder={t('createTable.idxColumnsPlaceholder')}
                            onChange={(e) => handleIdxChange(idx, 'columns', e.target.value)}
                            style={{ width: '250px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            checked={idxInfo.unique} 
                            onChange={(e) => handleIdxChange(idx, 'unique', e.target.checked)}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <button 
                            onClick={() => handleRemoveIndex(idx)}
                            style={{ background: 'transparent', border: 'none', color: 'var(--st-danger)', cursor: 'pointer' }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'foreignKeys' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleAddFk}
                    style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '0 8px' }}
                  >
                    <Plus size={10} />
                    <span>{t('createTable.addForeignKey')}</span>
                  </button>
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.fkName')}</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.fkColumn')}</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.fkRefTable')}</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>{t('createTable.fkRefColumn')}</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>{t('createTable.colDelete')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fks.map((fk, idx) => (
                      <tr key={fk.rowId} style={{ borderBottom: '1px solid var(--win-border)' }}>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={fk.name} 
                            onChange={(e) => handleFkChange(idx, 'name', e.target.value)}
                            style={{ width: '150px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={fk.column} 
                            placeholder={t('createTable.fkColumnPlaceholder')}
                            onChange={(e) => handleFkChange(idx, 'column', e.target.value)}
                            style={{ width: '100px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={fk.refTable} 
                            placeholder={t('createTable.fkRefTablePlaceholder')}
                            onChange={(e) => handleFkChange(idx, 'refTable', e.target.value)}
                            style={{ width: '120px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={fk.refColumn} 
                            placeholder={t('createTable.fkRefColumnPlaceholder')}
                            onChange={(e) => handleFkChange(idx, 'refColumn', e.target.value)}
                            style={{ width: '100px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <button 
                            onClick={() => handleRemoveFk(idx)}
                            style={{ background: 'transparent', border: 'none', color: 'var(--st-danger)', cursor: 'pointer' }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="ctm-foot">
          <span className="ctm-foot-hint">
            {t('createTable.footerSummary', {
              columns: cols.length,
              indexes: idxs.length,
              foreignKeys: fks.length,
            })}
          </span>
          <button className="cm-btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="cm-btn primary" onClick={handleSubmit}>{t('createTable.submit')}</button>
        </div>
      </div>
    </div>
  );
};
