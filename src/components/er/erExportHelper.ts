/**
 * ER Diagram Export Helper.
 * Handles exporting ER diagrams into high-resolution PNG, Vector SVG,
 * Mermaid ER Markdown, DBML (dbdiagram.io), and DDL SQL scripts.
 */

import type { ERTable, ERRelationship, ERLayoutPositions, ERDetailLevel } from './erTypes';
import {
  computeDiagramBounds,
  getColumnSocketPosition,
  computeBezierPath,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  DEFAULT_NODE_WIDTH,
  calculateNodeDimensions,
} from './erLayoutEngine';

/**
 * Mermaid's default render limits (`maxTextSize`, `maxEdges`). A diagram over either is refused
 * with "Maximum text size in diagram exceeded" — by GitHub, Notion and anything else embedding
 * Mermaid with its defaults — so a whole-database export past them copies fine and renders nowhere.
 */
export const MERMAID_MAX_TEXT = 50_000;
export const MERMAID_MAX_EDGES = 500;

/** An identifier Mermaid takes bare: entity and attribute names outside it need care. */
const MERMAID_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * An attribute TYPE as Mermaid accepts it: it must start with a letter and may hold letters,
 * digits, `_`, `-`, parentheses and square brackets. `varchar(255)` survives as is (the old export
 * wrote `varchar_255_`); a space, a comma or a quote becomes `_`, and an `enum('a','b')` list,
 * which cannot be spelt at all, becomes plain `enum`.
 */
export function mermaidType(type: string): string {
  let t = type.trim();
  if (/^(enum|set)\s*\(/i.test(t)) t = t.slice(0, t.indexOf('(')).trim();
  t = t.replace(/[^A-Za-z0-9_\-()[\]]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!t) return 'text';
  return /^[A-Za-z]/.test(t) ? t : `t_${t}`;
}

/** Text inside a Mermaid double-quoted string: it has no escape for `"`, and a newline ends it. */
function mermaidString(text: string, max = 120): string {
  const s = text.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Generates a Mermaid `erDiagram` for `tables` and the relationships between them.
 *
 * What the old version got wrong, each of which made Mermaid reject the whole diagram or say
 * something the schema does not:
 *  - names were written raw, so `bookings.flights`, a space, a hyphen or a Vietnamese name was a
 *    syntax error. A name that is not a plain word now gets a safe id plus an alias,
 *    `t1["Khách hàng"]`, and an attribute name that is not one is sanitised with the original kept
 *    in its comment;
 *  - every relationship was `||--o{`. The parent side is now `|o` when the FK column allows
 *    NULL, the child side `o|` when that column is the child's whole primary key (one-to-one),
 *    and the line is solid (identifying) only when the FK is part of the child's key;
 *  - relationships to tables not in the export were written anyway, so exporting a filtered or
 *    selected view drew empty stub entities; a composite FK drew one line per column;
 *  - column comments were dropped (Mermaid shows them after the key markers).
 */
export function exportToMermaid(tables: ERTable[], relationships: ERRelationship[]): string {
  // Stable, unique ids: the real name when Mermaid takes it bare, otherwise a sanitised form.
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const table of tables) {
    let id = MERMAID_WORD.test(table.name)
      ? table.name
      : table.name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^([^A-Za-z_])/, 't_$1') || 't';
    if (taken.has(id)) {
      let n = 2;
      while (taken.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    taken.add(id);
    ids.set(table.name, id);
  }
  const byName = new Map(tables.map((tb) => [tb.name, tb]));

  const lines: string[] = ['erDiagram'];

  for (const table of tables) {
    const id = ids.get(table.name)!;
    const head = id === table.name ? id : `${id}["${mermaidString(table.name, 200)}"]`;
    lines.push(`    ${head} {`);
    for (const col of table.columns) {
      const keys = [col.isPrimaryKey && 'PK', col.isForeignKey && 'FK'].filter(Boolean).join(', ');
      const name = MERMAID_WORD.test(col.name)
        ? col.name
        : col.name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^([^A-Za-z_])/, 'c_$1') || 'column';
      const notes = [name !== col.name ? col.name : '', col.comment ?? ''].filter(Boolean).join(' — ');
      let line = `        ${mermaidType(col.type)} ${name}`;
      if (keys) line += ` ${keys}`;
      if (notes) line += ` "${mermaidString(notes)}"`;
      lines.push(line);
    }
    lines.push('    }');
  }

  // One line per constraint between two exported tables: a composite FK arrives as one
  // relationship per column.
  const seen = new Set<string>();
  for (const rel of relationships) {
    const child = byName.get(rel.sourceTable);
    const parent = byName.get(rel.targetTable);
    if (!child || !parent) continue;
    const key = `${rel.sourceTable}\u0000${rel.targetTable}\u0000${rel.name ?? rel.sourceColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fkCol = child.columns.find((c) => c.name === rel.sourceColumn);
    const childPk = child.columns.filter((c) => c.isPrimaryKey);
    const optional = fkCol?.nullable === true;
    const oneToOne = childPk.length === 1 && childPk[0].name === rel.sourceColumn;
    const identifying = fkCol?.isPrimaryKey === true;
    const parentEnd = optional ? '|o' : '||';
    const childEnd = oneToOne ? 'o|' : 'o{';
    const label = mermaidString(rel.name || `${rel.sourceColumn} → ${rel.targetColumn}`);
    lines.push(
      `    ${ids.get(parent.name)} ${parentEnd}${identifying ? '--' : '..'}${childEnd} ${ids.get(child.name)} : "${label}"`
    );
  }

  return lines.join('\n');
}

/** Whether Mermaid, with its default limits, would refuse to render this diagram. */
export function mermaidTooLarge(text: string): boolean {
  if (text.length > MERMAID_MAX_TEXT) return true;
  let edges = 0;
  for (const line of text.split('\n')) if (/\s(?:\|\||\|o|\}o|\}\|)(?:--|\.\.)/.test(line)) edges++;
  return edges > MERMAID_MAX_EDGES;
}

function escapeSingleQuote(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates DBML (Database Markup Language) format for dbdiagram.io / dbdocs.io.
 */
export function exportToDbml(tables: ERTable[], relationships: ERRelationship[]): string {
  const lines: string[] = [];
  lines.push('// Generated by TableGrid ER Visualizer');

  tables.forEach((table) => {
    lines.push(`Table ${table.name} {`);
    table.columns.forEach((col) => {
      const settings: string[] = [];
      if (col.isPrimaryKey) settings.push('pk');
      if (col.nullable === false) settings.push('not null');
      if (col.comment) settings.push(`note: '${escapeSingleQuote(col.comment)}'`);

      const settingStr = settings.length > 0 ? ` [${settings.join(', ')}]` : '';
      lines.push(`  ${col.name} ${col.type}${settingStr}`);
    });
    lines.push('}\n');
  });

  relationships.forEach((rel) => {
    lines.push(`Ref: ${rel.sourceTable}.${rel.sourceColumn} > ${rel.targetTable}.${rel.targetColumn}`);
  });

  return lines.join('\n');
}

/**
 * Generates SQL DDL script sorted by table dependency.
 */
export function exportToSql(tables: ERTable[], relationships: ERRelationship[]): string {
  const lines: string[] = [];
  lines.push('-- ==========================================================');
  lines.push('-- Database Schema DDL Export');
  lines.push(`-- Generated: ${new Date().toLocaleString()}`);
  lines.push('-- ==========================================================\n');

  tables.forEach((table) => {
    lines.push(`CREATE TABLE IF NOT EXISTS \`${table.name}\` (`);
    const colDefs: string[] = [];

    table.columns.forEach((col) => {
      let def = `  \`${col.name}\` ${col.type}`;
      if (col.nullable === false) def += ' NOT NULL';
      if (col.comment) def += ` COMMENT '${escapeSingleQuote(col.comment)}'`;
      colDefs.push(def);
    });

    const pks = table.columns.filter((col) => col.isPrimaryKey).map((col) => `\`${col.name}\``);
    if (pks.length > 0) {
      colDefs.push(`  PRIMARY KEY (${pks.join(', ')})`);
    }

    lines.push(colDefs.join(',\n'));
    lines.push(');\n');
  });

  if (relationships.length > 0) {
    lines.push('-- Foreign Key Constraints');
    relationships.forEach((rel) => {
      const fkName = rel.name || `fk_${rel.sourceTable}_${rel.sourceColumn}`;
      lines.push(
        `ALTER TABLE \`${rel.sourceTable}\` ADD CONSTRAINT \`${fkName}\` FOREIGN KEY (\`${rel.sourceColumn}\`) REFERENCES \`${rel.targetTable}\` (\`${rel.targetColumn}\`);`
      );
    });
  }

  return lines.join('\n');
}

/**
 * Generates a complete, standalone SVG document containing both table nodes and relationship lines,
 * tightly fitted to the diagram bounds.
 */
export function generateFullDiagramSvg(
  tables: ERTable[],
  relationships: ERRelationship[],
  positions: ERLayoutPositions,
  detailLevel: ERDetailLevel = 'full',
  theme: 'dark' | 'light' = 'dark'
): { svgString: string; width: number; height: number } {
  const placedTables = tables.filter((t) => !!positions[t.name]);
  if (placedTables.length === 0) {
    return {
      svgString: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="100%" height="100%" fill="#0f172a"/><text x="300" y="200" fill="#94a3b8" text-anchor="middle" font-family="sans-serif">No tables to display</text></svg>`,
      width: 600,
      height: 400,
    };
  }

  const bounds = computeDiagramBounds(positions);
  const padding = 60;
  const width = Math.max(bounds.width + padding * 2, 400);
  const height = Math.max(bounds.height + padding * 2, 300);
  const offsetX = -bounds.minX + padding;
  const offsetY = -bounds.minY + padding;

  const isDark = theme === 'dark';
  const colors = isDark
    ? {
        bg: '#0f172a',
        cardBg: '#1e293b',
        cardBorder: '#334155',
        headerBg: '#182234',
        headerViewBg: '#1e1b4b',
        title: '#f8fafc',
        textPrimary: '#e2e8f0',
        textSecondary: '#94a3b8',
        rowBorder: '#273549',
        badgeBg: '#334155',
        pk: '#f59e0b',
        fk: '#3b82f6',
        relLine: '#3b82f6',
      }
    : {
        bg: '#f8fafc',
        cardBg: '#ffffff',
        cardBorder: '#cbd5e1',
        headerBg: '#f1f5f9',
        headerViewBg: '#e0e7ff',
        title: '#0f172a',
        textPrimary: '#1e293b',
        textSecondary: '#64748b',
        rowBorder: '#f1f5f9',
        badgeBg: '#e2e8f0',
        pk: '#d97706',
        fk: '#2563eb',
        relLine: '#2563eb',
      };

  const tableMap = new Map<string, ERTable>();
  placedTables.forEach((t) => tableMap.set(t.name, t));

  const svgParts: string[] = [];

  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>`,
    `  .er-text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }`,
    `  .er-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }`,
    `</style>`,
    `<defs>`,
    `  <marker id="er-export-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`,
    `    <path d="M 0 1 L 8 5 L 0 9 z" fill="${colors.relLine}" />`,
    `  </marker>`,
    `  <marker id="er-export-dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5">`,
    `    <circle cx="5" cy="5" r="3" fill="${colors.relLine}" />`,
    `  </marker>`,
    `  <filter id="er-shadow" x="-5%" y="-5%" width="115%" height="115%">`,
    `    <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="0.2" />`,
    `  </filter>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="${colors.bg}" />`,
    `<g transform="translate(${offsetX}, ${offsetY})">`
  );

  // 1. Draw Relationship Lines
  relationships.forEach((rel) => {
    const srcTable = tableMap.get(rel.sourceTable);
    const tgtTable = tableMap.get(rel.targetTable);
    const srcPos = positions[rel.sourceTable];
    const tgtPos = positions[rel.targetTable];
    if (!srcTable || !tgtTable || !srcPos || !tgtPos) return;

    const isSourceLeftOfTarget = srcPos.x + srcPos.width < tgtPos.x;
    const isTargetLeftOfSource = tgtPos.x + tgtPos.width < srcPos.x;
    let sourceSide: 'left' | 'right' = 'right';
    let targetSide: 'left' | 'right' = 'left';

    if (isSourceLeftOfTarget) {
      sourceSide = 'right';
      targetSide = 'left';
    } else if (isTargetLeftOfSource) {
      sourceSide = 'left';
      targetSide = 'right';
    } else {
      sourceSide = 'right';
      targetSide = 'right';
    }

    const srcSocket = getColumnSocketPosition(srcPos, srcTable, rel.sourceColumn, sourceSide, detailLevel);
    const tgtSocket = getColumnSocketPosition(tgtPos, tgtTable, rel.targetColumn, targetSide, detailLevel);
    const d = computeBezierPath(srcSocket, tgtSocket);

    svgParts.push(
      `<path d="${d}" stroke="${colors.relLine}" stroke-width="1.75" stroke-opacity="0.85" fill="none" marker-start="url(#er-export-dot)" marker-end="url(#er-export-arrow)" />`
    );
  });

  // 2. Draw Table Nodes
  placedTables.forEach((table) => {
    const pos = positions[table.name];
    if (!pos) return;

    const isCollapsed = !!pos.isCollapsed;
    const dims = calculateNodeDimensions(table, detailLevel, isCollapsed);
    const nodeWidth = pos.width || dims.width || DEFAULT_NODE_WIDTH;
    const nodeHeight = pos.height || dims.height;
    const isView = table.kind === 'view';

    svgParts.push(`<g transform="translate(${pos.x}, ${pos.y})">`);
    // Card background
    svgParts.push(
      `<rect width="${nodeWidth}" height="${nodeHeight}" rx="8" fill="${colors.cardBg}" stroke="${colors.cardBorder}" stroke-width="1" filter="url(#er-shadow)" />`
    );

    // Header background
    const headerBg = isView ? colors.headerViewBg : colors.headerBg;
    svgParts.push(
      `<path d="M 0 8 Q 0 0 8 0 L ${nodeWidth - 8} 0 Q ${nodeWidth} 0 ${nodeWidth} 8 L ${nodeWidth} ${HEADER_HEIGHT} L 0 ${HEADER_HEIGHT} Z" fill="${headerBg}" />`,
      `<line x1="0" y1="${HEADER_HEIGHT}" x2="${nodeWidth}" y2="${HEADER_HEIGHT}" stroke="${colors.cardBorder}" stroke-width="1" />`
    );

    // Table title
    svgParts.push(
      `<text class="er-text" x="12" y="24" font-size="12" font-weight="600" fill="${colors.title}">${escapeXml(table.name)}</text>`
    );

    // Column count badge
    const badgeText = String(table.columns.length);
    const badgeWidth = Math.max(badgeText.length * 7 + 10, 22);
    const badgeX = nodeWidth - badgeWidth - 10;
    svgParts.push(
      `<rect x="${badgeX}" y="11" width="${badgeWidth}" height="16" rx="8" fill="${colors.badgeBg}" />`,
      `<text class="er-text" x="${badgeX + badgeWidth / 2}" y="23" font-size="10" font-weight="600" fill="${colors.textSecondary}" text-anchor="middle">${badgeText}</text>`
    );

    // Columns
    if (!isCollapsed) {
      let visibleCols = table.columns;
      if (detailLevel === 'keys_only') {
        visibleCols = table.columns.filter((c) => c.isPrimaryKey || c.isForeignKey);
        if (visibleCols.length === 0) visibleCols = table.columns.slice(0, 3);
      } else if (detailLevel === 'compact') {
        visibleCols = table.columns.slice(0, 5);
      }

      visibleCols.forEach((col, idx) => {
        const rowY = HEADER_HEIGHT + idx * ROW_HEIGHT;

        if (idx > 0) {
          svgParts.push(
            `<line x1="0" y1="${rowY}" x2="${nodeWidth}" y2="${rowY}" stroke="${colors.rowBorder}" stroke-width="0.75" />`
          );
        }

        if (col.isPrimaryKey) {
          svgParts.push(
            `<rect x="1" y="${rowY}" width="${nodeWidth - 2}" height="${ROW_HEIGHT}" fill="${colors.pk}" fill-opacity="0.08" />`
          );
        } else if (col.isForeignKey) {
          svgParts.push(
            `<rect x="1" y="${rowY}" width="${nodeWidth - 2}" height="${ROW_HEIGHT}" fill="${colors.fk}" fill-opacity="0.06" />`
          );
        }

        let colNameX = 12;
        if (col.isPrimaryKey && col.isForeignKey) {
          svgParts.push(
            `<text class="er-text" x="10" y="${rowY + 16}" font-size="8.5" font-weight="700" fill="${colors.pk}">PK</text>`,
            `<text class="er-text" x="25" y="${rowY + 16}" font-size="8.5" font-weight="700" fill="${colors.fk}">FK</text>`
          );
          colNameX = 42;
        } else if (col.isPrimaryKey) {
          svgParts.push(
            `<text class="er-text" x="10" y="${rowY + 16}" font-size="9" font-weight="700" fill="${colors.pk}">PK</text>`
          );
          colNameX = 28;
        } else if (col.isForeignKey) {
          svgParts.push(
            `<text class="er-text" x="10" y="${rowY + 16}" font-size="9" font-weight="700" fill="${colors.fk}">FK</text>`
          );
          colNameX = 28;
        } else {
          svgParts.push(
            `<circle cx="14" cy="${rowY + 12}" r="2" fill="${colors.textSecondary}" fill-opacity="0.4" />`
          );
          colNameX = 24;
        }

        const fontWt = col.isPrimaryKey ? '600' : '400';
        svgParts.push(
          `<text class="er-mono" x="${colNameX}" y="${rowY + 16}" font-size="11" font-weight="${fontWt}" fill="${colors.textPrimary}">${escapeXml(col.name)}</text>`,
          `<text class="er-mono" x="${nodeWidth - 12}" y="${rowY + 16}" font-size="10" fill="${colors.textSecondary}" text-anchor="end">${escapeXml(col.type)}</text>`
        );
      });

      if (detailLevel !== 'full' && table.columns.length > visibleCols.length) {
        const remaining = table.columns.length - visibleCols.length;
        const moreY = HEADER_HEIGHT + visibleCols.length * ROW_HEIGHT + 14;
        svgParts.push(
          `<text class="er-text" x="12" y="${moreY}" font-size="10" fill="${colors.textSecondary}" font-style="italic">+ ${remaining} more columns...</text>`
        );
      }
    }

    svgParts.push(`</g>`);
  });

  svgParts.push(`</g>`, `</svg>`);

  return {
    svgString: svgParts.join('\n'),
    width,
    height,
  };
}

/**
 * Renders SVG markup into a high-resolution PNG blob and data URL.
 */
export async function exportDiagramToPng(
  svgString: string,
  width: number,
  height: number,
  scale: number = 2.0,
  backgroundColor: string = '#0f172a'
): Promise<{ blob: Blob; dataUrl: string }> {
  // Base64 encoding the SVG ensures no CORS / security taint across browser webviews
  const encodedSvg = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Clamp canvas dimension to safe browser memory limits
      const maxDim = 8192;
      let targetScale = scale;
      if (width * targetScale > maxDim || height * targetScale > maxDim) {
        targetScale = Math.min(maxDim / width, maxDim / height);
      }

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * targetScale);
      canvas.height = Math.round(height * targetScale);

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get 2D canvas context'));
        return;
      }

      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(targetScale, targetScale);
      ctx.drawImage(img, 0, 0);

      try {
        const dataUrl = canvas.toDataURL('image/png');
        canvas.toBlob((blob) => {
          if (blob) {
            resolve({ blob, dataUrl });
          } else {
            // Fallback: decode dataURL to Blob directly if toBlob returns null
            try {
              const arr = dataUrl.split(',');
              const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png';
              const bstr = atob(arr[1]);
              let n = bstr.length;
              const u8arr = new Uint8Array(n);
              while (n--) {
                u8arr[n] = bstr.charCodeAt(n);
              }
              resolve({ blob: new Blob([u8arr], { type: mime }), dataUrl });
            } catch {
              reject(new Error('Canvas to Blob conversion failed'));
            }
          }
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = () => {
      reject(new Error('Failed to load SVG image for canvas rendering'));
    };

    img.src = encodedSvg;
  });
}

/**
 * Captures diagram SVG element and renders into PNG blob (backwards-compatible wrapper).
 */
export async function captureDiagramToPng(
  svgElement: SVGSVGElement,
  scale: number = 2.0,
  backgroundColor: string = '#0f172a'
): Promise<{ blob: Blob; dataUrl: string }> {
  const rawWidth = svgElement.clientWidth || svgElement.viewBox?.baseVal?.width || 1200;
  const rawHeight = svgElement.clientHeight || svgElement.viewBox?.baseVal?.height || 800;
  // Protect against huge 50000x50000 canvas allocations
  const width = Math.min(rawWidth, 4096);
  const height = Math.min(rawHeight, 4096);

  const svgXml = new XMLSerializer().serializeToString(svgElement);
  return exportDiagramToPng(svgXml, width, height, scale, backgroundColor);
}

/**
 * Downloads a string or blob content as a file.
 */
export function downloadFile(content: string | Blob, fileName: string, mimeType: string) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
