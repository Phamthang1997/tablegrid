/**
 * Type definitions for Interactive ER Diagram.
 * Defines schemas for nodes, edges, relationships, layout coordinates, and export formats.
 */

export interface ERColumn {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  refTable?: string;
  refColumn?: string;
  nullable?: boolean;
  comment?: string;
}

export interface ERTable {
  id: string; // Typically tableName
  name: string;
  schema?: string;
  kind?: 'table' | 'view';
  columns: ERColumn[];
  rowCount?: number | null;
  comment?: string;
}

export interface ERRelationship {
  id: string; // e.g. "payment.customer_id->customer.customer_id"
  name?: string; // Constraint name e.g. "fk_payment_customer"
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  cardinality?: '1:1' | '1:N' | 'N:M';
}

export interface ERNodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  isCollapsed?: boolean;
}

export type ERLayoutPositions = Record<string, ERNodePosition>;

export interface ERViewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Live viewport feed.
 *
 * While a gesture is running, the canvas writes its transform straight to the DOM and never
 * re-renders — so anything that has to keep up with a pan (the minimap indicator, the zoom
 * readout) subscribes here and updates its own DOM instead of taking the viewport as a prop.
 * The subscribe function calls back once immediately with the current value.
 */
export type ERViewportListener = (vp: ERViewport) => void;
export type ERViewportSubscribe = (fn: ERViewportListener) => () => void;

export type ERDetailLevel = 'full' | 'keys_only' | 'compact';

/**
 * The active canvas tool, Figma-style.
 *
 *  - `select` — click picks a table, dragging a table moves it, dragging the empty canvas
 *    lassoes. This is where every mutation of the diagram happens.
 *  - `hand`   — the pointer only moves the viewport. The node layer stops taking pointer
 *    events entirely in this mode, which is also what makes it the cheap one: no hover
 *    tracking, no accidental table drag, no hover repaint of a card while panning over it.
 *
 * Holding Space borrows `hand` from whichever tool is active, and the middle mouse button pans
 * in both — the tool only decides what the LEFT button does.
 */
export type ERTool = 'select' | 'hand';

export interface ERDisplayConfig {
  detailLevel: ERDetailLevel;
  showViews: boolean;
  showIsolatedTables: boolean;
  showMinimap: boolean;
  highlightedTable: string | null;
  highlightedRelation: string | null;
  selectedTableIds: Set<string>;
  searchQuery: string;
}

export type ERExportFormat =
  | 'png'
  | 'clipboard'
  | 'svg'
  | 'mermaid'
  /** Mermaid for the selected tables only — what fits Mermaid's render limits on a big schema. */
  | 'mermaid-selection'
  | 'dbml'
  /** The schema as a Markdown document with one Mermaid diagram per table (`erDocExport.ts`). */
  | 'markdown'
  | 'sql';

/** What an export reports back to the toolbar. */
export interface ERExportOutcome {
  /** The Mermaid text exceeds Mermaid's default render limits (`mermaidTooLarge`). */
  tooLarge?: boolean;
}
