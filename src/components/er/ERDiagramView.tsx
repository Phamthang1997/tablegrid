import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ERTable,
  ERRelationship,
  ERLayoutPositions,
  ERViewport,
  ERDetailLevel,
  ERExportFormat,
  ERExportOutcome,
  ERTool,
  ERViewportListener,
} from './erTypes';
import {
  computeAutoLayout,
  calculateNodeDimensions,
  visibleColumnsOf,
  HEADER_HEIGHT,
  ROW_HEIGHT,
} from './erLayoutEngine';
import {
  boundsOf,
  clampZoom,
  fitViewport,
  lerpViewport,
  lodForZoom,
  marqueeHits,
  rectFromCorners,
  screenToWorld,
  visibleWorldRect,
  zoomAtPoint,
} from './erViewport';
import {
  erHiddenKey,
  erLayoutKey,
  loadHiddenTables,
  loadSavedLayout,
  saveCurrentLayout,
  saveHiddenTables,
} from './erPersistence';
import { ERCardCache, chevronHitBox, quantizeRasterScale } from './erCardRenderer';
import { erPalette, invalidateErPalette } from './erTheme';
import { drawScene, hitTestCards, hitTestRelationships, resolveRelationships } from './erScene';
import type { ERResolvedRelationship } from './erScene';
import {
  exportToMermaid,
  mermaidTooLarge,
  exportToDbml,
  exportToSql,
  generateFullDiagramSvg,
  exportDiagramToPng,
} from './erExportHelper';
import { exportToMarkdownDoc } from './erDocExport';
import { pickSaveFilePath, saveExportFileAtPath } from '../../utils/fileSave';
import { dbHelper } from '../../utils/dbHelper';
import { ERToolbar } from './ERToolbar';
import { ERMinimap } from './ERMinimap';

export interface ERDiagramViewProps {
  connId: string;
  /** Server identity from `utils/connKey.ts`, used as the localStorage scope for the layout. */
  storageScope: string;
  database?: string;
  schema?: string;
  tables: ERTable[];
  relationships: ERRelationship[];
  onOpenTable?: (tableName: string) => void;
  isLoading?: boolean;
}

const INITIAL_VIEWPORT: ERViewport = { x: 40, y: 40, zoom: 1 };

const TWEEN_MS = 260;
/** How long after the last wheel event the raster scale is allowed to follow the zoom. */
const WHEEL_SETTLE_MS = 110;

/**
 * How many card bitmaps one frame may render.
 *
 * Sized so the worst frame stays well inside a 60Hz budget on a slow machine: a card render is
 * a few hundred microseconds, so 16 of them is a few milliseconds. Anything above the budget is
 * drawn as a skeleton and finished on the next frame — see `fillBudget` in `erScene`.
 */
const CARD_FILL_BUDGET = 16;
/**
 * How many times in a row a frame may ask for another one to finish filling cards.
 *
 * The budget alone guarantees progress only while the cache can hold what is on screen. If it
 * ever cannot — a pathological zoom with hundreds of huge cards visible — this stops the
 * repaint loop from spinning forever, at the cost of leaving a few skeletons until the next
 * real interaction.
 */
const MAX_FILL_PASSES = 8;

/** Pointer slop, in SCREEN pixels, for grabbing a connector. */
const REL_HIT_SCREEN_TOLERANCE = 7;

/**
 * Frame timing, behind `window.__erPerfDebug = true` in DevTools.
 *
 * Same idea as `window.__sqlCompletionDebug`: the answer to "why does this feel heavy" is a
 * number, and guessing at it costs more than measuring. Reported once a second as ONE flat
 * string — DevTools collapses objects behind `Array(4)`, and the fields worth reading are
 * exactly the ones that get collapsed. Everything here is dead code when the flag is off.
 */
const PERF_REPORT_MS = 1000;

interface PerfWindow {
  __erPerfDebug?: boolean;
}

interface FrameStats {
  frames: number;
  total: number;
  worst: number;
  since: number;
  cards: number;
  connectors: number;
  rendered: number;
}

interface LayoutState {
  /** localStorage identity — a different one means a different diagram. */
  key: string;
  /** `detailLevel` + the collapsed set: what decides a node's width/height. */
  sizeKey: string;
  /** Identity of the source array, which only changes when the tab reloads the catalog. */
  tables: ERTable[];
  positions: ERLayoutPositions;
  /** Whether these positions still need writing to localStorage. */
  persist: boolean;
}

function sizeKeyOf(detailLevel: ERDetailLevel, collapsed: Record<string, boolean>): string {
  const names = Object.keys(collapsed)
    .filter((name) => collapsed[name])
    .sort();
  return `${detailLevel}|${names.join(',')}`;
}

/**
 * Positions for every table, reusing what the user already arranged.
 *
 * Three sources, in priority order: the positions already in state (a drag the user just made),
 * then localStorage, then auto-layout. Auto-layout is computed only when something is actually
 * missing, so opening a diagram whose layout is saved never pays for it.
 */
function reconcileLayout(
  prev: LayoutState | null,
  key: string,
  sizeKey: string,
  tables: ERTable[],
  relationships: ERRelationship[],
  detailLevel: ERDetailLevel,
  collapsed: Record<string, boolean>
): LayoutState {
  const base: ERLayoutPositions | null =
    prev && prev.key === key ? prev.positions : loadSavedLayout(key);

  let auto: ERLayoutPositions | null = null;
  const autoFor = (): ERLayoutPositions => {
    auto ??= computeAutoLayout(tables, relationships, detailLevel, collapsed);
    return auto;
  };

  const positions: ERLayoutPositions = {};
  let changed = false;

  for (const table of tables) {
    const saved = base?.[table.name];
    const spot = saved ?? autoFor()[table.name];
    if (!spot) continue;
    if (!saved) changed = true;

    const isCollapsed = !!collapsed[table.name];
    const dim = calculateNodeDimensions(table, detailLevel, isCollapsed);
    if (
      saved &&
      saved.width === dim.width &&
      saved.height === dim.height &&
      !!saved.isCollapsed === isCollapsed
    ) {
      positions[table.name] = saved;
    } else {
      changed = true;
      positions[table.name] = { x: spot.x, y: spot.y, ...dim, isCollapsed };
    }
  }

  // A table that vanished from the catalog leaves its entry behind, so re-adding it later lands
  // back where the user had put it.
  if (base) {
    for (const [name, spot] of Object.entries(base)) {
      if (!positions[name]) positions[name] = spot;
    }
  }

  return { key, sizeKey, tables, positions, persist: changed };
}

/** What a pointer gesture is doing, kept out of state so a move never triggers a render. */
type Gesture =
  | {
      kind: 'pan';
      pointerId: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
    }
  | {
      kind: 'node';
      pointerId: number;
      startX: number;
      startY: number;
      moved: boolean;
      /** Positions as they were at pointerdown, so each frame is an absolute offset. */
      origin: ERLayoutPositions;
      names: string[];
    }
  | {
      kind: 'marquee';
      pointerId: number;
      startWorldX: number;
      startWorldY: number;
      additive: boolean;
    };

export const ERDiagramView: React.FC<ERDiagramViewProps> = ({
  connId,
  storageScope,
  database,
  schema,
  tables,
  relationships,
  onOpenTable,
}) => {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // `t` gets a new identity on every language switch, and the paint path must not depend on
  // it: the tooltip is the only place the renderer uses a translated string.
  const tRef = useRef(t);
  useLayoutEffect(() => {
    tRef.current = t;
  }, [t]);

  /** Toggles the grabbing cursor. Nothing else depends on it any more: the old `compositing`
   *  class carried `will-change: transform` for a layer that no longer exists. */
  const setMoving = useCallback((active: boolean) => {
    containerRef.current?.classList.toggle('gesturing', active);
  }, []);

  /**
   * The container's position in the window, cached.
   *
   * `getBoundingClientRect()` forces a synchronous layout, so reading it inside a wheel or
   * pointermove handler is layout thrashing. The rectangle only moves when the window or the
   * panel does, so it is read once per gesture and once per wheel burst instead.
   */
  const originRef = useRef({ left: 0, top: 0 });
  const refreshOrigin = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    originRef.current = { left: rect.left, top: rect.top };
  }, []);

  const [tool, setTool] = useState<ERTool>('select');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const effectiveTool: ERTool = spaceHeld ? 'hand' : tool;

  const [detailLevel, setDetailLevel] = useState<ERDetailLevel>('full');
  const [showViews, setShowViews] = useState(true);
  const [showIsolated, setShowIsolated] = useState(true);
  const [showMinimap, setShowMinimap] = useState(true);
  const [selectedTableIds, setSelectedTableIds] = useState<Set<string>>(() => new Set());
  // Hover is NOT state: it changes on every pointer move across a card boundary, and the whole
  // picture is repainted from refs anyway.
  const hoveredTableRef = useRef<string | null>(null);
  const hoveredRelRef = useRef<string | null>(null);
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  const [dimensions, setDimensions] = useState({ width: 1200, height: 800 });

  const dimensionsRef = useRef({ width: 1200, height: 800 });
  const positionsRef = useRef<ERLayoutPositions>({});
  const selectedRef = useRef<Set<string>>(new Set());
  const toolRef = useRef<ERTool>('select');
  // Declared up here with the other mirrors because the sync effect below has to ask whether a
  // drag is in flight before it overwrites `positionsRef`.
  const gestureRef = useRef<Gesture | null>(null);

  // ---------------------------------------------------------------------------------------
  // Viewport
  //
  // ONE copy now. The HTML renderer needed a second, committed one to decide what React should
  // keep mounted; nothing is mounted any more, so a gesture writes this and asks for a frame.
  // ---------------------------------------------------------------------------------------
  const viewportRef = useRef<ERViewport>({ ...INITIAL_VIEWPORT });

  const liveSubsRef = useRef<Set<ERViewportListener>>(new Set());
  const subscribeViewport = useCallback((fn: ERViewportListener) => {
    liveSubsRef.current.add(fn);
    fn(viewportRef.current);
    return () => {
      liveSubsRef.current.delete(fn);
    };
  }, []);

  // ---------------------------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------------------------
  const cacheRef = useRef<ERCardCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new ERCardCache();

  const dprRef = useRef(1);
  /**
   * The scale card bitmaps are rendered at.
   *
   * Deliberately NOT the live zoom: it is re-quantized when a gesture settles, so a wheel burst
   * re-uses the bitmaps it already has and the cards go slightly soft for a moment rather than
   * every visible card re-rendering on every frame. This is the single decision that makes
   * zooming cheap — see the note at the top of `erCardRenderer`.
   */
  const rasterScaleRef = useRef(1);
  const marqueeRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(
    null
  );
  const litRef = useRef<{ nodes: Set<string>; rels: Set<string> }>({
    nodes: new Set(),
    rels: new Set(),
  });

  /** Everything the painter reads that lives in React state, mirrored for the frame loop. */
  const sceneRef = useRef({
    tables: [] as ERTable[],
    tableMap: new Map<string, ERTable>(),
    relationships: [] as ERResolvedRelationship[],
    detailLevel: 'full' as ERDetailLevel,
  });

  const fillPassRef = useRef(0);
  const perfRef = useRef<FrameStats>({
    frames: 0,
    total: 0,
    worst: 0,
    since: 0,
    cards: 0,
    connectors: 0,
    rendered: 0,
  });

  /** Paints one frame. Returns false when cards were left as skeletons — see `CARD_FILL_BUDGET`. */
  const paint = useCallback((): boolean => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return true;

    const measuring = (window as PerfWindow).__erPerfDebug === true;
    const started = measuring ? performance.now() : 0;

    const scene = sceneRef.current;
    const { width, height } = dimensionsRef.current;
    const result = drawScene({
      ctx,
      dpr: dprRef.current,
      width,
      height,
      viewport: viewportRef.current,
      tables: scene.tables,
      tableMap: scene.tableMap,
      positions: positionsRef.current,
      relationships: scene.relationships,
      detailLevel: scene.detailLevel,
      selected: selectedRef.current,
      litNodes: litRef.current.nodes,
      litRels: litRef.current.rels,
      cache: cacheRef.current!,
      palette: erPalette(),
      rasterScale: rasterScaleRef.current,
      marquee: marqueeRef.current,
      fillBudget: CARD_FILL_BUDGET,
    });

    for (const fn of liveSubsRef.current) fn(viewportRef.current);

    if (measuring) {
      const elapsed = performance.now() - started;
      const perf = perfRef.current;
      if (perf.since === 0) perf.since = started;
      perf.frames += 1;
      perf.total += elapsed;
      perf.worst = Math.max(perf.worst, elapsed);
      perf.cards = result.cards;
      perf.connectors = result.connectors;
      perf.rendered += result.rendered;
      if (started - perf.since >= PERF_REPORT_MS) {
        const cache = cacheRef.current!;
        console.log(
          `[er-perf] ${perf.frames} frames | avg ${(perf.total / perf.frames).toFixed(2)}ms | ` +
            `worst ${perf.worst.toFixed(2)}ms | cards ${perf.cards} | ` +
            `connectors ${perf.connectors} | bitmaps rendered ${perf.rendered} | ` +
            `cache ${cache.count} cards / ${(cache.byteSize / 1048576).toFixed(1)}MB | ` +
            `zoom ${viewportRef.current.zoom.toFixed(2)} | raster ${rasterScaleRef.current}`
        );
        perf.frames = 0;
        perf.total = 0;
        perf.worst = 0;
        perf.rendered = 0;
        perf.since = started;
      }
    }

    return result.complete;
  }, []);

  // One rAF slot: a burst of pointermove events produces exactly one frame. The callback is a
  // NAMED function expression so an incomplete frame can queue the next one itself — that is
  // the fill budget's other half, and routing it through a ref only to satisfy the closure
  // would hide it.
  const frameRef = useRef<number | null>(null);
  const requestDraw = useCallback(
    function scheduleFrame(): void {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        if (paint()) {
          fillPassRef.current = 0;
          return;
        }
        if (fillPassRef.current >= MAX_FILL_PASSES) return;
        fillPassRef.current += 1;
        scheduleFrame();
      });
    },
    [paint]
  );

  /** Draws now rather than next frame. The pointer can come up between two frames, and what is
   *  written to localStorage has to be what is on screen. */
  const flush = useCallback(() => {
    if (frameRef.current === null) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    paint();
  }, [paint]);

  const settleRef = useRef<number | null>(null);
  const scheduleSettle = useCallback(() => {
    if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(() => {
      settleRef.current = null;
      setMoving(false);
      const next = quantizeRasterScale(viewportRef.current.zoom, dprRef.current);
      if (next !== rasterScaleRef.current) {
        rasterScaleRef.current = next;
        requestDraw();
      }
    }, WHEEL_SETTLE_MS);
  }, [requestDraw, setMoving]);

  const tweenRef = useRef<number | null>(null);
  const cancelTween = useCallback(() => {
    if (tweenRef.current !== null) {
      cancelAnimationFrame(tweenRef.current);
      tweenRef.current = null;
    }
  }, []);

  /** Eased move to a viewport. Only for COMMANDED changes (fit, reset, fly-to) — never for a
   *  drag or a wheel, where easing reads as lag rather than polish. */
  const animateTo = useCallback(
    (target: ERViewport, duration = TWEEN_MS) => {
      cancelTween();
      setMoving(true);
      const from = { ...viewportRef.current };
      const start = performance.now();
      const step = (now: number) => {
        const time = Math.min((now - start) / duration, 1);
        viewportRef.current = lerpViewport(from, target, time);
        paint();
        if (time < 1) {
          tweenRef.current = requestAnimationFrame(step);
        } else {
          tweenRef.current = null;
          setMoving(false);
          rasterScaleRef.current = quantizeRasterScale(viewportRef.current.zoom, dprRef.current);
          requestDraw();
        }
      };
      tweenRef.current = requestAnimationFrame(step);
    },
    [cancelTween, paint, requestDraw, setMoving]
  );

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (tweenRef.current !== null) cancelAnimationFrame(tweenRef.current);
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    },
    []
  );

  // ---------------------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------------------
  const layoutKey = useMemo(
    () => erLayoutKey(storageScope || connId, database, schema),
    [storageScope, connId, database, schema]
  );
  const sizeKey = useMemo(() => sizeKeyOf(detailLevel, collapsedMap), [detailLevel, collapsedMap]);

  const [layout, setLayout] = useState<LayoutState>(() =>
    reconcileLayout(null, layoutKey, sizeKey, tables, relationships, detailLevel, collapsedMap)
  );

  // Reconciling derived state against changed props belongs in the render pass, not in an
  // effect: an effect would paint the previous layout for one frame first, which at this size is
  // a visible jump of every card.
  if (layout.key !== layoutKey || layout.sizeKey !== sizeKey || layout.tables !== tables) {
    setLayout(
      reconcileLayout(layout, layoutKey, sizeKey, tables, relationships, detailLevel, collapsedMap)
    );
  }

  const positions = layout.positions;

  useEffect(() => {
    if (layout.persist) saveCurrentLayout(layout.key, layout.positions);
  }, [layout]);

  const setPositions = useCallback((next: ERLayoutPositions, persist: boolean) => {
    setLayout((prev) => ({ ...prev, positions: next, persist }));
  }, []);

  // ---------------------------------------------------------------------------------------
  // The table picker
  //
  // Stored per (server, database, schema) beside the layout, and reconciled in the render pass
  // for the same reason the layout is: an effect would paint one frame of the previous
  // database/schema selection before correcting itself.
  // ---------------------------------------------------------------------------------------
  const hiddenKey = useMemo(
    () => erHiddenKey(storageScope || connId, database, schema),
    [storageScope, connId, database, schema]
  );

  const [hidden, setHidden] = useState<{ key: string; names: Set<string> }>(() => ({
    key: hiddenKey,
    names: new Set(loadHiddenTables(hiddenKey)),
  }));
  if (hidden.key !== hiddenKey) {
    setHidden({ key: hiddenKey, names: new Set(loadHiddenTables(hiddenKey)) });
  }
  const hiddenTables = hidden.names;

  /**
   * Writes storage here rather than from an effect watching the state: an effect cannot tell the
   * selection the user just changed from the one it has only finished LOADING, so every diagram
   * opened would write its own selection straight back.
   */
  /** Set when the picker changes something, read when it closes — see `handleTablesApplied`. */
  const pendingFitRef = useRef(false);

  const applyHidden = useCallback(
    (next: Set<string>) => {
      setHidden({ key: hiddenKey, names: next });
      saveHiddenTables(hiddenKey, [...next]);
      pendingFitRef.current = true;
    },
    [hiddenKey]
  );
  // ---------------------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------------------
  /**
   * What the coarse switches in the Filters popover leave on the table. The picker lists exactly
   * this, so a name it offers is always a name that can actually appear — ticking a view while
   * `Show views` is off would otherwise do nothing and look broken.
   */
  const pickableTables = useMemo(() => {
    let list = tables;
    if (!showViews) list = list.filter((table) => table.kind !== 'view');
    if (!showIsolated) {
      const connected = new Set<string>();
      for (const rel of relationships) {
        connected.add(rel.sourceTable);
        connected.add(rel.targetTable);
      }
      list = list.filter((table) => connected.has(table.name));
    }
    return list;
  }, [tables, relationships, showViews, showIsolated]);

  const visibleTables = useMemo(
    () =>
      hiddenTables.size === 0
        ? pickableTables
        : pickableTables.filter((table) => !hiddenTables.has(table.name)),
    [pickableTables, hiddenTables]
  );

  const handleToggleTable = useCallback(
    (name: string) => {
      const next = new Set(hiddenTables);
      // delete() reports whether it removed anything, so one call covers both directions.
      if (!next.delete(name)) next.add(name);
      applyHidden(next);
    },
    [hiddenTables, applyHidden]
  );

  const handleShowAllTables = useCallback(() => applyHidden(new Set()), [applyHidden]);

  const handleHideAllTables = useCallback(
    () => applyHidden(new Set(pickableTables.map((table) => table.name))),
    [pickableTables, applyHidden]
  );

  const handleInvertTables = useCallback(
    () =>
      applyHidden(
        new Set(
          pickableTables.filter((table) => !hiddenTables.has(table.name)).map((table) => table.name)
        )
      ),
    [pickableTables, hiddenTables, applyHidden]
  );

  /**
   * One hop out from what is on screen: unhide every table a foreign key joins to a visible one.
   * This is how a diagram gets built up from a table of interest — pick `rental`, press it, and
   * `customer`, `inventory` and `staff` come with it — without hunting their names in the list.
   */
  const handleShowRelatedTables = useCallback(() => {
    const shown = new Set(visibleTables.map((table) => table.name));
    const next = new Set(hiddenTables);
    for (const rel of relationships) {
      if (shown.has(rel.sourceTable)) next.delete(rel.targetTable);
      if (shown.has(rel.targetTable)) next.delete(rel.sourceTable);
    }
    applyHidden(next);
  }, [visibleTables, relationships, hiddenTables, applyHidden]);

  const visibleNames = useMemo(
    () => new Set(visibleTables.map((table) => table.name)),
    [visibleTables]
  );

  const tableMap = useMemo(() => {
    const map = new Map<string, ERTable>();
    for (const table of visibleTables) map.set(table.name, table);
    return map;
  }, [visibleTables]);

  /**
   * Connectors whose two ends are both in the diagram, with those two tables already looked up.
   *
   * Resolved HERE rather than in the frame loop, because the frame loop runs sixty times a
   * second and this answer only changes when the catalog or a filter does — at 5000 foreign
   * keys, doing it per frame is 20,000 `Map.get` calls for nothing. Geometric culling stays per
   * frame, in `drawScene`; this only drops what a filter toggle removed.
   */
  const visibleRelationships = useMemo(
    () => resolveRelationships(relationships, tableMap),
    [relationships, tableMap]
  );

  /**
   * The positions of the tables actually in the diagram.
   *
   * `positions` holds more than that on purpose: `reconcileLayout` keeps the entry of a table
   * that has vanished from the catalog, so re-adding it later lands it back where the user had
   * put it. But anything that measures the diagram — fit-to-view, the minimap — has to ignore
   * those, or a single stale entry far from the rest stretches the bounding box and the whole
   * diagram renders as a clump in the middle of an enormous empty canvas.
   */
  const visiblePositions = useMemo(() => {
    const out: ERLayoutPositions = {};
    for (const table of visibleTables) {
      const pos = positions[table.name];
      if (pos) out[table.name] = pos;
    }
    return out;
  }, [visibleTables, positions]);
  const visiblePositionsRef = useRef(visiblePositions);

  /**
   * Neighbours of each table, and the connectors touching it. Feeds the focus highlight.
   */
  const hoverGraph = useMemo(() => {
    const neighbours = new Map<string, Set<string>>();
    const rels = new Map<string, string[]>();
    const add = (table: string, other: string, relId: string) => {
      let set = neighbours.get(table);
      if (!set) neighbours.set(table, (set = new Set()));
      set.add(other);
      let list = rels.get(table);
      if (!list) rels.set(table, (list = []));
      list.push(relId);
    };
    for (const rel of relationships) {
      add(rel.sourceTable, rel.targetTable, rel.id);
      add(rel.targetTable, rel.sourceTable, rel.id);
    }
    return { neighbours, rels };
  }, [relationships]);
  const hoverGraphRef = useRef(hoverGraph);

  /**
   * Which tables and connectors are lit, from the selection and what the pointer is over.
   *
   * Sets rather than DOM classes: the old renderer wrote `hl` onto mounted elements and had to
   * re-assert it after every commit, because culling remounted cards without it. The painter
   * reads these two sets and dims everything else with `globalAlpha`.
   */
  const recomputeLit = useCallback(() => {
    const nodes = new Set<string>();
    const rels = new Set<string>();
    const graph = hoverGraphRef.current;

    const lightNeighbourhood = (name: string) => {
      nodes.add(name);
      for (const other of graph.neighbours.get(name) ?? []) nodes.add(other);
      for (const relId of graph.rels.get(name) ?? []) rels.add(relId);
    };

    // SELECTION lights the same neighbourhood as hover, and keeps it: the point of clicking a
    // table is to hold its relationships still while you read them, which hover cannot do. The
    // two are a union rather than a priority, so hovering around does not throw away the
    // selection.
    for (const name of selectedRef.current) lightNeighbourhood(name);

    const hoveredTable = hoveredTableRef.current;
    const hoveredRel = hoveredRelRef.current;
    if (hoveredTable !== null) lightNeighbourhood(hoveredTable);
    else if (hoveredRel !== null) rels.add(hoveredRel);

    litRef.current = { nodes, rels };
  }, []);

  // Every mirror the frame loop reads, refreshed after each render, then one repaint. This
  // replaces both of the old "re-assert after every commit" effects (the transform and the
  // highlight classes) — React owns none of the picture now, so there is one place to sync.
  useLayoutEffect(() => {
    dimensionsRef.current = dimensions;
    // A node drag writes `positionsRef` itself on every frame and only tells React on release,
    // so a render that lands mid-drag — a selection change, a resize, the parent re-rendering —
    // must not put the pre-drag positions back under the pointer.
    if (gestureRef.current?.kind !== 'node') positionsRef.current = positions;
    selectedRef.current = selectedTableIds;
    toolRef.current = effectiveTool;
    visiblePositionsRef.current = visiblePositions;
    hoverGraphRef.current = hoverGraph;
    sceneRef.current = {
      tables: visibleTables,
      tableMap,
      relationships: visibleRelationships,
      detailLevel,
    };
    recomputeLit();
    requestDraw();
  });

  // ---------------------------------------------------------------------------------------
  // Canvas sizing, theme and fonts
  // ---------------------------------------------------------------------------------------
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    const pixelWidth = Math.max(1, Math.round(dimensions.width * dpr));
    const pixelHeight = Math.max(1, Math.round(dimensions.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    if (!ctxRef.current) ctxRef.current = canvas.getContext('2d');
    rasterScaleRef.current = quantizeRasterScale(viewportRef.current.zoom, dpr);
  }, [dimensions]);

  /**
   * A theme switch changes every colour a bitmap was baked with.
   *
   * `erPalette()` keys itself on the `data-theme` attribute, so the cache keys change on their
   * own and the old bitmaps simply stop being asked for — but they still hold their bytes, so
   * the cache is cleared outright rather than left to be evicted one card at a time.
   */
  useEffect(() => {
    const observer = new MutationObserver(() => {
      cacheRef.current?.clear();
      requestDraw();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, [requestDraw]);

  /**
   * Until the bundled fonts finish loading, `fillText` draws the fallback family — and a card
   * bitmap baked then would keep those metrics for the life of the tab.
   */
  useEffect(() => {
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (cancelled) return;
      invalidateErPalette();
      cacheRef.current?.clear();
      requestDraw();
    });
    return () => {
      cancelled = true;
    };
  }, [requestDraw]);

  // ---------------------------------------------------------------------------------------
  // Viewport commands
  // ---------------------------------------------------------------------------------------
  const zoomBy = useCallback(
    (factor: number) => {
      const { width, height } = dimensionsRef.current;
      animateTo(zoomAtPoint(viewportRef.current, factor, width / 2, height / 2), 150);
    },
    [animateTo]
  );

  // Reads the layout and the selection through their refs rather than taking them as
  // dependencies: the toolbar is memoized, and a new `onFitView` identity on every drag frame
  // would re-render it for nothing.
  const fitTo = useCallback(
    (names: Iterable<string> | null, duration = TWEEN_MS) => {
      const { width, height } = dimensionsRef.current;
      // Named tables come from the selection, so they are real; the "everything" case has to
      // ask the visible set rather than every key the layout happens to remember.
      const spots = visiblePositionsRef.current;
      const bounds = boundsOf(names ? positionsRef.current : spots, names ?? Object.keys(spots));
      if (!bounds) return;
      animateTo(fitViewport(bounds, width, height, 64, names ? 1.6 : 1.2), duration);
    },
    [animateTo]
  );

  const handleFitView = useCallback(() => fitTo(null), [fitTo]);

  const handleFitSelection = useCallback(() => {
    const selected = selectedRef.current;
    fitTo(selected.size > 0 ? selected : null);
  }, [fitTo]);

  /**
   * The picker has been shut after changing something. Hiding tables does NOT move the ones
   * that stay — their coordinates were computed for the whole diagram and keeping them is what
   * makes unhiding put a table back where it was, and what protects a hand-dragged layout. The
   * cost is that the survivors can sit far apart with the gaps of everything hidden between
   * them, so the viewport comes to them. Auto layout is still the separate, destructive answer
   * to "put these near each other".
   *
   * On close rather than on each tick: fitting under every checkbox would make the diagram jump
   * while the pointer is still travelling down the list.
   */
  const handleTablesApplied = useCallback(() => {
    if (!pendingFitRef.current) return;
    pendingFitRef.current = false;
    fitTo(null);
  }, [fitTo]);

  const handleResetView = useCallback(() => {
    animateTo({ ...INITIAL_VIEWPORT });
  }, [animateTo]);

  // Container size. The ResizeObserver, rather than window.resize, because the panel changes
  // size when the sidebar collapses or a tab splits and the window does not.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let firstMeasure = true;
    const measure = () => {
      const size = { width: el.clientWidth || 1200, height: el.clientHeight || 800 };
      // Written straight to the ref as well: the initial fit below needs the real size now,
      // not after the state update commits.
      dimensionsRef.current = size;
      refreshOrigin();
      setDimensions(size);
      if (firstMeasure) {
        firstMeasure = false;
        // Opening a few hundred tables at 100% shows three cards in the top-left corner. Fit
        // once, the way every canvas tool does — this moves the viewport, never the nodes, so
        // a hand-arranged layout is untouched. Instant rather than eased: on open there is no
        // place to keep.
        fitTo(null, 0);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitTo, refreshOrigin]);

  const handleAutoLayout = useCallback(() => {
    const next = computeAutoLayout(visibleTables, relationships, detailLevel, collapsedMap);
    for (const [name, spot] of Object.entries(positionsRef.current)) {
      if (!next[name]) next[name] = spot;
    }
    setPositions(next, true);
    const bounds = boundsOf(
      next,
      visibleTables.map((table) => table.name)
    );
    if (bounds) {
      const { width, height } = dimensionsRef.current;
      animateTo(fitViewport(bounds, width, height, 64));
    }
  }, [visibleTables, relationships, detailLevel, collapsedMap, setPositions, animateTo]);

  /** Centre a table and select it. Called with the debounced search text from the toolbar. */
  const handleSearch = useCallback(
    (query: string) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return;
      const matched = visibleTables.find(
        (table) =>
          table.name.toLowerCase().includes(needle) ||
          table.columns.some((col) => col.name.toLowerCase().includes(needle))
      );
      const pos = matched && positionsRef.current[matched.name];
      if (!matched || !pos) return;

      const { width, height } = dimensionsRef.current;
      const zoom = clampZoom(Math.max(viewportRef.current.zoom, 0.8));
      animateTo({
        x: width / 2 - (pos.x + pos.width / 2) * zoom,
        y: height / 2 - (pos.y + pos.height / 2) * zoom,
        zoom,
      });
      setSelectedTableIds(new Set([matched.name]));
    },
    [visibleTables, animateTo]
  );

  const handleZoomIn = useCallback(() => zoomBy(1.2), [zoomBy]);
  const handleZoomOut = useCallback(() => zoomBy(1 / 1.2), [zoomBy]);
  const handleToggleViews = useCallback(() => setShowViews((prev) => !prev), []);
  const handleToggleIsolated = useCallback(() => setShowIsolated((prev) => !prev), []);
  const handleToggleMinimap = useCallback(() => setShowMinimap((prev) => !prev), []);

  const handleToggleCollapse = useCallback((tableName: string) => {
    setCollapsedMap((prev) => ({ ...prev, [tableName]: !prev[tableName] }));
  }, []);

  // ---------------------------------------------------------------------------------------
  // Hit testing
  //
  // Geometry against the same numbers the frame was drawn from. The HTML renderer asked
  // `document.elementFromPoint`, which forces a layout and hit-tests every connector's 14px
  // hitbox stroke — on every pointer move.
  // ---------------------------------------------------------------------------------------
  const worldAt = useCallback((clientX: number, clientY: number) => {
    const origin = originRef.current;
    return screenToWorld(viewportRef.current, clientX - origin.left, clientY - origin.top);
  }, []);

  const tableAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const world = worldAt(clientX, clientY);
      return hitTestCards(sceneRef.current.tables, positionsRef.current, world.x, world.y);
    },
    [worldAt]
  );

  /**
   * Whether a world point lands on a card's collapse chevron.
   *
   * The chevron was a real `<button>` in the HTML card, so it came with a cursor and a hover
   * tint for free. On the canvas it is a box in the header, and the one part of that affordance
   * worth rebuilding is the cursor — without it a clickable target looks like the rest of the
   * card.
   */
  const chevronAt = useCallback(
    (clientX: number, clientY: number, tableName: string | null): boolean => {
      if (!tableName || lodForZoom(viewportRef.current.zoom) === 'blocks') return false;
      const pos = positionsRef.current[tableName];
      if (!pos) return false;
      const world = worldAt(clientX, clientY);
      const box = chevronHitBox(pos);
      return (
        world.x >= box.x &&
        world.x <= box.x + box.width &&
        world.y >= box.y &&
        world.y <= box.y + box.height
      );
    },
    [worldAt]
  );

  const relationshipAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const world = worldAt(clientX, clientY);
      const scene = sceneRef.current;
      const { width, height } = dimensionsRef.current;
      return hitTestRelationships(
        scene.relationships,
        positionsRef.current,
        scene.detailLevel,
        world.x,
        world.y,
        REL_HIT_SCREEN_TOLERANCE / viewportRef.current.zoom,
        // Culled to the screen, because resolving a connector's sockets is O(columns) — see
        // the note on `hitTestRelationships`.
        visibleWorldRect(viewportRef.current, width, height)
      );
    },
    [worldAt]
  );

  /**
   * The `title` the pointer should show.
   *
   * The HTML card put a `title` on every row, which is one attribute per column per mounted
   * card. One string, recomputed only when the pointer reaches a different row, carries the
   * same information — and it is the only place this renderer needs a translation.
   *
   * It goes on the CONTAINER, not on the canvas: the canvas takes no pointer events, so it is
   * never the element under the cursor and a `title` on it would never be shown.
   */
  const tooltipKeyRef = useRef('');
  const updateTooltip = useCallback(
    (clientX: number, clientY: number, tableName: string | null) => {
      const host = containerRef.current;
      if (!host) return;
      let title = '';
      let key = '';

      if (tableName) {
        const table = sceneRef.current.tableMap.get(tableName);
        const pos = positionsRef.current[tableName];
        key = tableName;
        title = tableName;
        if (table && pos && !pos.isCollapsed && lodForZoom(viewportRef.current.zoom) !== 'blocks') {
          const world = worldAt(clientX, clientY);
          const index = Math.floor((world.y - pos.y - HEADER_HEIGHT) / ROW_HEIGHT);
          const columns = visibleColumnsOf(table, sceneRef.current.detailLevel);
          const col = index >= 0 ? columns[index] : undefined;
          if (col) {
            key = `${tableName}.${col.name}`;
            title = col.refTable
              ? tRef.current('er.fkColumnHint', {
                  column: col.name,
                  target: `${col.refTable}.${col.refColumn || col.name}`,
                })
              : col.comment || `${col.name} ${col.type}`;
          }
        }
      }

      if (key === tooltipKeyRef.current) return;
      tooltipKeyRef.current = key;
      host.title = title;
    },
    [worldAt]
  );

  const setHovered = useCallback(
    (table: string | null, rel: string | null) => {
      if (hoveredTableRef.current === table && hoveredRelRef.current === rel) return;
      hoveredTableRef.current = table;
      hoveredRelRef.current = rel;
      recomputeLit();
      requestDraw();
    },
    [recomputeLit, requestDraw]
  );

  // ---------------------------------------------------------------------------------------
  // Wheel: pan, or zoom anchored at the cursor
  // ---------------------------------------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // React attaches `wheel` at the root as PASSIVE, so an onWheel prop cannot preventDefault
      // and the webview zooms the whole app on Ctrl+scroll. A non-passive native listener can.
      e.preventDefault();
      cancelTween();

      // First event of a burst: the only place a wheel is allowed to touch layout.
      if (settleRef.current === null) refreshOrigin();
      const origin = originRef.current;
      if (e.ctrlKey || e.metaKey) {
        // A trackpad pinch arrives here as ctrl+wheel with small deltas, so the exponential
        // keeps both it and a mouse notch proportional. Clamped because a fast wheel can
        // deliver one enormous delta.
        const delta = Math.max(Math.min(e.deltaY, 240), -240);
        viewportRef.current = zoomAtPoint(
          viewportRef.current,
          Math.exp(-delta * 0.002),
          e.clientX - origin.left,
          e.clientY - origin.top
        );
      } else {
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? dimensionsRef.current.height : 1;
        viewportRef.current = {
          ...viewportRef.current,
          x: viewportRef.current.x - e.deltaX * scale,
          y: viewportRef.current.y - e.deltaY * scale,
        };
      }

      setMoving(true);
      requestDraw();
      scheduleSettle();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [cancelTween, refreshOrigin, requestDraw, scheduleSettle, setMoving]);

  // ---------------------------------------------------------------------------------------
  // Pointer gestures (`gestureRef` is declared with the other mirrors, further up)
  // ---------------------------------------------------------------------------------------
  const endGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setMoving(false);
    marqueeRef.current = null;

    if (!gesture) return;
    if (gesture.kind === 'node' && gesture.moved) {
      // The cards are already where they belong; this is React catching up, once, with the
      // positions to persist.
      setPositions(positionsRef.current, true);
    }
    requestDraw();
  }, [requestDraw, setMoving, setPositions]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      // Middle-drag otherwise starts the webview's own autoscroll.
      if (e.button === 1) e.preventDefault();
      const el = containerRef.current;
      if (!el) return;

      const target = e.target as HTMLElement;
      if (target.closest('.er-toolbar-container') || target.closest('.er-minimap-container')) return;

      cancelTween();
      refreshOrigin();
      // Middle-drag pans in either tool; the tool only decides the left button.
      const wantsPan = e.button === 1 || toolRef.current === 'hand';
      const nodeName = wantsPan ? null : tableAt(e.clientX, e.clientY);

      // Tested BEFORE the drag gesture starts, so clicking the chevron can never also move the
      // table — which is what the HTML button's `stopPropagation` used to buy.
      if (nodeName && e.button === 0 && chevronAt(e.clientX, e.clientY, nodeName)) {
        handleToggleCollapse(nodeName);
        return;
      }

      if (wantsPan) {
        gestureRef.current = {
          kind: 'pan',
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          originX: viewportRef.current.x,
          originY: viewportRef.current.y,
        };
      } else if (nodeName) {
        // Selection lands on pointerdown, as in Figma, so a drag always moves what the user is
        // pointing at rather than whatever happened to be selected before.
        let next = selectedRef.current;
        if (e.shiftKey) {
          next = new Set(next);
          if (next.has(nodeName)) next.delete(nodeName);
          else next.add(nodeName);
          setSelectedTableIds(next);
        } else if (!next.has(nodeName)) {
          next = new Set([nodeName]);
          setSelectedTableIds(next);
        }
        selectedRef.current = next;

        // A private copy of the starting positions. Dragging writes a fresh map into
        // `positionsRef` each frame and hands it to React once, on release — the old renderer
        // had to resolve the card elements AND every connector touching them up front, which
        // is exactly the bookkeeping a redrawn canvas does not need.
        const origin: ERLayoutPositions = {};
        for (const name of next) {
          const pos = positionsRef.current[name];
          if (pos) origin[name] = pos;
        }
        gestureRef.current = {
          kind: 'node',
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          origin,
          names: Object.keys(origin),
        };
      } else {
        const world = worldAt(e.clientX, e.clientY);
        gestureRef.current = {
          kind: 'marquee',
          pointerId: e.pointerId,
          startWorldX: world.x,
          startWorldY: world.y,
          additive: e.shiftKey,
        };
      }

      setMoving(true);
      // Dragging a card keeps its own neighbourhood lit, which is how you see where it connects
      // while moving it. A pan or a lasso clears it.
      setHovered(nodeName, null);
      el.setPointerCapture(e.pointerId);
    },
    [
      cancelTween,
      chevronAt,
      handleToggleCollapse,
      refreshOrigin,
      setHovered,
      setMoving,
      tableAt,
      worldAt,
    ]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) {
        // Not dragging: this is hover. The hand tool has nothing to hover — it only pans — and
        // skipping it there is what keeps a pan free of hit tests entirely.
        if (toolRef.current === 'hand') return;
        // The panels float ABOVE the canvas, and their pointer events bubble to this container.
        // Without this, moving across the toolbar lights up whichever table happens to be
        // underneath it.
        const over = e.target as HTMLElement;
        if (over.closest('.er-toolbar-container') || over.closest('.er-minimap-container')) {
          setHovered(null, null);
          return;
        }
        const table = tableAt(e.clientX, e.clientY);
        setHovered(table, table ? null : relationshipAt(e.clientX, e.clientY));
        updateTooltip(e.clientX, e.clientY, table);
        containerRef.current?.classList.toggle(
          'over-chevron',
          chevronAt(e.clientX, e.clientY, table)
        );
        return;
      }
      if (gesture.pointerId !== e.pointerId) return;

      if (gesture.kind === 'pan') {
        viewportRef.current = {
          ...viewportRef.current,
          x: gesture.originX + (e.clientX - gesture.startX),
          y: gesture.originY + (e.clientY - gesture.startY),
        };
        requestDraw();
        return;
      }

      if (gesture.kind === 'node') {
        const zoom = viewportRef.current.zoom;
        const dx = (e.clientX - gesture.startX) / zoom;
        const dy = (e.clientY - gesture.startY) / zoom;
        if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 1) return;
        gesture.moved = true;
        const next: ERLayoutPositions = { ...positionsRef.current };
        for (const name of gesture.names) {
          const start = gesture.origin[name];
          if (!start) continue;
          next[name] = { ...start, x: Math.round(start.x + dx), y: Math.round(start.y + dy) };
        }
        positionsRef.current = next;
        requestDraw();
        return;
      }

      const world = worldAt(e.clientX, e.clientY);
      marqueeRef.current = rectFromCorners(
        gesture.startWorldX,
        gesture.startWorldY,
        world.x,
        world.y
      );
      requestDraw();
    },
    [chevronAt, relationshipAt, requestDraw, setHovered, tableAt, updateTooltip, worldAt]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      flush();

      if (gesture.kind === 'marquee') {
        const world = worldAt(e.clientX, e.clientY);
        const box = rectFromCorners(gesture.startWorldX, gesture.startWorldY, world.x, world.y);
        const hits = marqueeHits(positionsRef.current, box).filter((name) =>
          visibleNames.has(name)
        );
        setSelectedTableIds((prev) => {
          if (!gesture.additive) return new Set(hits);
          const next = new Set(prev);
          for (const name of hits) next.add(name);
          return next;
        });
      }

      endGesture();

      // Pointer capture retargets events to the container, so what is under the cursor has to be
      // found by position — which is now the only way it is ever found.
      if (toolRef.current === 'hand') return;
      setHovered(tableAt(e.clientX, e.clientY), null);
    },
    [endGesture, flush, setHovered, tableAt, visibleNames, worldAt]
  );

  const handlePointerLeave = useCallback(() => {
    setHovered(null, null);
  }, [setHovered]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const name = tableAt(e.clientX, e.clientY);
      if (name && onOpenTable) onOpenTable(name);
    },
    [onOpenTable, tableAt]
  );

  // ---------------------------------------------------------------------------------------
  // Keyboard: tools, Space-to-pan, Figma's zoom shortcuts
  // ---------------------------------------------------------------------------------------
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;

      if (e.code === 'Space') {
        // Without preventDefault, Space also activates whatever toolbar button has focus and
        // scrolls the panel.
        e.preventDefault();
        if (!e.repeat) setSpaceHeld(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.shiftKey) {
        if (e.code === 'Digit0') {
          e.preventDefault();
          handleResetView();
        } else if (e.code === 'Digit1') {
          e.preventDefault();
          handleFitView();
        } else if (e.code === 'Digit2') {
          e.preventDefault();
          handleFitSelection();
        }
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'v') setTool('select');
      else if (key === 'h') setTool('hand');
      else if (e.key === 'Escape') setSelectedTableIds(new Set());
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    // Alt-tabbing away while Space is down never delivers the keyup, and the canvas would stay
    // stuck in the hand tool.
    const onBlur = () => setSpaceHeld(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [handleFitSelection, handleFitView, handleResetView]);

  // ---------------------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------------------
  const handleExport = useCallback(
    async (format: ERExportFormat): Promise<ERExportOutcome | void> => {
      const baseName = `${database || 'database'}_er_diagram`;
      const theme =
        document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

      switch (format) {
        case 'mermaid':
        case 'mermaid-selection': {
          // The selection is read through its ref, like fitTo: a dependency on it would give
          // this callback — and the memoized toolbar — a new identity on every click.
          const selected = selectedRef.current;
          const picked =
            format === 'mermaid-selection'
              ? visibleTables.filter((tb) => selected.has(tb.id))
              : visibleTables;
          const text = exportToMermaid(picked, relationships);
          await navigator.clipboard.writeText(text);
          return { tooLarge: mermaidTooLarge(text) };
        }
        case 'markdown': {
          const targetPath = await pickSaveFilePath(
            `${database || 'database'}_schema`,
            'md',
            'Markdown (*.md)'
          );
          if (!targetPath) return;
          const date = new Date().toLocaleDateString(i18n.language);
          // Indexes are not in the ER catalog, so they are read here — one table after another,
          // not all at once: this is the user's database, possibly production, and a few hundred
          // concurrent introspection queries is exactly what the app avoids elsewhere (the same
          // reason dumpBuilder pages sequentially). Views have no indexes of their own.
          const indexes: Record<string, { name: string; columns: string; unique: boolean }[]> = {};
          for (const tb of visibleTables) {
            if (tb.kind === 'view') continue;
            const info = await dbHelper.getTableSchema(connId, tb.name, tb.schema);
            indexes[tb.name] = info.indexes;
          }
          const doc = exportToMarkdownDoc(visibleTables, relationships, {
            title: t('er.docTitle', { db: database || 'database' }),
            generated: (tableCount, relationCount) =>
              t('er.docGenerated', { date, tables: tableCount, relations: relationCount }),
            contents: t('er.docContents'),
            view: t('er.docView'),
            rows: t('er.docRows'),
            column: t('er.docColumn'),
            type: t('er.docType'),
            nullable: t('er.docNullable'),
            key: t('er.docKey'),
            references: t('er.docReferences'),
            comment: t('er.docComment'),
            yes: t('er.docYes'),
            no: t('er.docNo'),
            referencedBy: t('er.docReferencedBy'),
            none: t('er.docNone'),
            diagramTrimmed: (n) => t('er.docDiagramTrimmed', { n }),
            indexes: t('er.docIndexes'),
            unique: t('er.docUnique'),
          }, indexes);
          await saveExportFileAtPath(targetPath, doc, 'text/markdown');
          break;
        }
        case 'dbml': {
          const targetPath = await pickSaveFilePath(baseName, 'dbml', 'DBML File (*.dbml)');
          if (!targetPath) return;
          await saveExportFileAtPath(
            targetPath,
            exportToDbml(visibleTables, relationships),
            'text/plain'
          );
          break;
        }
        case 'sql': {
          const targetPath = await pickSaveFilePath(baseName, 'sql', 'SQL Script (*.sql)');
          if (!targetPath) return;
          await saveExportFileAtPath(
            targetPath,
            exportToSql(visibleTables, relationships),
            'application/sql'
          );
          break;
        }
        case 'svg': {
          const targetPath = await pickSaveFilePath(baseName, 'svg', 'SVG Image (*.svg)');
          if (!targetPath) return;
          const { svgString } = generateFullDiagramSvg(
            visibleTables,
            relationships,
            positionsRef.current,
            detailLevel,
            theme
          );
          await saveExportFileAtPath(targetPath, svgString, 'image/svg+xml');
          break;
        }
        case 'png': {
          try {
            const targetPath = await pickSaveFilePath(baseName, 'png', 'PNG Image (*.png)');
            if (!targetPath) return;
            const bg = theme === 'light' ? '#f8fafc' : '#0f172a';
            const { svgString, width, height } = generateFullDiagramSvg(
              visibleTables,
              relationships,
              positionsRef.current,
              detailLevel,
              theme
            );
            const { blob } = await exportDiagramToPng(svgString, width, height, 2.0, bg);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            await saveExportFileAtPath(targetPath, bytes, 'image/png');
          } catch (err) {
            console.error('Export PNG failed:', err);
          }
          break;
        }
        case 'clipboard': {
          try {
            const bg = theme === 'light' ? '#f8fafc' : '#0f172a';
            const { svgString, width, height } = generateFullDiagramSvg(
              visibleTables,
              relationships,
              positionsRef.current,
              detailLevel,
              theme
            );
            const { blob } = await exportDiagramToPng(svgString, width, height, 2.0, bg);
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          } catch (err) {
            console.error('Copy to clipboard failed:', err);
          }
          break;
        }
      }
    },
    [connId, database, detailLevel, relationships, visibleTables, t, i18n.language]
  );

  return (
    <div
      className={`er-diagram-container tool-${effectiveTool}`}
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={endGesture}
      onPointerLeave={handlePointerLeave}
      onDoubleClick={handleDoubleClick}
    >
      <ERToolbar
        tool={tool}
        tableCount={visibleTables.length}
        pickableTables={pickableTables}
        hiddenTables={hiddenTables}
        relationCount={relationships.length}
        detailLevel={detailLevel}
        showViews={showViews}
        showIsolated={showIsolated}
        showMinimap={showMinimap}
        hasSelection={selectedTableIds.size > 0}
        subscribeViewport={subscribeViewport}
        onToolChange={setTool}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onFitView={handleFitView}
        onFitSelection={handleFitSelection}
        onResetView={handleResetView}
        onAutoLayout={handleAutoLayout}
        onSearch={handleSearch}
        onDetailLevelChange={setDetailLevel}
        onToggleViews={handleToggleViews}
        onToggleIsolated={handleToggleIsolated}
        onToggleMinimap={handleToggleMinimap}
        onToggleTable={handleToggleTable}
        onShowAllTables={handleShowAllTables}
        onHideAllTables={handleHideAllTables}
        onInvertTables={handleInvertTables}
        onShowRelatedTables={handleShowRelatedTables}
        onTablesApplied={handleTablesApplied}
        onExport={handleExport}
      />

      {/* The diagram. Every card and connector is painted here — see `erScene.ts`. It takes no
          pointer events of its own: the container owns the gestures and answers "what is under
          the cursor" from geometry, so the toolbar and minimap above it still get their clicks
          the ordinary way. */}
      <canvas
        className="er-canvas"
        ref={canvasRef}
        style={{ width: dimensions.width, height: dimensions.height }}
      />

      {showMinimap && (
        <ERMinimap
          positions={visiblePositions}
          selectedTableIds={selectedTableIds}
          containerWidth={dimensions.width}
          containerHeight={dimensions.height}
          subscribeViewport={subscribeViewport}
          onPanTo={animateTo}
        />
      )}
    </div>
  );
};
