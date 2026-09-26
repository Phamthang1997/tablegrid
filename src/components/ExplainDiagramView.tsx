import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExplainFlag, ExplainNode, ExplainResult } from '../utils/explainHelper';
import { edgeRows, flagSeverity, planFieldText, summarizePlan } from '../utils/explainHelper';
import { flagLabelKey } from './explainLabels';
import {
  ArrowDownAZ, Box, Combine, Database, Filter, Hash, KeyRound, Layers,
  LayoutGrid, Repeat, Rows3, Search, Sigma, Table, BarChart2, Clock, FileText, X,
  TriangleAlert, CircleCheck, CircleMinus, Settings2, Braces, ZoomIn, ZoomOut, RotateCcw,
  Download, ChevronDown, Flame, Maximize, OctagonAlert, Lightbulb,
} from 'lucide-react';
import { pickSaveFilePath, saveExportFileAtPath } from '../utils/fileSave';

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.2;

const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));

/** Below this, a plan opens at 100% and scrolls instead: 11.5px titles stop being readable. */
const AUTO_FIT_MIN = 0.65;
/** Pixels a press has to travel before it stops being a click and becomes a pan. */
const PAN_THRESHOLD = 4;
/** The summary names the costliest operator only when it stands out from the rest. */
const HOT_MIN_PCT = 5;
/** The canvas padding (`.explain-canvas`), both sides summed — the fit has to leave room for it. */
const CANVAS_PAD_X = 48;
const CANVAS_PAD_Y = 80;

// The diagram's size at 100%. Measured, because rows take the height of their content: the
// bounding rect is the zoomed size on screen, so dividing by the zoom it was drawn at undoes it.
function diagramNaturalSize(target: HTMLElement | null, zoom: number): { w: number; h: number } | null {
  if (!target || zoom <= 0) return null;
  const rect = target.getBoundingClientRect();
  return { w: rect.width / zoom, h: rect.height / zoom };
}

// The largest zoom (never above 100%) at which the whole diagram fits in the canvas.
function fitZoomFor(canvas: HTMLElement | null, size: { w: number; h: number } | null): number | null {
  if (!canvas || !size || size.w <= 0 || size.h <= 0) return null;
  const z = Math.min(
    (canvas.clientWidth - CANVAS_PAD_X) / size.w,
    (canvas.clientHeight - CANVAS_PAD_Y) / size.h,
  );
  return Number.isFinite(z) && z > 0 ? clampZoom(Math.min(1, z)) : null;
}

// Costs span a huge range: keep two decimals where they carry information and drop them once the
// integer part is all anyone reads.
function formatCost(value: number, locale: string): string {
  if (value >= 1000) return value.toLocaleString(locale, { maximumFractionDigits: 0 });
  return value.toFixed(2);
}

// Raw plan fields the panel already renders as their own labelled row, plus the two blobs that
// belong in the Raw tab. Everything else is listed verbatim, so no field is silently dropped.
const PANEL_SURFACED_FIELDS = new Set([
  'table', 'table_name', 'TABLE',
  'key', 'KEY', 'possible_keys', 'POSSIBLE_KEYS',
  'rows_examined_per_scan', 'rows_produced_per_join', 'rows', 'ROWS',
  'attached_condition', 'Filter', 'Extra', 'EXTRA', 'message',
  'Node Type', 'Relation Name', 'Alias', 'Index Name', 'Index Cond',
  'Plan Rows', 'Actual Rows', 'Actual Loops',
  'Startup Cost', 'Total Cost', 'Actual Startup Time', 'Actual Total Time',
  'rawLine', 'raw',
  'access_type', 'used_key_parts', 'used_columns', 'data_read_per_join', 'filtered', 'cost_info',
]);

// "a, fa ⋈ s" — which tables this join step combines. Long left sides are abbreviated so the
// node cell stays one line; the full list is in the detail panel.
function joinSummary(node: ExplainNode, maxLeft = 2): string {
  const join = node.joinTables;
  if (!join) return '';
  const left = join.left.length > maxLeft
    ? `${join.left.slice(0, maxLeft).join(', ')}, +${join.left.length - maxLeft}`
    : join.left.join(', ');
  return join.right ? `${left} ⋈ ${join.right}` : left;
}

function getDetailField(node: ExplainNode, key: string): any {
  if (node.details?.[key] !== undefined) return node.details[key];
  if (node.details?.cost_info?.[key] !== undefined) return node.details.cost_info[key];
  if (node.children?.[0]?.details?.[key] !== undefined) return node.children[0].details[key];
  if (node.children?.[0]?.details?.cost_info?.[key] !== undefined) return node.children[0].details.cost_info[key];
  return undefined;
}

function remainingFields(node: ExplainNode): [string, string][] {
  return Object.entries(node.details || {})
    .filter(([key]) => !PANEL_SURFACED_FIELDS.has(key))
    .map(([key, value]) => [key, planFieldText(value)] as [string, string | null])
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '');
}

interface ExplainDiagramViewProps {
  result: ExplainResult;
  /** MySQL tabular EXPLAIN carries no cost — offer a re-run that does. */
  onRequestJsonPlan?: () => void;
  /** How many index suggestions the plan has; the summary strip links to them when non-zero. */
  indexSuggestionCount?: number;
  onShowIndexSuggestions?: () => void;
}

// The flow is laid out right-to-left: leaves on the right, the consuming SELECT on the left.
// Every cell starts at the top of its row and puts its icon ICON_CY below that, so a parent and
// its first child line up however tall either one's text is — which is what keeps the top row
// straight while letting each row be only as tall as what it holds. A fixed row height used to
// do that job, and it left the arrows sitting halfway down the cell under the icon, plus a band
// of empty space under every short node.
const NODE_W = 160;
const CONN_W = 90;
/**
 * Icon centre measured from the top of a node cell. Must match `.explain-node` in index.css:
 * border 1 + padding-top 4 + badge row 16 + gap 3 + icon margin-top 2 + half the 40px icon.
 */
const ICON_CY = 46;
/** The exported image keeps a uniform grid: row pitch and node box height. */
const ROW_H = 152;
const SVG_NODE_H = 120;

function operatorIcon(type: string) {
  const s = type.toLowerCase();
  if (s === 'select') return LayoutGrid;
  if (s.includes('stream')) return Braces;
  if (s.includes('nested loop')) return Repeat;
  if (s.includes('fulltext')) return Search;
  if (s.includes('lookup') || s.includes('constant row') || s.includes('system row')) return KeyRound;
  if (s.includes('hash')) return Hash;
  if (s.includes('merge')) return Combine;
  if (s.includes('sort') || s.includes('order')) return ArrowDownAZ;
  if (s.includes('group') || s.includes('aggregate')) return Sigma;
  if (s.includes('distinct')) return Layers;
  if (s.includes('filter')) return Filter;
  if (s.includes('search')) return KeyRound;
  if (s.includes('index')) return Rows3;
  if (s.includes('materiali')) return Database;
  if (s.includes('scan')) return Table;
  if (s.includes('plan') || s.includes('execute query')) return LayoutGrid;
  return Box;
}

function operatorIconColor(type: string): string {
  const s = type.toLowerCase();
  if (s === 'select' || s.includes('plan') || s.includes('execute query')) return '#2563eb';
  if (s.includes('nested loop') || s.includes('hash join') || s.includes('merge') || s.includes('combine') || s.includes('join')) return '#0284c7';
  if (s.includes('table scan') || s.includes('scan')) return '#ea580c';
  if (s.includes('lookup') || s.includes('index') || s.includes('search') || s.includes('constant') || s.includes('system')) return '#10b981';
  if (s.includes('sort') || s.includes('order') || s.includes('group') || s.includes('aggregate')) return '#8b5cf6';
  if (s.includes('filter') || s.includes('distinct')) return '#f43f5e';
  if (s.includes('materiali') || s.includes('stream')) return '#6366f1';
  return '#3b82f6';
}

function findNode(node: ExplainNode, id: string | null): ExplainNode | null {
  if (!id) return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

interface FlowContext {
  totalSelfCost: number;
  selectedId: string | null;
  onSelect: (node: ExplainNode) => void;
  locale: string;
  flagLabel: (flag: ExplainFlag) => string;
  costLabel: string;
  /** Largest edge row count in the plan — connector widths are scaled against it. */
  maxRows: number;
}

interface SvgNodeLayout {
  node: ExplainNode;
  x: number;
  y: number;
  width: number;
  height: number;
  children: SvgNodeLayout[];
}

function operatorSvgPath(type: string): string {
  const s = type.toLowerCase();
  if (s === 'select' || s.includes('plan') || s.includes('execute query')) {
    // LayoutGrid
    return '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>';
  }
  if (s.includes('stream')) {
    // Braces
    return '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>';
  }
  if (s.includes('nested loop') || s.includes('join')) {
    // Repeat
    return '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>';
  }
  if (s.includes('fulltext')) {
    // Search
    return '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>';
  }
  if (s.includes('lookup') || s.includes('constant row') || s.includes('system row') || s.includes('key')) {
    // KeyRound
    return '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>';
  }
  if (s.includes('hash')) {
    // Hash
    return '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>';
  }
  if (s.includes('merge') || s.includes('combine')) {
    // Combine
    return '<rect width="8" height="8" x="2" y="2" rx="2"/><path d="M14 2c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2"/><path d="M20 2c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2"/><path d="M10 18H5c-1.7 0-3-1.3-3-3v-1"/><polyline points="7 21 10 18 7 15"/><rect width="8" height="8" x="14" y="14" rx="2"/>';
  }
  if (s.includes('sort') || s.includes('order')) {
    // ArrowDownAZ
    return '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M20 8h-5"/><path d="M15 10V6.5a2.5 2.5 0 0 1 5 0V10"/><path d="M15 14h5l-5 6h5"/>';
  }
  if (s.includes('group') || s.includes('aggregate')) {
    // Sigma
    return '<path d="M18 7V4H6l6 8-6 8h12v-3"/>';
  }
  if (s.includes('distinct') || s.includes('layers')) {
    // Layers
    return '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>';
  }
  if (s.includes('filter')) {
    // Filter
    return '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>';
  }
  if (s.includes('index')) {
    // Rows3
    return '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M21 9H3"/><path d="M21 15H3"/>';
  }
  if (s.includes('materiali') || s.includes('database')) {
    // Database
    return '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>';
  }
  if (s.includes('scan') || s.includes('table')) {
    // Table
    return '<path d="M12 3v18"/><path d="M3 9h18"/><path d="M3 15h18"/><rect width="18" height="18" x="3" y="3" rx="2"/>';
  }
  // Box
  return '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>';
}

function wrapNodeText(text: string, maxChars = 20, maxLines = 3): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if ((current + (current ? ' ' : '') + word).length <= maxChars) {
      current += (current ? ' ' : '') + word;
    } else {
      if (current) lines.push(current);
      if (lines.length >= maxLines - 1) {
        current = word;
        break;
      }
      current = word;
    }
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }
  return lines;
}

function calculateSvgLayout(
  node: ExplainNode,
  depth = 0,
  rowCounter = { count: 0 }
): SvgNodeLayout {
  const nodeW = NODE_W;
  const nodeH = SVG_NODE_H;
  const rowH = ROW_H;
  const connW = CONN_W;

  const children = (node.children || []).map(child =>
    calculateSvgLayout(child, depth + 1, rowCounter)
  );

  let y: number;
  if (children.length === 0) {
    y = rowCounter.count * rowH + (rowH - nodeH) / 2;
    rowCounter.count++;
  } else if (children.length === 1) {
    y = children[0].y;
  } else {
    const minY = children[0].y;
    const maxY = children[children.length - 1].y;
    y = (minY + maxY) / 2;
  }

  const x = depth * (nodeW + connW);

  return {
    node,
    x,
    y,
    width: nodeW,
    height: nodeH,
    children,
  };
}

function getSvgBounds(layout: SvgNodeLayout): { maxX: number; maxY: number } {
  let maxX = layout.x + layout.width;
  let maxY = layout.y + layout.height;
  for (const child of layout.children) {
    const b = getSvgBounds(child);
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return { maxX, maxY };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgPercentStyle(pct: number): { color: string; background: string } {
  if (pct >= 25) return { color: '#dc2626', background: 'rgba(220, 38, 38, 0.14)' };
  if (pct >= 15) return { color: '#d97706', background: 'rgba(217, 119, 6, 0.14)' };
  if (pct >= 5) return { color: '#16a34a', background: 'rgba(22, 163, 74, 0.14)' };
  return {
    color: '#475569',
    background: 'rgba(100, 116, 139, 0.12)',
  };
}

function buildExplainSvgDocument(
  rootNode: ExplainNode,
  totalSelfCost: number,
  locale: string,
  costLabel = 'Cost'
): string {
  // Always drawn on white, whatever the app theme: an exported image lands in documents and
  // tickets, so these colours are fixed rather than read from the --win-* tokens.
  const colors = {
    bg: '#ffffff',
    textPrimary: '#0f172a',
    textSecondary: '#334155',
    textDisabled: '#64748b',
    line: '#a3b0c2',
    heavy: '#f59e0b',
    danger: '#dc2626',
  };
  const font = 'Inter, system-ui, -apple-system, sans-serif';

  const layout = calculateSvgLayout(rootNode);
  const bounds = getSvgBounds(layout);

  const paddingX = 36;
  const paddingTop = 36;
  const paddingBottom = 48;
  const svgWidth = Math.ceil(bounds.maxX + paddingX * 2);
  const svgHeight = Math.ceil(bounds.maxY + paddingTop + paddingBottom);

  // Same tile and edge geometry as the on-screen diagram (`.explain-node-icon`, `Connector`).
  const ICON = 40;
  const ICON_TOP = 22;
  const iconMid = ICON_TOP + ICON / 2;

  let maxRows = 0;
  const scanRows = (item: SvgNodeLayout) => {
    const rows = edgeRows(item.node);
    if (rows !== undefined && rows > maxRows) maxRows = rows;
    item.children.forEach(scanRows);
  };
  scanRows(layout);

  // One gradient per operator colour, shared by every node of that colour.
  const gradients = new Map<string, string>();
  const gradientFor = (color: string) => {
    let id = gradients.get(color);
    if (!id) {
      id = `g${gradients.size}`;
      gradients.set(color, id);
    }
    return id;
  };

  let edgesSvg = '';
  let elementsSvg = '';

  const edge = (x1: number, x2: number, y: number, rows: number | undefined, arrow: boolean) => {
    const weight = edgeWeight(rows, maxRows);
    const w = EDGE_MIN_W + (EDGE_MAX_W - EDGE_MIN_W) * weight;
    const heavy = weight >= HEAVY_EDGE && maxRows >= 1000;
    const color = heavy ? colors.heavy : colors.line;
    const head = 5 + w;
    const start = arrow ? x1 + head * 0.7 : x1;
    edgesSvg += `<line x1="${start}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}" stroke-width="${w.toFixed(2)}" stroke-linecap="round"/>`;
    if (arrow) {
      edgesSvg += `<path d="M${x1} ${y} L${x1 + head} ${y - head * 0.6} Q${x1 + head * 0.75} ${y} ${x1 + head} ${y + head * 0.6} Z" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`;
    }
    if (rows !== undefined) {
      edgesSvg += `<text x="${(x1 + x2) / 2}" y="${y - 8}" fill="${heavy ? colors.heavy : colors.textSecondary}" font-size="11" font-weight="${heavy ? 700 : 600}" font-family="${font}" text-anchor="middle">${escapeXml(rows.toLocaleString(locale))}</text>`;
    }
  };

  const renderConnectors = (item: SvgNodeLayout) => {
    if (item.children.length === 0) return;

    const parentRightX = item.x + item.width + paddingX;
    const connW = CONN_W;
    const spineX = parentRightX;

    if (item.children.length > 1) {
      const firstMid = item.children[0].y + iconMid + paddingTop;
      const lastMid = item.children[item.children.length - 1].y + iconMid + paddingTop;
      edgesSvg += `<line x1="${spineX}" y1="${firstMid}" x2="${spineX}" y2="${lastMid}" stroke="${colors.line}" stroke-width="${EDGE_MIN_W}" stroke-linecap="round"/>`;
    }
    item.children.forEach((child, i) => {
      const childLeftX = child.x + paddingX;
      const mid = child.y + iconMid + paddingTop;
      // The first child's row carries the arrow into the parent, exactly as on screen.
      edge(parentRightX, Math.min(childLeftX, parentRightX + connW), mid, edgeRows(child.node), i === 0);
      renderConnectors(child);
    });
  };

  const renderNodes = (item: SvgNodeLayout) => {
    const x = item.x + paddingX;
    const y = item.y + paddingTop;
    const w = item.width;
    const cx = x + w / 2;
    const flags = item.node.flags || [];
    const danger = flags.includes('cartesianJoin');

    const opColor = danger ? colors.danger : operatorIconColor(item.node.type);
    const iconPath = operatorSvgPath(item.node.type);

    const pct = totalSelfCost > 0 && item.node.selfCost !== undefined
      ? (item.node.selfCost / totalSelfCost) * 100
      : undefined;

    // 1. Percentage badge (pill), with the signal dot beside it
    const hasBadge = pct !== undefined && pct >= 0.005;
    let badgeRight = cx;
    if (hasBadge) {
      const badgeStyle = svgPercentStyle(pct);
      const pctStr = `${pct.toFixed(2)}%`;
      const badgeW = Math.max(42, pctStr.length * 6.5 + 12);
      elementsSvg += `<rect x="${cx - badgeW / 2}" y="${y + 2}" width="${badgeW}" height="16" rx="8" fill="${badgeStyle.background}"/>`;
      elementsSvg += `<text x="${cx}" y="${y + 13.5}" fill="${badgeStyle.color}" font-size="10" font-weight="700" font-family="${font}" text-anchor="middle">${pctStr}</text>`;
      badgeRight = cx + badgeW / 2;
    }
    if (flags.length > 0) {
      const severity = flagSeverity(flags);
      const flagColor = severity === 'danger' ? colors.danger : severity === 'warn' ? '#ea580c' : severity === 'good' ? '#16a34a' : colors.textDisabled;
      elementsSvg += `<circle cx="${hasBadge ? badgeRight + 8 : cx}" cy="${y + 10}" r="4" fill="${flagColor}"/>`;
    }

    // 2. Icon tile: gradient of the operator colour, hairline ring, soft shadow
    const iconBoxX = cx - ICON / 2;
    const iconBoxY = y + ICON_TOP;
    const grad = gradientFor(opColor);
    elementsSvg += `<rect x="${iconBoxX}" y="${iconBoxY}" width="${ICON}" height="${ICON}" rx="13" fill="url(#${grad})" stroke="${opColor}" stroke-opacity="${danger ? 0.55 : 0.26}" stroke-width="${danger ? 1.5 : 1}" filter="url(#tileShadow)"/>`;
    elementsSvg += `<g transform="translate(${iconBoxX + 10}, ${iconBoxY + 10}) scale(0.833)" stroke="${opColor}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none">${iconPath}</g>`;

    // 3. Title lines (wrapped, centered)
    const titleLines = wrapNodeText(item.node.type, 19, 3);
    const titleStartY = iconBoxY + ICON + 14;
    for (let i = 0; i < titleLines.length; i++) {
      elementsSvg += `<text x="${cx}" y="${titleStartY + i * 14}" fill="${colors.textPrimary}" font-size="11.5" font-weight="600" font-family="${font}" text-anchor="middle">${escapeXml(titleLines[i])}</text>`;
    }

    let nextY = titleStartY + titleLines.length * 14;

    // 4. Subtext (table or join summary if not part of title)
    const subText = item.node.table || joinSummary(item.node, 2);
    if (subText && !item.node.type.includes(subText)) {
      const truncatedSub = subText.length > 20 ? subText.substring(0, 18) + '…' : subText;
      elementsSvg += `<text x="${cx}" y="${nextY}" fill="${colors.textSecondary}" font-size="10.5" font-weight="500" font-family="${font}" text-anchor="middle">${escapeXml(truncatedSub)}</text>`;
      nextY += 13;
    }

    // 5. Cost
    if (item.node.selfCost !== undefined && item.node.selfCost > 0) {
      const costStr = `${costLabel}: ${formatCost(item.node.selfCost, locale)}`;
      elementsSvg += `<text x="${cx}" y="${nextY}" fill="${colors.textDisabled}" font-size="10" font-weight="500" font-family="${font}" text-anchor="middle">${escapeXml(costStr)}</text>`;
    }

    for (const child of item.children) {
      renderNodes(child);
    }
  };

  renderConnectors(layout);
  renderNodes(layout);

  const defs = [...gradients].map(([color, id]) =>
    `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.22"/><stop offset="1" stop-color="${color}" stop-opacity="0.08"/></linearGradient>`,
  ).join('');

  // Edges first, nodes on top — the same stacking as on screen.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
    <defs>${defs}<filter id="tileShadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#0f172a" flood-opacity="0.12"/></filter></defs>
    <rect width="100%" height="100%" fill="${colors.bg}"/>
    ${edgesSvg}
    ${elementsSvg}
  </svg>`;
}

async function exportDiagramImage(
  rootNode: ExplainNode,
  totalSelfCost: number,
  locale: string,
  format: 'png' | 'jpeg' | 'svg',
  costLabel = 'Cost',
  fileName = `explain_diagram_${Date.now()}`
) {
  const ext = format === 'jpeg' ? 'jpg' : format;
  const filterName = format === 'png' ? 'PNG Image (*.png)' : format === 'jpeg' ? 'JPEG Image (*.jpg)' : 'SVG Image (*.svg)';

  // Open native OS "Save As" file dialog so user chooses folder AND file name
  const targetPath = await pickSaveFilePath(fileName, ext, filterName);
  if (!targetPath) return;

  const svgString = buildExplainSvgDocument(rootNode, totalSelfCost, locale, costLabel);

  if (format === 'svg') {
    await saveExportFileAtPath(targetPath, svgString, 'image/svg+xml');
    return;
  }

  const match = svgString.match(/width="(\d+)" height="(\d+)"/);
  const width = match ? parseInt(match[1], 10) : 800;
  const height = match ? parseInt(match[2], 10) : 600;

  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();

  await new Promise<void>((resolve, reject) => {
    img.onload = async () => {
      const dpr = 2;
      const canvas = document.createElement('canvas');
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas context unavailable'));
        return;
      }

      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);

      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      canvas.toBlob(async (b) => {
        if (b) {
          const buffer = await b.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          await saveExportFileAtPath(targetPath, bytes, mimeType);
        }
        resolve();
      }, mimeType, 0.95);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

export const ExplainDiagramView: React.FC<ExplainDiagramViewProps> = ({
  result, onRequestJsonPlan, indexSuggestionCount = 0, onShowIndexSuggestions,
}) => {
  const { t, i18n } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [showExportDropdown, setShowExportDropdown] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const diagramTargetRef = useRef<HTMLDivElement>(null);
  // A drag that moved is a pan, and the click the browser fires at its end must not also select
  // whichever node the pointer happened to be released over.
  const panRef = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  const { rootNode, totalSelfCost = 0, totalCostText, settings } = result;

  // A plan has no terminal operator; dbForge draws the SELECT that consumes the top node.
  // Memoised so the layout and the summary below are computed once per plan, not per render.
  const flowRoot = useMemo<ExplainNode | null>(() => (
    !rootNode
      ? null
      : rootNode.type === 'Query Execution Plan'
      ? { ...rootNode, type: 'SELECT' }
      : { id: 'select', type: 'SELECT', selfCost: 0, children: [rootNode] }
  ), [rootNode]);

  const summary = useMemo(() => summarizePlan(flowRoot, totalSelfCost), [flowRoot, totalSelfCost]);
  // The zoom the diagram is currently drawn at, readable from the layout effect below without
  // making the effect re-run on every zoom change.
  // Synced in a layout effect declared before the fit effect, so that one reads this render's
  // value (effects run in declaration order).
  const zoomRef = useRef(zoom);
  useLayoutEffect(() => { zoomRef.current = zoom; }, [zoom]);

  const measureFit = () => fitZoomFor(
    canvasRef.current,
    diagramNaturalSize(diagramTargetRef.current, zoomRef.current),
  );

  // A new plan opens fitted when fitting keeps it legible, and at 100% otherwise — below that a
  // wide plan is better scrolled than shrunk to unreadable text. Layout effect, so the first
  // paint is already at the right zoom rather than jumping one frame later.
  useLayoutEffect(() => {
    const fit = fitZoomFor(
      canvasRef.current,
      diagramNaturalSize(diagramTargetRef.current, zoomRef.current),
    );
    // set-state-in-effect: the zoom depends on the canvas's and the diagram's measured sizes,
    // which no render input carries — this is a reconcile against layout, not a derivable value.
    // eslint-disable-next-line react/set-state-in-effect
    setZoom(fit !== null && fit >= AUTO_FIT_MIN ? fit : 1);
    // `flowRoot` is not read inside, and that is the point: this runs once per new plan, after
    // that plan's diagram is in the DOM to be measured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowRoot]);

  const fitToView = () => {
    const fit = measureFit();
    if (fit !== null) setZoom(fit);
  };

  // Select a node and bring it into view — used by the summary strip, whose target may be off
  // screen in a wide plan.
  const focusNode = (id: string) => {
    setSelectedId(id);
    const el = canvasRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  };

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Left or middle button; anything else (right-click) keeps its default.
    if (e.button !== 0 && e.button !== 1) return;
    const el = canvasRef.current;
    if (!el) return;
    // A press on the scrollbars is the browser's own drag; panning on top of it scrolls twice.
    const rect = el.getBoundingClientRect();
    if (e.clientX - rect.left >= el.clientWidth || e.clientY - rect.top >= el.clientHeight) return;
    el.focus({ preventScroll: true });
    // No text selection starting under a drag, and no autoscroll puck on a middle press. The
    // click that follows a press without movement still fires, so selecting a node is unaffected.
    e.preventDefault();
    panRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const el = canvasRef.current;
    if (!pan || !el) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.moved) {
      if (Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return;
      pan.moved = true;
      // Captured only once it is a pan, so a plain click still reaches the node under it.
      el.setPointerCapture(e.pointerId);
      setPanning(true);
    }
    el.scrollLeft = pan.left - dx;
    el.scrollTop = pan.top - dy;
  };

  const endPan = () => {
    if (panRef.current?.moved) {
      suppressClickRef.current = true;
      setPanning(false);
    }
    panRef.current = null;
  };

  const onCanvasClickCapture = (e: React.MouseEvent) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.stopPropagation();
  };

  // Same shortcuts as the ER diagram, so a user who learned one knows the other.
  const onCanvasKeyDown = (e: React.KeyboardEvent) => {
    if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'Digit0') { e.preventDefault(); setZoom(1); }
    else if (e.code === 'Digit1') { e.preventDefault(); fitToView(); }
  };

  const handleExport = async (format: 'png' | 'jpeg' | 'svg') => {
    setShowExportDropdown(false);
    if (!flowRoot) return;
    try {
      await exportDiagramImage(flowRoot, totalSelfCost, i18n.language, format, t('explain.colCost'));
    } catch (err) {
      console.error('Failed to export diagram image:', err);
    }
  };

  // React attaches `wheel` passively, so preventDefault has to come from a native listener —
  // without it Ctrl+wheel zooms the whole app instead of the diagram.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(z => clampZoom(e.deltaY < 0 ? z * ZOOM_STEP : z / ZOOM_STEP));
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const settingsText = settings
    ? Object.entries(settings).map(([k, v]) => `${k}=${v}`).join(', ')
    : '';

  // Resolving the selection by id (instead of holding the node) means a new plan simply drops
  // the old selection rather than pinning a node that is no longer in the tree.
  const selectedNode = flowRoot ? findNode(flowRoot, selectedId) : null;
  const hasCost = totalSelfCost > 0 && !!totalCostText;

  if (!flowRoot) return null;

  const ctx: FlowContext = {
    totalSelfCost,
    selectedId,
    onSelect: (node) => setSelectedId(node.id),
    locale: i18n.language,
    flagLabel: (flag) => t(flagLabelKey(flag)),
    costLabel: t('explain.colCost'),
    maxRows: summary.maxRows,
  };

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Total cost bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '8px 14px',
          borderBottom: '1px solid var(--win-border)',
          fontSize: '12px',
          color: 'var(--win-text-secondary)',
          flexShrink: 0,
        }}>
          {hasCost ? (
            <span>
              {t('explain.totalCost')}: <strong style={{ color: 'var(--win-text-primary)' }}>{totalCostText}</strong>
            </span>
          ) : (
            <>
              <span>{t('explain.noCostData')}</span>
              {onRequestJsonPlan && (
                <button
                  className="btn btn-secondary"
                  onClick={onRequestJsonPlan}
                  style={{ padding: '2px 8px', display: 'flex', alignItems: 'center', gap: '5px' }}
                >
                  <FileText size={12} />
                  <span>{t('explain.rerunAsJson')}</span>
                </button>
              )}
            </>
          )}

          {/* Non-default planner settings: the usual answer to "why did it pick this plan". */}
          {settingsText && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                marginLeft: 'auto',
                marginRight: '4px',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={settingsText}
            >
              <Settings2 size={12} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {t('explain.settings')}: {settingsText}
              </span>
            </span>
          )}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginLeft: settingsText ? 0 : 'auto',
            flexShrink: 0,
          }}>
            {/* Export Dropdown */}
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowExportDropdown(!showExportDropdown)}
                style={{ padding: '2px 8px', fontSize: '11px', height: '22px', display: 'flex', alignItems: 'center', gap: '4px' }}
                title={t('explain.exportDiagramTitle')}
              >
                <Download size={12} />
                <span>{t('explain.exportImage')}</span>
                <ChevronDown size={10} style={{ opacity: 0.7 }} />
              </button>

              {showExportDropdown && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setShowExportDropdown(false)} />
                  <div style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    right: 0,
                    background: 'var(--win-bg-popover, var(--win-bg-card))',
                    border: '1px solid var(--win-border-strong, var(--win-border))',
                    borderRadius: '6px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                    zIndex: 9999,
                    minWidth: '130px',
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '4px 0',
                  }}>
                    <button className="copy-dropdown-item" onClick={() => handleExport('png')}>{t('explain.exportAs', { format: 'PNG' })}</button>
                    <button className="copy-dropdown-item" onClick={() => handleExport('jpeg')}>{t('explain.exportAs', { format: 'JPG' })}</button>
                    <button className="copy-dropdown-item" onClick={() => handleExport('svg')}>{t('explain.exportAs', { format: 'SVG' })}</button>
                  </div>
                </>
              )}
            </div>

            <div style={{ width: '1px', height: '12px', background: 'var(--win-border)', margin: '0 2px' }} />

            {/* Zoom Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
              <ZoomButton
                icon={ZoomOut}
                label={t('explain.zoomOut')}
                disabled={zoom <= ZOOM_MIN}
                onClick={() => setZoom(z => clampZoom(z / ZOOM_STEP))}
              />
              <button
                onClick={() => setZoom(1)}
                title={t('explain.zoomReset')}
                aria-label={t('explain.zoomReset')}
                style={{
                  minWidth: '44px',
                  padding: '2px 4px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--win-text-secondary)',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {Math.round(zoom * 100)}%
              </button>
              <ZoomButton
                icon={ZoomIn}
                label={t('explain.zoomIn')}
                disabled={zoom >= ZOOM_MAX}
                onClick={() => setZoom(z => clampZoom(z * ZOOM_STEP))}
              />
              <ZoomButton
                icon={Maximize}
                label={t('explain.zoomFit')}
                disabled={false}
                onClick={fitToView}
              />
              <ZoomButton
                icon={RotateCcw}
                label={t('explain.zoomReset')}
                disabled={zoom === 1}
                onClick={() => setZoom(1)}
              />
            </div>
          </div>
        </div>

        {/* What to look at first. Every chip is a jump to the node it names, because in a wide
            plan the node is usually off screen. */}
        {(summary.hottest || summary.issues.length > 0 || indexSuggestionCount > 0) && (
          <div className="explain-summary">
            {summary.hottest && summary.hottest.pct >= HOT_MIN_PCT && (
              <button
                type="button"
                className="explain-chip explain-chip-hot"
                onClick={() => focusNode(summary.hottest!.id)}
                title={summary.hottest.type}
              >
                <Flame size={12} />
                <span className="explain-chip-text">
                  {t('explain.summaryHottest', { name: summary.hottest.type })}
                </span>
                <strong>{summary.hottest.pct.toFixed(1)}%</strong>
              </button>
            )}
            {summary.issues.map(issue => {
              const danger = issue.flag === 'cartesianJoin';
              const Icon = danger ? OctagonAlert : TriangleAlert;
              return (
                <button
                  key={issue.flag}
                  type="button"
                  className={`explain-chip ${danger ? 'explain-chip-danger' : 'explain-chip-warn'}`}
                  onClick={() => focusNode(issue.firstId)}
                  title={danger ? t('explain.cartesianHint') : undefined}
                >
                  <Icon size={12} />
                  <span className="explain-chip-text">{t(flagLabelKey(issue.flag))}</span>
                  {issue.count > 1 && <span className="explain-chip-count">×{issue.count}</span>}
                </button>
              );
            })}
            {indexSuggestionCount > 0 && onShowIndexSuggestions && (
              <button type="button" className="explain-chip explain-chip-tip" onClick={onShowIndexSuggestions}>
                <Lightbulb size={12} />
                <span className="explain-chip-text">{t('explain.summaryIndexes', { n: indexSuggestionCount })}</span>
              </button>
            )}
          </div>
        )}

        {/* Diagram canvas: width grows with plan depth, so it scrolls horizontally. Uses CSS
            `zoom` rather than `transform: scale` because zoom is layout-aware — the scroll
            extent follows the scaled content instead of staying at the unscaled size.
            Dragging anywhere pans (middle button too); Shift+1 fits, Shift+0 resets. */}
        <div
          ref={canvasRef}
          className={`explain-canvas${panning ? ' is-panning' : ''}`}
          tabIndex={-1}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onClickCapture={onCanvasClickCapture}
          onKeyDown={onCanvasKeyDown}
        >
          {/* Sized to its content, so the measured rect is the diagram rather than the canvas. */}
          <div ref={diagramTargetRef} style={{ width: 'max-content', zoom }}>
            <SubTree node={flowRoot} ctx={ctx} />
          </div>
        </div>
      </div>

      {/* Details Side Panel */}
      {/* Selectable: its conditions and index names are exactly what gets pasted elsewhere. */}
      {selectedNode && (
        <div className="explain-selectable" style={{
          width: '320px',
          flexShrink: 0,
          borderLeft: '1px solid var(--win-border)',
          background: 'var(--win-bg-card)',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          overflowY: 'auto'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--win-border)', paddingBottom: '10px' }}>
            <Layers size={18} style={{ color: 'var(--win-accent)' }} />
            <h4 style={{ margin: 0, fontSize: '14px', color: 'var(--win-text-primary)' }}>
              {t('explain.nodeDetailTitle')}
            </h4>
            {/* Closing the panel just drops the selection — clicking any node opens it again. */}
            <button
              onClick={() => setSelectedId(null)}
              title={t('common.close')}
              aria-label={t('common.close')}
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '22px',
                height: '22px',
                flexShrink: 0,
                padding: 0,
                background: 'transparent',
                border: 'none',
                borderRadius: '4px',
                color: 'var(--win-text-secondary)',
                cursor: 'pointer',
              }}
            >
              <X size={14} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', textTransform: 'uppercase', fontWeight: 600 }}>{t('explain.nodeOperation')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                {(() => {
                  const SelIcon = operatorIcon(selectedNode.type);
                  const selColor = operatorIconColor(selectedNode.type);
                  return (
                    <div className="explain-node-icon is-small" style={{ '--op-color': selColor } as React.CSSProperties}>
                      <SelIcon size={15} strokeWidth={1.75} />
                    </div>
                  );
                })()}
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--win-text-primary)' }}>
                  {selectedNode.type}
                </div>
              </div>
            </div>

            {getDetailField(selectedNode, 'access_type') && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeAccessType')}</div>
                <div style={{
                  display: 'inline-block',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: 700,
                  fontFamily: 'var(--win-font-mono)',
                  marginTop: '3px',
                  background: String(getDetailField(selectedNode, 'access_type')).toLowerCase() === 'all' ? 'rgba(239, 68, 68, 0.15)' : String(getDetailField(selectedNode, 'access_type')).toLowerCase().includes('ref') ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                  color: String(getDetailField(selectedNode, 'access_type')).toLowerCase() === 'all' ? 'var(--st-danger, #ef4444)' : String(getDetailField(selectedNode, 'access_type')).toLowerCase().includes('ref') ? 'var(--st-ok, #10b981)' : 'var(--st-warn, #f59e0b)',
                }}>
                  {String(getDetailField(selectedNode, 'access_type')).toUpperCase()}
                </div>
              </div>
            )}

            {selectedNode.table && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Table size={14} style={{ color: 'var(--win-text-secondary)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeTable')}</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{selectedNode.table}</div>
                </div>
              </div>
            )}

            {getDetailField(selectedNode, 'used_columns') && (Array.isArray(getDetailField(selectedNode, 'used_columns')) ? getDetailField(selectedNode, 'used_columns').length > 0 : String(getDetailField(selectedNode, 'used_columns')).length > 0) && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeUsedColumns')}</div>
                <div style={{
                  fontSize: '11px',
                  fontFamily: 'var(--win-font-mono)',
                  color: 'var(--win-text-secondary)',
                  marginTop: '3px',
                  wordBreak: 'break-word',
                  background: 'var(--win-bg-code)',
                  padding: '4px 6px',
                  borderRadius: '4px'
                }}>
                  {Array.isArray(getDetailField(selectedNode, 'used_columns')) ? getDetailField(selectedNode, 'used_columns').join(', ') : String(getDetailField(selectedNode, 'used_columns'))}
                </div>
              </div>
            )}

            {selectedNode.joinTables && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeJoin')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', wordBreak: 'break-word' }}>
                  {joinSummary(selectedNode, Infinity)}
                </div>
              </div>
            )}

            {selectedNode.joinFilter && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeJoinOn')}</div>
                <div style={{ fontSize: '11px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>
                  {selectedNode.joinFilter}
                </div>
              </div>
            )}

            {selectedNode.flags && selectedNode.flags.length > 0 && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', marginBottom: '5px' }}>{t('explain.flagsTitle')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {selectedNode.flags.map(flag => {
                    const severity = flagSeverity([flag]);
                    const { Icon, color } = FLAG_ICON_STYLE[severity];
                    return (
                      <div key={flag} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: severity === 'muted' ? 'var(--win-text-secondary)' : color }}>
                        <Icon size={12} style={{ flexShrink: 0 }} />
                        <span>{t(flagLabelKey(flag))}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {selectedNode.indexName && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Database size={14} style={{ color: 'var(--win-accent)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeIndex')}</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-accent)' }}>{selectedNode.indexName}</div>
                </div>
              </div>
            )}

            {getDetailField(selectedNode, 'used_key_parts') && (Array.isArray(getDetailField(selectedNode, 'used_key_parts')) ? getDetailField(selectedNode, 'used_key_parts').length > 0 : String(getDetailField(selectedNode, 'used_key_parts')).length > 0) && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeUsedKeyParts')}</div>
                <div style={{ fontSize: '11.5px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)', marginTop: '2px' }}>
                  {Array.isArray(getDetailField(selectedNode, 'used_key_parts')) ? getDetailField(selectedNode, 'used_key_parts').join(', ') : String(getDetailField(selectedNode, 'used_key_parts'))}
                </div>
              </div>
            )}

            {selectedNode.candidateIndexes && selectedNode.candidateIndexes.length > 0 && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeCandidateIndexes')}</div>
                <div style={{ fontSize: '11.5px', color: 'var(--win-text-secondary)' }}>
                  {selectedNode.candidateIndexes.join(', ')}
                </div>
              </div>
            )}

            {getDetailField(selectedNode, 'data_read_per_join') && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeDataReadPerJoin')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', marginTop: '2px' }}>
                  {String(getDetailField(selectedNode, 'data_read_per_join'))}
                </div>
              </div>
            )}

            {(() => {
              const filteredVal = getDetailField(selectedNode, 'filtered') ?? getDetailField(selectedNode, 'FILTERED');
              return filteredVal !== undefined && (
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeFiltered')}</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', marginTop: '2px' }}>
                    {Number(filteredVal).toFixed(2)}%
                  </div>
                </div>
              );
            })()}

            {selectedNode.cost && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <BarChart2 size={14} style={{ color: 'var(--win-text-secondary)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeCost')}</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                    {selectedNode.cost.start.toFixed(2)} .. {selectedNode.cost.total.toFixed(2)}
                  </div>
                </div>
              </div>
            )}

            {selectedNode.selfCost !== undefined && totalSelfCost > 0 && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeSelfCost')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  {selectedNode.selfCost.toFixed(2)} ({((selectedNode.selfCost / totalSelfCost) * 100).toFixed(2)}%)
                </div>
              </div>
            )}

            {selectedNode.rows !== undefined && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeRows')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  {selectedNode.rows.toLocaleString(i18n.language)}
                </div>
              </div>
            )}

            {/* The arrow label, spelled out — a join node has no `rows` of its own, which is why
                its panel used to stop after the cost. */}
            {selectedNode.rowsOut !== undefined && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeRowsOut')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  {selectedNode.rowsOut.toLocaleString(i18n.language)}
                </div>
              </div>
            )}

            {selectedNode.actualRowsTotal !== undefined && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeActualRows')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  {selectedNode.actualRowsTotal.toLocaleString(i18n.language)}
                  {selectedNode.actualLoops !== undefined && selectedNode.actualLoops !== 1 && (
                    // rows × loops: the plan reports rows per loop, which reads far too low.
                    <span style={{ fontWeight: 400, color: 'var(--win-text-secondary)' }}>
                      {' '}({selectedNode.actualRows!.toLocaleString(i18n.language)} × {selectedNode.actualLoops.toLocaleString(i18n.language)} {t('explain.nodeLoops')})
                    </span>
                  )}
                </div>
              </div>
            )}

            {selectedNode.estimateRatio !== undefined && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeEstimate')}</div>
                <div style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: selectedNode.flags?.includes('rowsMisestimated') ? 'var(--st-warn, #f59e0b)' : 'var(--win-text-primary)',
                }}>
                  {selectedNode.estimateRatio >= 1
                    ? `${selectedNode.estimateRatio.toFixed(1)}×`
                    : `1/${(1 / selectedNode.estimateRatio).toFixed(1)}×`}
                </div>
              </div>
            )}

            {selectedNode.actualTime && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Clock size={14} style={{ color: 'var(--st-ok)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeActualTime')}</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--st-ok)' }}>
                    {selectedNode.actualTime.total.toFixed(3)} ms
                  </div>
                </div>
              </div>
            )}

            {selectedNode.message && (
              <div style={{ fontSize: '11.5px', color: 'var(--st-warn, #f59e0b)', fontWeight: 600 }}>
                {selectedNode.message}
              </div>
            )}

            {/* Index Cond is evaluated inside the index; Filter runs after the heap fetch. Showing
                them as one field hid which half of the predicate the index actually handles. */}
            {selectedNode.indexCond && (
              <div style={{ background: 'var(--win-bg-code)', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--win-border)' }}>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                  <KeyRound size={12} />
                  <span>{t('explain.nodeIndexCond')}</span>
                </div>
                <div style={{ fontSize: '11px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>
                  {selectedNode.indexCond}
                </div>
              </div>
            )}

            {selectedNode.filter && (
              <div style={{ background: 'var(--win-bg-code)', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--win-border)' }}>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                  <Filter size={12} />
                  <span>{t('explain.nodeFilter')}</span>
                </div>
                <div style={{ fontSize: '11px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>
                  {selectedNode.filter}
                </div>
              </div>
            )}

            {/* Whatever the driver reported that has no dedicated row above. Raw field names on
                purpose — they are data, and they are what the docs call them. */}
            {remainingFields(selectedNode).length > 0 && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', marginBottom: '5px', paddingTop: '4px', borderTop: '1px solid var(--win-border)' }}>
                  {t('explain.nodeAllFields')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {remainingFields(selectedNode).map(([key, value]) => (
                    <div key={key} style={{ display: 'flex', gap: '8px', fontSize: '11px', alignItems: 'baseline' }}>
                      <span style={{ color: 'var(--win-text-disabled)', fontFamily: 'var(--win-font-mono)', flexShrink: 0 }}>{key}</span>
                      <span style={{ color: 'var(--win-text-primary)', wordBreak: 'break-word', textAlign: 'right', marginLeft: 'auto' }} title={value}>
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const SubTree: React.FC<{ node: ExplainNode; ctx: FlowContext }> = ({ node, ctx }) => {
  const children = node.children || [];

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      <NodeCell node={node} ctx={ctx} />

      {children.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {children.map((child, i) => (
            // Each child row brings its own connector segment. The segments join up into one
            // continuous spine without anyone having to measure subtree heights.
            <div key={child.id} style={{ display: 'flex', alignItems: 'stretch' }}>
              <Connector
                // What the child hands upwards, not what it reads: an arrow label of
                // rows-per-scan says nothing about the volume flowing through the join.
                rows={edgeRows(child)}
                maxRows={ctx.maxRows}
                isFirst={i === 0}
                isLast={i === children.length - 1}
                single={children.length === 1}
                locale={ctx.locale}
              />
              <SubTree node={child} ctx={ctx} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * 0..1 share of the plan's largest row flow, on a log scale: row counts span six orders of
 * magnitude, and a linear scale would draw every edge but the biggest as a hairline.
 */
function edgeWeight(rows: number | undefined, maxRows: number): number {
  if (rows === undefined || rows <= 0 || maxRows <= 1) return 0;
  return Math.min(1, Math.log10(rows + 1) / Math.log10(maxRows + 1));
}

const EDGE_MIN_W = 1.25;
const EDGE_MAX_W = 4.5;
/** An edge this close to the plan's largest flow gets its label emphasised too. */
const HEAVY_EDGE = 0.9;

const Connector: React.FC<{
  rows?: number;
  maxRows: number;
  isFirst: boolean;
  isLast: boolean;
  single: boolean;
  locale: string;
}> = ({ rows, maxRows, isFirst, isLast, single, locale }) => {
  const midY = ICON_CY;
  const weight = edgeWeight(rows, maxRows);
  const strokeW = EDGE_MIN_W + (EDGE_MAX_W - EDGE_MIN_W) * weight;
  // The arrow grows with the line it caps, or a thick edge ends in a pin head.
  const head = 5 + strokeW;
  const heavy = weight >= HEAVY_EDGE && maxRows >= 1000;

  return (
    <div style={{ position: 'relative', width: `${CONN_W}px`, minHeight: `${ICON_CY + 12}px`, flexShrink: 0, alignSelf: 'stretch' }}>
      <svg
        width="100%"
        height="100%"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
      >
        {/* Vertical spine: spans this child row so consecutive rows join into one line. Kept at
            the base width — it is shared by siblings whose volumes differ. */}
        {!single && (
          <line
            x1={0}
            y1={isFirst ? midY : 0}
            x2={0}
            y2={isLast ? midY : '100%'}
            className="explain-flow-line-base"
          />
        )}
        {/* Horizontal branch, as wide as the rows flowing through it. It stops short of the
            arrowhead so a wide line cannot poke out past the tip. */}
        <line
          x1={isFirst ? head * 0.7 : 0}
          y1={midY}
          x2={CONN_W}
          y2={midY}
          className={`explain-flow-line-base${heavy ? ' is-heavy' : ''}`}
          style={{ strokeWidth: strokeW }}
        />

        {/* Arrowhead entering the parent operator: a soft, slightly concave dart. */}
        {isFirst && (
          <path
            d={`M0 ${midY} L${head} ${midY - head * 0.6} Q${head * 0.75} ${midY} ${head} ${midY + head * 0.6} Z`}
            className={`explain-flow-arrow${heavy ? ' is-heavy' : ''}`}
          />
        )}
      </svg>

      {/* Rows handed to parent */}
      {rows !== undefined && (
        <div className={`explain-edge-label${heavy ? ' is-heavy' : ''}`} style={{ top: `${midY - 22}px` }}>
          {rows.toLocaleString(locale)}
        </div>
      )}
    </div>
  );
};

const ZoomButton: React.FC<{
  icon: typeof ZoomIn;
  label: string;
  disabled: boolean;
  onClick: () => void;
}> = ({ icon: Icon, label, disabled, onClick }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '22px',
      height: '22px',
      padding: 0,
      background: 'transparent',
      border: 'none',
      borderRadius: '4px',
      color: 'var(--win-text-secondary)',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.4 : 1,
    }}
  >
    <Icon size={13} />
  </button>
);

const FLAG_ICON_STYLE = {
  danger: { Icon: OctagonAlert, color: 'var(--st-danger, #ef4444)' },
  warn: { Icon: TriangleAlert, color: 'var(--st-warn, #f59e0b)' },
  good: { Icon: CircleCheck, color: 'var(--st-ok, #22c55e)' },
  muted: { Icon: CircleMinus, color: 'var(--win-text-disabled)' },
} as const;

const FlagIcon: React.FC<{ flags: ExplainFlag[]; ctx: FlowContext }> = ({ flags, ctx }) => {
  const { Icon, color } = FLAG_ICON_STYLE[flagSeverity(flags)];
  // Lucide icons take no `title`, so the tooltip lives on a wrapper.
  return (
    <span style={{ display: 'flex', alignItems: 'center' }} title={flags.map(ctx.flagLabel).join(' · ')}>
      <Icon size={12} strokeWidth={2.25} style={{ color, flexShrink: 0 }} />
    </span>
  );
};

// Relative-cost tier -> badge class. Same thresholds as the exported image.
function percentTier(pct: number): string {
  if (pct >= 25) return 'is-high';
  if (pct >= 15) return 'is-mid';
  if (pct >= 5) return 'is-low';
  return '';
}

const NodeCell: React.FC<{ node: ExplainNode; ctx: FlowContext }> = ({ node, ctx }) => {
  const selected = ctx.selectedId === node.id;
  const pct = ctx.totalSelfCost > 0 && node.selfCost !== undefined
    ? (node.selfCost / ctx.totalSelfCost) * 100
    : undefined;
  const showPct = pct !== undefined && pct >= 0.005;
  const flags = node.flags || [];
  const danger = flags.includes('cartesianJoin');
  // A cross join takes the danger colour for its whole tile rather than a red ring around the
  // operator's own colour, which read as two outlines fighting.
  const iconColor = danger ? 'var(--st-danger, #ef4444)' : operatorIconColor(node.type);

  return (
    <div
      data-node-id={node.id}
      onClick={() => ctx.onSelect(node)}
      className={`explain-node${selected ? ' is-selected' : ''}${danger ? ' is-danger' : ''}`}
      // The operator's colour is data (it follows the node type), so it travels as a variable
      // the stylesheet mixes into the icon's fill, ring and glow.
      style={{ width: `${NODE_W}px`, '--op-color': iconColor } as React.CSSProperties}
    >
      {/* Relative cost badge, reserved height so every icon stays on the same baseline */}
      <div className="explain-node-badges">
        {showPct && <span className={`explain-pct ${percentTier(pct!)}`}>{pct!.toFixed(2)}%</span>}
        {/* One icon summarising the node's signals — the full list is in the detail panel. Keeping
            it to a single glyph is what lets a wide plan stay readable. */}
        {flags.length > 0 && <FlagIcon flags={flags} ctx={ctx} />}
      </div>

      <div className="explain-node-icon">
        {React.createElement(operatorIcon(node.type), { size: 20, strokeWidth: 1.75 })}
      </div>

      <div className="explain-node-title" title={node.type}>
        {node.type}
      </div>

      {/* A join has no table of its own; name the two sides instead of leaving the line blank. */}
      {(node.table || node.joinTables) && (
        <div className="explain-node-sub" title={node.table || joinSummary(node)}>
          {node.table || joinSummary(node)}
        </div>
      )}

      {/* The absolute figure behind the % badge — same quantity, so the two always agree. */}
      {node.selfCost !== undefined && node.selfCost > 0 && (
        <div className="explain-node-cost">
          {ctx.costLabel}: {formatCost(node.selfCost, ctx.locale)}
        </div>
      )}
    </div>
  );
};
