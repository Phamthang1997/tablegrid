import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Table2, Network, Code2, ChevronLeft, ChevronRight,
  Search, Copy, Check, Minimize2, Sparkles, ChevronDown
} from 'lucide-react';
import Editor from '@monaco-editor/react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import type { ColumnInfo } from '../utils/dbHelper';
import { MediaCellPreview } from './media';

/** Stable empty default for the `foreignKeys` prop: a fresh `[]` each render breaks memoisation downstream. */
const NO_FKS: { column: string; refTable: string; refColumn: string }[] = [];

export interface RowDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  primaryKey?: string;
  rowIndex: number;
  rows: any[];
  columns: ColumnInfo[];
  foreignKeys?: { column: string; refTable: string; refColumn: string }[];
  onNavigateRow: (newIndex: number) => void;
}

type ViewTab = 'table' | 'tree' | 'json';

interface TreeNodeProps {
  label: string;
  value: any;
  depth?: number;
  isLast?: boolean;
  onCopy?: (text: string, label: string) => void;
  copiedKey?: string | null;
  copyTitle?: string;
  expandTitle?: string;
  collapseTitle?: string;
}

const TreeNode: React.FC<TreeNodeProps> = ({
  label,
  value,
  depth = 0,
  onCopy,
  copiedKey,
  copyTitle,
  expandTitle,
  collapseTitle,
}) => {
  const [expanded, setExpanded] = useState(true);

  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArray = Array.isArray(value);
  const isExpandable = isObject || isArray;

  const getTypeInfo = (val: any): { type: string; className: string } => {
    if (val === null) return { type: 'null', className: 'doc-type-null' };
    if (Array.isArray(val)) return { type: `array[${val.length}]`, className: 'doc-type-array' };
    const t = typeof val;
    if (t === 'object') return { type: `object{${Object.keys(val).length}}`, className: 'doc-type-object' };
    if (t === 'number') return { type: 'number', className: 'doc-type-number' };
    if (t === 'boolean') return { type: 'boolean', className: 'doc-type-boolean' };
    return { type: 'string', className: 'doc-type-string' };
  };

  const typeInfo = getTypeInfo(value);
  const stringifiedValue = value === null ? 'NULL' : typeof value === 'string' ? value : String(value);

  return (
    <div className="doc-tree-node">
      <div
        className="doc-tree-row"
        style={depth > 0 ? { paddingLeft: `${12 + depth * 20}px` } : undefined}
      >
        {isExpandable ? (
          <button
            type="button"
            className="doc-tree-toggle"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? collapseTitle : expandTitle}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="doc-tree-toggle-placeholder" />
        )}

        <span className="doc-tree-key" title={label}>{label}:</span>
        <span className={`doc-type-badge ${typeInfo.className}`}>{typeInfo.type}</span>

        {!isExpandable ? (
          <span className={`doc-tree-val is-${value === null ? 'null' : typeof value}`} title={stringifiedValue}>
            {value === null ? 'NULL' : typeof value === 'string' ? `"${value}"` : String(value)}
          </span>
        ) : (
          <span className="doc-tree-val is-summary">
            {isArray ? `Array(${value.length})` : `{${Object.keys(value).length} keys}`}
          </span>
        )}

        {!isExpandable && onCopy && (
          <button
            type="button"
            className="doc-field-copy-btn"
            onClick={() => onCopy(stringifiedValue, label)}
            title={copyTitle}
          >
            {copiedKey === label ? <Check size={12} className="doc-copy-check" /> : <Copy size={12} />}
          </button>
        )}
      </div>

      {isExpandable && expanded && (
        <div className="doc-tree-children">
          {isArray ? (
            value.map((item: any, idx: number) => (
              <TreeNode
                key={idx}
                label={`[${idx}]`}
                value={item}
                depth={depth + 1}
                onCopy={onCopy}
                copiedKey={copiedKey}
                copyTitle={copyTitle}
                expandTitle={expandTitle}
                collapseTitle={collapseTitle}
              />
            ))
          ) : (
            Object.entries(value).map(([k, v]) => (
              <TreeNode
                key={k}
                label={k}
                value={v}
                depth={depth + 1}
                onCopy={onCopy}
                copiedKey={copiedKey}
                copyTitle={copyTitle}
                expandTitle={expandTitle}
                collapseTitle={collapseTitle}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};

export const RowDocumentModal: React.FC<RowDocumentModalProps> = ({
  isOpen,
  onClose,
  tableName,
  primaryKey = 'id',
  rowIndex,
  rows,
  columns,
  foreignKeys = NO_FKS,
  onNavigateRow,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ViewTab>('table');
  const [searchField, setSearchField] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [jsonText, setJsonText] = useState('');

  // Detect the light/dark theme from the app's own data-theme attribute
  const [isDark, setIsDark] = useState<boolean>(() => {
    return document.documentElement.getAttribute('data-theme') !== 'light';
  });

  useEffect(() => {
    const checkTheme = () => {
      setIsDark(document.documentElement.getAttribute('data-theme') !== 'light');
    };
    checkTheme();
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const currentRow = rows[rowIndex] || null;
  const totalRows = rows.length;

  // Format clean JSON representation of active row
  useEffect(() => {
    if (currentRow) {
      queueMicrotask(() => {
        // Strip internal properties like __tempId
        const cleanRow: Record<string, any> = {};
        Object.keys(currentRow).forEach(k => {
          if (!k.startsWith('__')) {
            cleanRow[k] = currentRow[k];
          }
        });
        setJsonText(JSON.stringify(cleanRow, null, 2));
      });
    }
  }, [currentRow]);

  // The Alt+Left / Alt+Right navigation shortcuts
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        if (rowIndex > 0) onNavigateRow(rowIndex - 1);
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        if (rowIndex < totalRows - 1) onNavigateRow(rowIndex + 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, rowIndex, totalRows, onNavigateRow]);

  const copyToClipboard = useCallback((text: string, key?: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
    if (key) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } else {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1800);
    }
  }, []);

  const handleBeautifyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed, null, 2));
    } catch {}
  }, [jsonText]);

  const handleMinifyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed));
    } catch {}
  }, [jsonText]);

  // Build an INSERT statement from the current row
  const copyAsSqlInsert = useCallback(() => {
    if (!currentRow) return;
    const cols = columns.map(c => c.name);
    const colList = cols.map(c => `\`${c}\``).join(', ');
    const valList = cols.map(c => {
      const val = currentRow[c];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number' || typeof val === 'boolean') return String(val);
      return `'${String(val).replace(/'/g, "''")}'`;
    }).join(', ');
    const sql = `INSERT INTO \`${tableName}\` (${colList}) VALUES (${valList});`;
    copyToClipboard(sql);
  }, [currentRow, columns, tableName, copyToClipboard]);

  // Filter the fields for the Table View
  const filteredColumns = useMemo(() => {
    if (!searchField.trim()) return columns;
    const query = searchField.toLowerCase().trim();
    return columns.filter(c => c.name.toLowerCase().includes(query) || (c.type || '').toLowerCase().includes(query));
  }, [columns, searchField]);

  // The parsed object for the Tree View (JSON-string fields are parsed too, where present)
  const treeData = useMemo(() => {
    if (!currentRow) return {};
    const res: Record<string, any> = {};
    columns.forEach(col => {
      const rawVal = currentRow[col.name];
      if (typeof rawVal === 'string' && (rawVal.startsWith('{') || rawVal.startsWith('['))) {
        try {
          res[col.name] = JSON.parse(rawVal);
          return;
        } catch {}
      }
      res[col.name] = rawVal;
    });
    return res;
  }, [currentRow, columns]);

  // Filter the fields for the Tree View
  const filteredTreeEntries = useMemo(() => {
    const entries = Object.entries(treeData);
    if (!searchField.trim()) return entries;
    const query = searchField.toLowerCase().trim();
    return entries.filter(([key, val]) => {
      const matchKey = key.toLowerCase().includes(query);
      const matchVal = val !== null && val !== undefined && String(val).toLowerCase().includes(query);
      return matchKey || matchVal;
    });
  }, [treeData, searchField]);

  // Check whether any field in the current row contains nested JSON / objects
  const hasNestedData = useMemo(() => {
    if (!currentRow) return false;
    return columns.some(col => {
      const val = currentRow[col.name];
      if (val === null || val === undefined) return false;
      if (typeof val === 'object') return true;
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            JSON.parse(trimmed);
            return true;
          } catch {}
        }
      }
      return false;
    });
  }, [currentRow, columns]);

  // Derive effective active tab (if no nested data, fallback from tree to form view)
  const effectiveTab: ViewTab = (!hasNestedData && activeTab === 'tree') ? 'table' : activeTab;

  if (!isOpen || !currentRow) return null;

  const pkVal = currentRow[primaryKey];
  const titleInfo = pkVal !== undefined && pkVal !== null
    ? `${tableName} — ${primaryKey}: ${pkVal}`
    : `${tableName} — #${rowIndex + 1}`;

  return (
    <Modal
      title={
        <div className="doc-nav-info">
          <Table2 size={16} />
          <span>{t('dataGrid.documentViewer.title', { table: tableName, defaultValue: `Chi tiết bản ghi — ${tableName}` })}</span>
          <span className="doc-table-pill">{titleInfo}</span>
        </div>
      }
      onClose={onClose}
      width="840px"
      maxWidth="94vw"
      height="75vh"
      maxHeight="88vh"
      zIndex={99998}
    >
      <div className="doc-nav-header">
        <div className="doc-nav-info">
          <span className="doc-nav-counter">
            {t('dataGrid.documentViewer.rowCounter', { current: rowIndex + 1, total: totalRows, defaultValue: `Dòng ${rowIndex + 1} / ${totalRows}` })}
          </span>
        </div>

        <div className="doc-nav-controls">
          <button
            type="button"
            className="doc-nav-btn"
            disabled={rowIndex <= 0}
            onClick={() => onNavigateRow(rowIndex - 1)}
            title={t('dataGrid.documentViewer.prevRecord', 'Dòng trước (Alt+Left)')}
          >
            <ChevronLeft size={14} />
            <span>{t('dataGrid.documentViewer.prevRecord', 'Dòng trước')}</span>
          </button>
          <button
            type="button"
            className="doc-nav-btn"
            disabled={rowIndex >= totalRows - 1}
            onClick={() => onNavigateRow(rowIndex + 1)}
            title={t('dataGrid.documentViewer.nextRecord', 'Dòng sau (Alt+Right)')}
          >
            <span>{t('dataGrid.documentViewer.nextRecord', 'Dòng sau')}</span>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Tabs bar */}
      <div className="doc-tabs-bar">
        <button
          type="button"
          className={`doc-tab-btn ${effectiveTab === 'table' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('table')}
        >
          <Table2 size={14} />
          <span>{t('dataGrid.documentViewer.tabTable', 'Bảng (Table)')}</span>
        </button>
        {hasNestedData && (
          <button
            type="button"
            className={`doc-tab-btn ${effectiveTab === 'tree' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('tree')}
          >
            <Network size={14} />
            <span>{t('dataGrid.documentViewer.tabTree', 'Cây phân cấp (Tree)')}</span>
            <span className="doc-tab-badge">{'JSON'}</span>
          </button>
        )}
        <button
          type="button"
          className={`doc-tab-btn ${effectiveTab === 'json' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('json')}
        >
          <Code2 size={14} />
          <span>{t('dataGrid.documentViewer.tabJson', 'Mã JSON')}</span>
        </button>
      </div>

      <ModalBody className="doc-modal-body">
        {/* 1. TABLE VIEW */}
        {effectiveTab === 'table' && (
          <div className="doc-table-view">
            <div className="doc-search-bar">
              <div className="doc-search-input-box">
                <Search size={13} className="doc-search-icon" />
                <input
                  type="text"
                  className="doc-search-input"
                  placeholder={t('dataGrid.documentViewer.searchColumns', 'Tìm kiếm trường / cột...')}
                  value={searchField}
                  onChange={(e) => setSearchField(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="doc-nav-info">
                <span className="doc-nav-counter">
                  {t('dataGrid.documentViewer.fieldCount', { n: filteredColumns.length })}
                </span>
              </div>
            </div>

            <div className="doc-table-scroll">
              <div className="doc-table-card">
                <table className="doc-field-table">
                  <thead>
                    <tr>
                      <th className="doc-field-th doc-field-td-key">{t('dataGrid.documentViewer.colName', 'Trường / Cột')}</th>
                      <th className="doc-field-th doc-field-td-type">{t('dataGrid.documentViewer.colType', 'Kiểu dữ liệu')}</th>
                      <th className="doc-field-th doc-field-td-val">{t('dataGrid.documentViewer.colValue', 'Giá trị')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredColumns.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="doc-empty-hint">
                          {t('dataGrid.documentViewer.noFieldsFound', 'Không tìm thấy trường nào phù hợp.')}
                        </td>
                      </tr>
                    ) : (
                      filteredColumns.map(col => {
                        const val = currentRow[col.name];
                        const isPk = col.isPrimaryKey || col.name === primaryKey;
                        const fk = foreignKeys.find(f => (f.column || '').toLowerCase() === col.name.toLowerCase());
                        const strVal = val === null || val === undefined ? '' : String(val);

                        return (
                          <tr key={col.name} className="doc-field-tr">
                            <td className="doc-field-td-key">
                              <div className="doc-field-key-wrapper">
                                <span className="doc-field-name">{col.name}</span>
                                {isPk && <span className="key-badge">{'PK'}</span>}
                                {fk && <span className="fk-badge">{'FK'}</span>}
                              </div>
                            </td>
                            <td className="doc-field-td-type">
                              <span>{col.type || 'TEXT'}</span>
                            </td>
                            <td className="doc-field-td-val">
                              <div className="doc-field-val-container">
                                <div className="doc-field-val-text">
                                  {val === null ? (
                                    <span className="grid-cell-null">{'NULL'}</span>
                                  ) : (
                                    <MediaCellPreview
                                      value={val}
                                      columnName={col.name}
                                      tableName={tableName}
                                      fallbackText={strVal}
                                    />
                                  )}
                                </div>
                                <button
                                  type="button"
                                  className="doc-field-copy-btn"
                                  onClick={() => copyToClipboard(strVal, col.name)}
                                  title={t('dataGrid.documentViewer.copyField', 'Sao chép giá trị ô')}
                                >
                                  {copiedKey === col.name ? <Check size={12} className="doc-copy-check" /> : <Copy size={12} />}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* 2. TREE VIEW */}
        {effectiveTab === 'tree' && (
          <div className="doc-tree-view">
            <div className="doc-tree-toolbar">
              <div className="doc-search-input-box">
                <Search size={13} className="doc-search-icon" />
                <input
                  type="text"
                  className="doc-search-input"
                  placeholder={t('dataGrid.documentViewer.searchColumns', 'Tìm kiếm trường / cột...')}
                  value={searchField}
                  onChange={(e) => setSearchField(e.target.value)}
                />
              </div>
              <div className="doc-nav-info">
                <span className="doc-nav-counter">
                  {t('dataGrid.documentViewer.fieldCount', { n: filteredTreeEntries.length })}
                </span>
              </div>
            </div>
            <div className="doc-tree-scroll">
              <div className="doc-tree-card">
                {filteredTreeEntries.length === 0 ? (
                  <div className="doc-empty-hint">
                    {t('dataGrid.documentViewer.noFieldsFound', 'Không tìm thấy trường nào phù hợp.')}
                  </div>
                ) : (
                  filteredTreeEntries.map(([key, val]) => (
                    <TreeNode
                      key={key}
                      label={key}
                      value={val}
                      depth={0}
                      onCopy={copyToClipboard}
                      copiedKey={copiedKey}
                      copyTitle={t('dataGrid.documentViewer.copyField', 'Sao chép giá trị ô')}
                      expandTitle={t('dataGrid.documentViewer.expandAll', 'Mở rộng')}
                      collapseTitle={t('dataGrid.documentViewer.collapseAll', 'Thu gọn')}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* 3. JSON VIEW */}
        {effectiveTab === 'json' && (
          <div className="doc-json-view">
            <div className="doc-json-toolbar">
              <div className="doc-nav-info">
                <span className="doc-nav-counter">{t('dataGrid.documentViewer.tabJson', 'Mã JSON')}</span>
              </div>
              <div className="doc-json-actions">
                <button
                  type="button"
                  className="doc-nav-btn"
                  onClick={handleBeautifyJson}
                  title={t('dataGrid.documentViewer.beautifyJson', 'Căn chỉnh JSON')}
                >
                  <Sparkles size={12} />
                  <span>{t('dataGrid.documentViewer.format', 'Định dạng')}</span>
                </button>
                <button
                  type="button"
                  className="doc-nav-btn"
                  onClick={handleMinifyJson}
                  title={t('dataGrid.documentViewer.minifyJson', 'Nén 1 dòng')}
                >
                  <Minimize2 size={12} />
                  <span>{t('dataGrid.documentViewer.minify', 'Nén')}</span>
                </button>
              </div>
            </div>
            <div className="doc-json-editor-container">
              <Editor
                height="100%"
                defaultLanguage="json"
                theme={isDark ? 'vs-dark' : 'vs'}
                value={jsonText}
                options={{
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 12.5,
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  folding: true,
                  automaticLayout: true,
                  readOnly: true,
                }}
              />
            </div>
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <button
          type="button"
          className="cm-btn"
          onClick={() => copyToClipboard(jsonText)}
        >
          {copiedAll ? <Check size={13} className="doc-copy-check" /> : <Copy size={13} />}
          <span>{t('dataGrid.documentViewer.copyJson', 'Sao chép JSON')}</span>
        </button>
        <button
          type="button"
          className="cm-btn"
          onClick={copyAsSqlInsert}
        >
          <span>{t('dataGrid.documentViewer.copySqlInsert', 'Sao chép SQL INSERT')}</span>
        </button>
        <button
          type="button"
          className="cm-btn primary"
          onClick={onClose}
        >
          {t('common.close')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
