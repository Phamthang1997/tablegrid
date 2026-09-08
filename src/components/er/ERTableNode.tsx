import React from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Eye, Key, Link2, ChevronDown, ChevronRight } from 'lucide-react';
import type { ERTable, ERNodePosition, ERDetailLevel } from './erTypes';
import type { ERLodLevel } from './erViewport';

interface ERTableNodeProps {
  table: ERTable;
  position: ERNodePosition;
  detailLevel: ERDetailLevel;
  lod: ERLodLevel;
  isSelected: boolean;
  onToggleCollapse: (tableName: string) => void;
}

/**
 * One table card.
 *
 * Everything interactive is handled by the canvas above it through `data-er-node` and a single
 * delegated listener, so this component takes exactly one callback. That is deliberate: it is
 * `React.memo`ed and mounted a few hundred times, and one unstable function prop would defeat
 * the memo for every instance on every frame the canvas re-renders.
 *
 * The hover highlight is not a prop either — the canvas writes an `hl` class straight onto
 * the elements it wants lit. Through props it was a React render plus an opacity change on
 * every mounted card each time the pointer crossed a card boundary.
 *
 * The height is set explicitly from `position` rather than left to the content, because the FK
 * connectors anchor at `position.y + HEADER_HEIGHT + index * ROW_HEIGHT` — with an implicit
 * height, any LOD level that renders fewer elements would shrink the card out from under its
 * own sockets.
 */
const ERTableNodeInner: React.FC<ERTableNodeProps> = ({
  table,
  position,
  detailLevel,
  lod,
  isSelected,
  onToggleCollapse,
}) => {
  const { t } = useTranslation();
  const isCollapsed = !!position.isCollapsed;

  let visibleColumns = table.columns;
  if (!isCollapsed) {
    if (detailLevel === 'keys_only') {
      visibleColumns = table.columns.filter((col) => col.isPrimaryKey || col.isForeignKey);
      if (visibleColumns.length === 0) visibleColumns = table.columns.slice(0, 3);
    } else if (detailLevel === 'compact') {
      visibleColumns = table.columns.slice(0, 5);
    }
  }

  const isView = table.kind === 'view';
  const showBody = !isCollapsed && lod !== 'blocks';
  const hiddenCount = table.columns.length - visibleColumns.length;

  return (
    <div
      data-er-node={table.name}
      className={`er-table-node lod-${lod} ${isSelected ? 'selected' : ''}`}
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        width: `${position.width}px`,
        height: `${position.height}px`,
      }}
    >
      {/* Table Header */}
      <div className={`er-node-header ${isView ? 'view-header' : ''}`}>
        <div className="er-node-title-group">
          {lod === 'full' &&
            (isView ? (
              <Eye size={13} className="er-icon-view" />
            ) : (
              <Database size={13} className="er-icon-table" />
            ))}
          <span className="er-node-title" title={table.name}>
            {table.name}
          </span>
        </div>

        {lod !== 'blocks' && (
          <div className="er-node-actions">
            <span
              className="er-node-col-count"
              title={t('er.colCountTitle', { n: table.columns.length })}
            >
              {table.columns.length}
            </span>
            <button
              type="button"
              className="er-node-collapse-btn"
              // The canvas decides drags from its own pointerdown; without this the button
              // would also start a node drag and the click would never land.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapse(table.name);
              }}
              title={isCollapsed ? t('er.expandTable') : t('er.collapseTable')}
            >
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          </div>
        )}
      </div>

      {/* Columns. At `names` a row is one element holding its own text: the badges are <svg>s
          with several children each, and below ~0.6 zoom none of them is legible anyway. */}
      {showBody &&
        (lod === 'names' ? (
          <div className="er-node-columns">
            {visibleColumns.map((col) => (
              <div
                key={col.name}
                className={`er-column-row plain ${col.isPrimaryKey ? 'pk-row' : ''} ${col.isForeignKey ? 'fk-row' : ''}`}
              >
                {col.name}
              </div>
            ))}
          </div>
        ) : (
          <div className="er-node-columns">
            {visibleColumns.map((col) => (
              <div
                key={col.name}
                className={`er-column-row ${col.isPrimaryKey ? 'pk-row' : ''} ${col.isForeignKey ? 'fk-row' : ''}`}
                title={
                  col.refTable
                    ? t('er.fkColumnHint', {
                        column: col.name,
                        target: `${col.refTable}.${col.refColumn || col.name}`,
                      })
                    : col.comment || undefined
                }
              >
                <div className="er-col-left">
                  {col.isPrimaryKey && (
                    <span title={t('er.primaryKey')}>
                      <Key size={11} className="er-badge-pk" />
                    </span>
                  )}
                  {col.isForeignKey && !col.isPrimaryKey && (
                    <span title={t('er.foreignKeyTo', { table: col.refTable || '' })}>
                      <Link2 size={11} className="er-badge-fk" />
                    </span>
                  )}
                  {!col.isPrimaryKey && !col.isForeignKey && <span className="er-col-bullet">•</span>}
                  <span className={`er-col-name ${col.isPrimaryKey ? 'bold' : ''}`}>{col.name}</span>
                </div>

                <div className="er-col-right">
                  <span className="er-col-type" title={col.type}>
                    {col.type}
                  </span>
                  {col.nullable === false && (
                    <span className="er-col-req-dot" title={t('er.notNull')} />
                  )}
                </div>
              </div>
            ))}

            {detailLevel !== 'full' && hiddenCount > 0 && (
              <div className="er-col-more">{t('er.moreColumns', { n: hiddenCount })}</div>
            )}
          </div>
        ))}
    </div>
  );
};

export const ERTableNode = React.memo(ERTableNodeInner);
