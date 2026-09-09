import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import type {
  ERTable,
  ERRelationship,
  ERLayoutPositions,
  ERViewport,
  ERDetailLevel,
  ERExportFormat,
  ERTool,
  ERViewportListener,
} from './erTypes';
import {
  buildFlatConnectorPath,
  computeAutoLayout,
  calculateNodeDimensions,
  computeBezierPath,
  connectorSockets,
} from './erLayoutEngine';
import {
  CULL_MARGIN,
  boundsOf,
  clampZoom,
  fitViewport,
  lerpViewport,
  lodForZoom,
  marqueeHits,
  needsRecommit,
  rectFromCorners,
  connectorHasVisibleEnd,
  connectorIntersects,
  rectIntersectsNode,
  screenToWorld,
  visibleWorldRect,
  zoomAtPoint,
} from './erViewport';
import type { ERLodLevel } from './erViewport';
import { erLayoutKey, loadSavedLayout, saveCurrentLayout } from './erPersistence';
import {
  exportToMermaid,
  exportToDbml,
  exportToSql,
  generateFullDiagramSvg,
  exportDiagramToPng,
} from './erExportHelper';
import { pickSaveFilePath, saveExportFileAtPath } from '../../utils/fileSave';
import { ERTableNode } from './ERTableNode';
import { ERRelationshipLine } from './ERRelationshipLine';
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

/**
 * On the container while anything is selected or hovered: what dims everything not carrying
 * HL_CLASS. Expressed as "everything, except what is lit" so that focusing writes classes on
 * the neighbourhood only, instead of on every mounted card.
 */
const FOCUSED_CLASS = 'focused';
const HL_CLASS = 'hl';

const TWEEN_MS = 260;
/** How long after the last wheel event the viewport is committed to React (LOD + culling). */
const WHEEL_SETTLE_MS = 110;
/** How long the compositor hint outlives the gesture, so bursts share one layer. */
const COMPOSITING_LINGER_MS = 900;

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
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
  /**
   * The lit connectors at the lowest level of detail.
   *
   * There, every connector is one flattened `<path>` with no identity of its own, so there is
   * nothing for `applyHighlight` to add a class to — a selected table's foreign keys were
   * simply lost in the crowd. This second path carries only the focused ones and is written
   * the same imperative way, so it costs a `setAttribute` rather than a render.
   */
  const focusPathRef = useRef<SVGPathElement>(null);

  /**
   * Marks the window in which the transform is being written continuously — a pointer
   * gesture, a wheel, or a tween.
   *
   * TWO classes, because the two things they carry want different lifetimes.
   *
   * `gesturing` is exactly the gesture: it switches off the card transitions and picks the
   * grabbing cursor, so it has to end when the gesture does.
   *
   * `compositing` carries `will-change: transform`, which is what gets the canvas its own
   * compositor layer — moving it is then a composite instead of a repaint of every card.
   * Creating and destroying that layer costs a full rasterization each way, and wheel
   * gestures arrive in bursts, so tying it to the gesture meant paying for a raster per
   * burst. It lingers instead, long enough for consecutive bursts to share one layer, and
   * not so long that a diagram-sized texture is held for the life of the tab.
   */
  const compositingRef = useRef<number | null>(null);
  const setMoving = useCallback((active: boolean) => {
    const el = containerRef.current;
    if (!el) return;
    el.classList.toggle('gesturing', active);
    if (compositingRef.current !== null) window.clearTimeout(compositingRef.current);
    if (active) {
      el.classList.add('compositing');
      compositingRef.current = null;
      return;
    }
    compositingRef.current = window.setTimeout(() => {
      compositingRef.current = null;
      containerRef.current?.classList.remove('compositing');
    }, COMPOSITING_LINGER_MS);
  }, []);

  /**
   * The container's position in the window, cached.
   *
   * `getBoundingClientRect()` forces a synchronous layout, and the frame before it wrote
   * `style.transform` onto the canvas — so reading it inside a wheel or pointermove handler is
   * write/read/write/read layout thrashing over a tree of a couple of thousand elements. It was
   * measured: DevTools flags it as a forced reflow. The rectangle only moves when the window or
   * the panel does, so it is read once per gesture and once per wheel burst instead.
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
  // Hover is NOT state. Crossing a card boundary used to re-render the canvas and change the
  // opacity of every mounted card, with a 0.2s transition — a twelve-frame animation over a
  // few dozen elements per pointer movement. It is now a handful of classList writes.
  const hoveredTableRef = useRef<string | null>(null);
  const hoveredRelRef = useRef<string | null>(null);
  const litElementsRef = useRef<Element[]>([]);
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  const [dimensions, setDimensions] = useState({ width: 1200, height: 800 });

  // Mirrors of state that pointer handlers and rAF jobs read. They exist so those callbacks
  // can stay stable across renders — a new handler identity per render would defeat the memo
  // on every card. They are filled from a layout effect rather than during render (the
  // react/refs rule forbids the latter), which still lands before the browser can deliver the
  // next event.
  const dimensionsRef = useRef({ width: 1200, height: 800 });
  const positionsRef = useRef<ERLayoutPositions>({});
  const selectedRef = useRef<Set<string>>(new Set());
  const toolRef = useRef<ERTool>('select');

  // ---------------------------------------------------------------------------------------
  // Viewport
  //
  // Two copies on purpose. `viewportRef` is the live one: a gesture writes it and pushes the
  // transform straight onto the DOM node, so panning a 300-table diagram costs one style write
  // per frame instead of a React render of every card. `viewport` state is a SNAPSHOT, committed
  // only when the live one has drifted far enough to change what must be mounted (culling) or how
  // much of each card is drawn (LOD) — see `needsRecommit`.
  // ---------------------------------------------------------------------------------------
  const viewportRef = useRef<ERViewport>({ ...INITIAL_VIEWPORT });
  const committedRef = useRef<ERViewport>({ ...INITIAL_VIEWPORT });
  const [viewport, setViewport] = useState<ERViewport>(INITIAL_VIEWPORT);

  const liveSubsRef = useRef<Set<ERViewportListener>>(new Set());
  const subscribeViewport = useCallback((fn: ERViewportListener) => {
    liveSubsRef.current.add(fn);
    fn(viewportRef.current);
    return () => {
      liveSubsRef.current.delete(fn);
    };
  }, []);

  const applyTransform = useCallback(() => {
    const vp = viewportRef.current;
    const el = canvasRef.current;
    if (el) {
      // Transform only. Nothing else may be written here — a custom property, for instance,
      // inherits and would invalidate style for every descendant on every frame.
      el.style.transform = `translate3d(${vp.x}px, ${vp.y}px, 0) scale(${vp.zoom})`;
    }
    for (const fn of liveSubsRef.current) fn(vp);
  }, []);

  // Re-assert the live transform after every render: React does not own that style, so any
  // unrelated re-render (a hover, a selection) would otherwise leave the DOM holding whatever
  // the last commit wrote and the diagram would jump back mid-pan.
  useLayoutEffect(() => {
    applyTransform();
  });

  const commitViewport = useCallback(() => {
    committedRef.current = { ...viewportRef.current };
    setViewport(committedRef.current);
  }, []);

  const maybeCommitViewport = useCallback(() => {
    const { width, height } = dimensionsRef.current;
    if (needsRecommit(committedRef.current, viewportRef.current, width, height)) commitViewport();
  }, [commitViewport]);

  // One rAF slot: a later job replaces the pending one, so a burst of pointermove events
  // produces exactly one update per frame.
  const frameRef = useRef<number | null>(null);
  const jobRef = useRef<(() => void) | null>(null);
  const runPending = useCallback(() => {
    const next = jobRef.current;
    jobRef.current = null;
    next?.();
  }, []);
  const schedule = useCallback(
    (job: () => void) => {
      jobRef.current = job;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        runPending();
      });
    },
    [runPending]
  );
  /** Runs a queued frame now. The pointer can come up between two frames, and the position
   *  written to localStorage has to be the one on screen, not the previous frame's. */
  const flush = useCallback(() => {
    if (frameRef.current === null) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    runPending();
  }, [runPending]);

  const settleRef = useRef<number | null>(null);
  const scheduleSettle = useCallback(() => {
    if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(() => {
      settleRef.current = null;
      setMoving(false);
      commitViewport();
    }, WHEEL_SETTLE_MS);
  }, [commitViewport, setMoving]);

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
        const t = Math.min((now - start) / duration, 1);
        viewportRef.current = lerpViewport(from, target, t);
        applyTransform();
        if (t < 1) {
          maybeCommitViewport();
          tweenRef.current = requestAnimationFrame(step);
        } else {
          tweenRef.current = null;
          // A pointer gesture that interrupted the tween called `cancelTween` first, so this
          // branch can only run when nothing else is moving the canvas.
          setMoving(false);
          commitViewport();
        }
      };
      tweenRef.current = requestAnimationFrame(step);
    },
    [applyTransform, cancelTween, commitViewport, maybeCommitViewport, setMoving]
  );

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (tweenRef.current !== null) cancelAnimationFrame(tweenRef.current);
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
      if (compositingRef.current !== null) window.clearTimeout(compositingRef.current);
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

  useLayoutEffect(() => {
    dimensionsRef.current = dimensions;
    positionsRef.current = positions;
    selectedRef.current = selectedTableIds;
    toolRef.current = effectiveTool;
  }, [dimensions, positions, selectedTableIds, effectiveTool]);

  // What building the focus path needs. Mirrored rather than closed over, so
  // `applyHighlight` keeps one identity and the layout effect that calls it needs no deps.
  const connectorCtxRef = useRef({
    byId: new Map<string, ERRelationship>(),
    lod: 'full' as ERLodLevel,
    detailLevel: 'full' as ERDetailLevel,
    tables: new Map<string, ERTable>(),
  });

  useEffect(() => {
    if (layout.persist) saveCurrentLayout(layout.key, layout.positions);
  }, [layout]);

  const setPositions = useCallback((next: ERLayoutPositions, persist: boolean) => {
    setLayout((prev) => ({ ...prev, positions: next, persist }));
  }, []);

  // ---------------------------------------------------------------------------------------
  // Filtering, culling and level of detail
  // ---------------------------------------------------------------------------------------
  const visibleTables = useMemo(() => {
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

  const visibleNames = useMemo(
    () => new Set(visibleTables.map((table) => table.name)),
    [visibleTables]
  );

  const lod = useMemo(() => lodForZoom(viewport.zoom), [viewport.zoom]);

  const cullRect = useMemo(
    () => visibleWorldRect(viewport, dimensions.width, dimensions.height, CULL_MARGIN),
    [viewport, dimensions]
  );

  /**
   * Only the tables near the viewport are mounted. This is what makes panning a large diagram
   * possible at all: without it every re-render reconciles a few hundred cards and a few
   * thousand column rows, and with it the DOM holds roughly what fits on screen plus a margin.
   */
  const renderedTables = useMemo(
    () =>
      visibleTables.filter((table) => {
        const pos = positions[table.name];
        return !!pos && rectIntersectsNode(cullRect, pos);
      }),
    [visibleTables, positions, cullRect]
  );

  /**
   * Neighbours of each table, and the connectors touching it. Feeds both the hover highlight
   * and the culling exemption below, so it is declared before either.
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

  /**
   * Connectors that culling may not drop: the ones belonging to a selected table.
   *
   * Selecting a table is a request to hold its relationships still, and culling by geometry
   * broke exactly that — pan away from the selection and both ends of its connectors leave the
   * screen, so the lines the user asked to keep were the first thing thrown out. There are only
   * ever as many as the selection has foreign keys.
   *
   * Hover needs no such exemption: while hovering you are pointing at the table, so it is on
   * screen by definition. It is also not state, so it could not take part in this memo.
   */
  const pinnedRelIds = useMemo(() => {
    if (selectedTableIds.size === 0) return null;
    const ids = new Set<string>();
    for (const name of selectedTableIds) {
      for (const id of hoverGraph.rels.get(name) ?? []) ids.add(id);
    }
    return ids;
  }, [selectedTableIds, hoverGraph]);

  const renderedRelationships = useMemo(
    () =>
      relationships.filter((rel) => {
        if (!visibleNames.has(rel.sourceTable) || !visibleNames.has(rel.targetTable)) return false;
        const src = positions[rel.sourceTable];
        const tgt = positions[rel.targetTable];
        if (!src || !tgt) return false;
        if (pinnedRelIds?.has(rel.id)) return true;
        // Two tests, because the two levels of detail cost completely different things per
        // connector — see connectorHasVisibleEnd.
        return lod === 'blocks'
          ? connectorIntersects(cullRect, src, tgt)
          : connectorHasVisibleEnd(cullRect, src, tgt);
      }),
    [relationships, visibleNames, positions, cullRect, lod, pinnedRelIds]
  );

  const tableMap = useMemo(() => {
    const map = new Map<string, ERTable>();
    for (const table of visibleTables) map.set(table.name, table);
    return map;
  }, [visibleTables]);

  /**
   * At the lowest level of detail every connector collapses into ONE path element.
   *
   * This is the case culling cannot touch: fit-to-view on a few hundred tables puts every
   * card and every connector on screen at once, so the only way to spend less is to draw the
   * same picture with fewer objects. Nothing is lost — at that zoom a connector cannot be
   * hovered, highlighted or dimmed on its own.
   */
  const flatConnectorPath = useMemo(() => {
    if (lod !== 'blocks') return '';
    return buildFlatConnectorPath(renderedRelationships, positions, tableMap, detailLevel);
  }, [lod, renderedRelationships, positions, tableMap, detailLevel]);

  /**
   * The connector layer follows the culling rectangle rather than covering the diagram.
   *
   * It used to be sized to the whole thing, which on a few hundred tables is an element of
   * 11000x7000 sitting inside the layer the compositor has to keep a texture for. The
   * `viewBox` matches the box one-to-one, so the connectors keep their world coordinates and
   * nothing inside needs translating.
   *
   * Snapped to a grid so panning does not change the geometry on every commit, and padded
   * past the cull rect by more than the bezier reach (`relationshipBox`), so a curve whose
   * endpoints are just off screen is not clipped at the edge.
   */
  const relationshipsById = useMemo(
    () => new Map(relationships.map((rel) => [rel.id, rel])),
    [relationships]
  );

  useLayoutEffect(() => {
    connectorCtxRef.current = { byId: relationshipsById, lod, detailLevel, tables: tableMap };
  }, [relationshipsById, lod, detailLevel, tableMap]);

  const connectorBox = useMemo(() => {
    const SNAP = 512;
    const PAD = 512;
    const x = Math.floor((cullRect.minX - PAD) / SNAP) * SNAP;
    const y = Math.floor((cullRect.minY - PAD) / SNAP) * SNAP;
    return {
      x,
      y,
      width: Math.ceil((cullRect.maxX + PAD) / SNAP) * SNAP - x,
      height: Math.ceil((cullRect.maxY + PAD) / SNAP) * SNAP - y,
    };
  }, [cullRect]);

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
      const spots = positionsRef.current;
      const bounds = boundsOf(spots, names ?? Object.keys(spots));
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
        // a hand-arranged layout is untouched.
        //
        // Instant, not eased: the eased version zoomed from 100% out to the fitted zoom, and
        // on the way it crossed both culling and level-of-detail boundaries, so opening the
        // tab paid for several whole re-renders at progressively heavier settings. An eased
        // move helps you keep your place, and on open there is no place to keep.
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

  /**
   * Lights the selected and hovered tables, their FK neighbours and the connectors between
   * them, by writing classes onto the DOM. `.focused` on the container is what dims
   * everything else, so the number of writes is the size of the neighbourhood rather than
   * the size of the diagram.
   *
   * Re-applied after every render as well (the effect right below), because culling mounts
   * and unmounts cards and a freshly mounted one arrives without the class.
   */
  const applyHighlight = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    for (const el of litElementsRef.current) el.classList.remove(HL_CLASS);
    litElementsRef.current = [];

    // Which names to light, then ONE pass over what is mounted. Building
    // `[data-er-node="…"]` selectors from table and constraint names would have to escape them
    // first — they are user data, not identifiers — and only saves a walk over a set that
    // culling already keeps down to what is roughly on screen.
    const litNodes = new Set<string>();
    const litRels = new Set<string>();

    const lightNeighbourhood = (name: string) => {
      litNodes.add(name);
      for (const other of hoverGraph.neighbours.get(name) ?? []) litNodes.add(other);
      for (const relId of hoverGraph.rels.get(name) ?? []) litRels.add(relId);
    };

    // SELECTION lights the same neighbourhood as hover, and keeps it: the point of clicking a
    // table is to hold its relationships still while you read them, which hover cannot do
    // because it ends the moment the pointer moves away. The two are a union rather than a
    // priority, so hovering around does not throw away what is selected.
    for (const name of selectedRef.current) lightNeighbourhood(name);

    const hoveredTable = hoveredTableRef.current;
    const hoveredRel = hoveredRelRef.current;
    if (hoveredTable !== null) lightNeighbourhood(hoveredTable);
    else if (hoveredRel !== null) litRels.add(hoveredRel);

    const focused = litNodes.size > 0 || litRels.size > 0;
    container.classList.toggle(FOCUSED_CLASS, focused);
    if (!focused) {
      focusPathRef.current?.setAttribute('d', '');
      return;
    }

    const lit: Element[] = [];
    for (const el of container.querySelectorAll<HTMLElement>('[data-er-node]')) {
      const name = el.dataset.erNode;
      if (name && litNodes.has(name)) {
        el.classList.add(HL_CLASS);
        lit.push(el);
      }
    }
    for (const el of container.querySelectorAll('[data-er-rel]')) {
      const id = el.getAttribute('data-er-rel');
      if (id && litRels.has(id)) {
        el.classList.add(HL_CLASS);
        lit.push(el);
      }
    }

    litElementsRef.current = lit;

    // At `blocks` the classes above found no connector to light, because there is only the
    // one flattened path. Draw the lit ones again into a path of their own.
    const focusEl = focusPathRef.current;
    const ctx = connectorCtxRef.current;
    if (focusEl && ctx.lod === 'blocks') {
      const focusRels: ERRelationship[] = [];
      for (const id of litRels) {
        const rel = ctx.byId.get(id);
        if (rel) focusRels.push(rel);
      }
      focusEl.setAttribute(
        'd',
        buildFlatConnectorPath(focusRels, positionsRef.current, ctx.tables, ctx.detailLevel)
      );
    }
  }, [hoverGraph]);

  // Culling remounts cards as the viewport moves, and React knows nothing about these classes,
  // so they have to be re-asserted after EVERY commit — hence no dependency array, the same as
  // the transform effect above. With nothing hovered this returns after one classList.toggle.
  useLayoutEffect(() => {
    applyHighlight();
  });

  /**
   * Everything a node drag needs, resolved once when the drag starts.
   *
   * Dragging was the last path that went through React on every frame: one `setPositions` per
   * pointer move re-rendered the whole culled set and recomputed every connector, and at the
   * zooms where a hundred-odd cards are mounted that is the expensive kind of frame. What a drag
   * actually changes is bounded — the cards under the pointer and the connectors touching them —
   * so it moves them itself and lets React see the result once, on release.
   *
   * Resolving the elements up front is also what keeps the drag consistent: the level of detail
   * and the connector list cannot change mid-gesture, because nothing commits during one.
   */
  interface DragPlan {
    /** Private mutable copy. Unmoved entries keep their identity, so the memos still bail out. */
    live: ERLayoutPositions;
    cards: { name: string; el: HTMLElement; startX: number; startY: number }[];
    edges: {
      rel: ERRelationship;
      sourceTable: ERTable;
      targetTable: ERTable;
      hitbox: SVGPathElement | null;
      path: SVGPathElement | null;
      sourceDot: SVGCircleElement | null;
      targetDot: SVGCircleElement | null;
    }[];
    /** At the lowest level of detail every connector is one path, rebuilt whole. */
    flat: { el: SVGPathElement; rels: ERRelationship[] } | null;
    tables: Map<string, ERTable>;
    detailLevel: ERDetailLevel;
  }

  const dragPlanRef = useRef<DragPlan | null>(null);

  const buildDragPlan = useCallback(
    (names: Set<string>): DragPlan | null => {
      const container = containerRef.current;
      if (!container) return null;

      const live: ERLayoutPositions = { ...positionsRef.current };
      const cards: DragPlan['cards'] = [];
      for (const el of container.querySelectorAll<HTMLElement>('[data-er-node]')) {
        const name = el.dataset.erNode;
        const pos = name ? live[name] : undefined;
        if (!name || !pos || !names.has(name)) continue;
        cards.push({ name, el, startX: pos.x, startY: pos.y });
      }

      const wanted = new Set<string>();
      for (const name of names) {
        for (const id of hoverGraph.rels.get(name) ?? []) wanted.add(id);
      }
      const byId = new Map(renderedRelationships.map((rel) => [rel.id, rel]));

      const edges: DragPlan['edges'] = [];
      for (const group of container.querySelectorAll('[data-er-rel]')) {
        const id = group.getAttribute('data-er-rel');
        const rel = id ? byId.get(id) : undefined;
        if (!rel || !wanted.has(rel.id)) continue;
        const sourceTable = tableMap.get(rel.sourceTable);
        const targetTable = tableMap.get(rel.targetTable);
        if (!sourceTable || !targetTable) continue;
        edges.push({
          rel,
          sourceTable,
          targetTable,
          hitbox: group.querySelector<SVGPathElement>('.er-rel-hitbox'),
          path: group.querySelector<SVGPathElement>('.er-rel-path'),
          sourceDot: group.querySelector<SVGCircleElement>('.er-rel-socket-source'),
          targetDot: group.querySelector<SVGCircleElement>('.er-rel-socket-target'),
        });
      }

      const flatEl = container.querySelector<SVGPathElement>('.er-rel-path.bare');
      return {
        live,
        cards,
        edges,
        flat: flatEl ? { el: flatEl, rels: renderedRelationships } : null,
        tables: tableMap,
        detailLevel,
      };
    },
    [detailLevel, hoverGraph, renderedRelationships, tableMap]
  );

  const applyDragFrame = useCallback((dx: number, dy: number) => {
    const plan = dragPlanRef.current;
    if (!plan) return;

    for (const card of plan.cards) {
      const x = Math.round(card.startX + dx);
      const y = Math.round(card.startY + dy);
      const pos = plan.live[card.name];
      if (pos) plan.live[card.name] = { ...pos, x, y };
      card.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }

    for (const edge of plan.edges) {
      const sourcePos = plan.live[edge.rel.sourceTable];
      const targetPos = plan.live[edge.rel.targetTable];
      if (!sourcePos || !targetPos) continue;
      const { source, target } = connectorSockets(
        edge.rel,
        edge.sourceTable,
        edge.targetTable,
        sourcePos,
        targetPos,
        plan.detailLevel
      );
      const d = computeBezierPath(source, target);
      edge.hitbox?.setAttribute('d', d);
      edge.path?.setAttribute('d', d);
      edge.sourceDot?.setAttribute('cx', String(source.x));
      edge.sourceDot?.setAttribute('cy', String(source.y));
      edge.targetDot?.setAttribute('cx', String(target.x));
      edge.targetDot?.setAttribute('cy', String(target.y));
    }

    if (plan.flat) {
      plan.flat.el.setAttribute(
        'd',
        buildFlatConnectorPath(plan.flat.rels, plan.live, plan.tables, plan.detailLevel)
      );
    }
  }, []);

  const setHovered = useCallback(
    (table: string | null, rel: string | null) => {
      if (hoveredTableRef.current === table && hoveredRelRef.current === rel) return;
      hoveredTableRef.current = table;
      hoveredRelRef.current = rel;
      applyHighlight();
    },
    [applyHighlight]
  );

  const handleToggleCollapse = useCallback((tableName: string) => {
    setCollapsedMap((prev) => ({ ...prev, [tableName]: !prev[tableName] }));
  }, []);

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
        const scale =
          e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? dimensionsRef.current.height : 1;
        viewportRef.current = {
          ...viewportRef.current,
          x: viewportRef.current.x - e.deltaX * scale,
          y: viewportRef.current.y - e.deltaY * scale,
        };
      }

      setMoving(true);
      schedule(() => {
        applyTransform();
        maybeCommitViewport();
      });
      scheduleSettle();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [
    applyTransform,
    cancelTween,
    maybeCommitViewport,
    refreshOrigin,
    schedule,
    scheduleSettle,
    setMoving,
  ]);

  // ---------------------------------------------------------------------------------------
  // Pointer gestures
  // ---------------------------------------------------------------------------------------
  const gestureRef = useRef<Gesture | null>(null);


  const showMarquee = useCallback((rect: { x: number; y: number; w: number; h: number } | null) => {
    const el = marqueeRef.current;
    if (!el) return;
    if (!rect) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
    // Kept on the marquee itself rather than on the scaled layer: it inherits, and on the
    // layer it would re-style every card and connector underneath. This element has no
    // descendants, and it only changes while a lasso is actually being drawn.
    el.style.setProperty('--er-inv-zoom', String(1 / viewportRef.current.zoom));
  }, []);

  const endGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setMoving(false);
    showMarquee(null);

    const plan = dragPlanRef.current;
    dragPlanRef.current = null;

    if (!gesture) return;
    if (gesture.kind === 'pan') {
      commitViewport();
    } else if (gesture.kind === 'node' && gesture.moved && plan) {
      // The cards and connectors are already where they belong; this is React catching up,
      // once, with the positions to persist.
      setPositions(plan.live, true);
    }
  }, [commitViewport, setMoving, setPositions, showMarquee]);

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
      const nodeName = wantsPan
        ? null
        : (target.closest('[data-er-node]') as HTMLElement | null)?.dataset.erNode ?? null;

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

        dragPlanRef.current = buildDragPlan(next);
        gestureRef.current = {
          kind: 'node',
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
      } else {
        const origin = originRef.current;
        const world = screenToWorld(
          viewportRef.current,
          e.clientX - origin.left,
          e.clientY - origin.top
        );
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
    [buildDragPlan, cancelTween, refreshOrigin, setHovered, setMoving]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== e.pointerId) return;

      if (gesture.kind === 'pan') {
        const dx = e.clientX - gesture.startX;
        const dy = e.clientY - gesture.startY;
        viewportRef.current = {
          ...viewportRef.current,
          x: gesture.originX + dx,
          y: gesture.originY + dy,
        };
        schedule(() => {
          applyTransform();
          maybeCommitViewport();
        });
        return;
      }

      if (gesture.kind === 'node') {
        const zoom = viewportRef.current.zoom;
        const dx = (e.clientX - gesture.startX) / zoom;
        const dy = (e.clientY - gesture.startY) / zoom;
        if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 1) return;
        gesture.moved = true;
        // Straight to the DOM, like the pan. React sees the result once, on release.
        schedule(() => applyDragFrame(dx, dy));
        return;
      }

      const origin = originRef.current;
      const world = screenToWorld(
        viewportRef.current,
        e.clientX - origin.left,
        e.clientY - origin.top
      );
      const box = rectFromCorners(gesture.startWorldX, gesture.startWorldY, world.x, world.y);
      schedule(() =>
        showMarquee({
          x: box.minX,
          y: box.minY,
          w: box.maxX - box.minX,
          h: box.maxY - box.minY,
        })
      );
    },
    [applyDragFrame, applyTransform, maybeCommitViewport, schedule, showMarquee]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      flush();

      if (gesture.kind === 'marquee') {
        const origin = originRef.current;
        const world = screenToWorld(
          viewportRef.current,
          e.clientX - origin.left,
          e.clientY - origin.top
        );
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

      // Pointer capture retargets events to the container, so the node under the cursor has to
      // be found by position rather than read off the event. This forces a layout AND a hit
      // test that walks every connector path, so it is skipped for the hand tool — where the
      // node layer takes no pointer events and the answer would always be null anyway.
      if (toolRef.current === 'hand') return;
      const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const node =
        (under?.closest('[data-er-node]') as HTMLElement | null)?.dataset.erNode ?? null;
      setHovered(node, null);
    },
    [endGesture, flush, setHovered, visibleNames]
  );

  const handlePointerOver = useCallback(
    (e: React.PointerEvent) => {
      if (gestureRef.current || toolRef.current === 'hand') return;
      const target = e.target as HTMLElement;
      const node = (target.closest('[data-er-node]') as HTMLElement | null)?.dataset.erNode ?? null;
      const rel = node
        ? null
        : (target.closest('[data-er-rel]') as HTMLElement | null)?.getAttribute('data-er-rel') ??
          null;
      setHovered(node, rel);
    },
    [setHovered]
  );

  const handlePointerLeave = useCallback(() => {
    setHovered(null, null);
  }, [setHovered]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const name = (
        (e.target as HTMLElement).closest('[data-er-node]') as HTMLElement | null
      )?.dataset.erNode;
      if (name && onOpenTable) onOpenTable(name);
    },
    [onOpenTable]
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
    async (format: ERExportFormat) => {
      const baseName = `${database || 'database'}_er_diagram`;
      const theme =
        document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

      switch (format) {
        case 'mermaid': {
          await navigator.clipboard.writeText(exportToMermaid(visibleTables, relationships));
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
    [database, detailLevel, relationships, visibleTables]
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
      onPointerOver={handlePointerOver}
      onPointerLeave={handlePointerLeave}
      onDoubleClick={handleDoubleClick}
    >
      <ERToolbar
        tool={tool}
        tableCount={visibleTables.length}
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
        onExport={handleExport}
      />

      {/* The transformed world. React never writes `transform` here — `applyTransform` does. */}
      <div className="er-canvas-layer" ref={canvasRef}>
        <svg
          className="er-svg-connectors-layer"
          width={connectorBox.width}
          height={connectorBox.height}
          viewBox={`${connectorBox.x} ${connectorBox.y} ${connectorBox.width} ${connectorBox.height}`}
          // Placed with a transform rather than left/top: it is a computed value that moves
          // with the viewport, and a transform costs no layout.
          style={{ transform: `translate3d(${connectorBox.x}px, ${connectorBox.y}px, 0)` }}
        >
          <defs>
            <marker
              id="er-marker-target-arrow"
              viewBox="0 0 10 10"
              refX="6"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 5 L 0 9 z" fill="var(--win-accent)" />
            </marker>
            <marker
              id="er-marker-source-dot"
              viewBox="0 0 10 10"
              refX="5"
              refY="5"
              markerWidth="5"
              markerHeight="5"
            >
              <circle cx="5" cy="5" r="3" fill="var(--win-accent)" />
            </marker>
          </defs>

          {lod === 'blocks' && flatConnectorPath && (
            <path d={flatConnectorPath} className="er-rel-path bare" />
          )}

          {/* Filled by applyHighlight, never by React — see focusPathRef. */}
          <path ref={focusPathRef} className="er-rel-path focus" />

          {lod !== 'blocks' &&
            renderedRelationships.map((rel) => {
              const src = tableMap.get(rel.sourceTable);
              const tgt = tableMap.get(rel.targetTable);
              const srcPos = positions[rel.sourceTable];
              const tgtPos = positions[rel.targetTable];
              if (!src || !tgt || !srcPos || !tgtPos) return null;

              return (
                <ERRelationshipLine
                  key={rel.id}
                  relationship={rel}
                  sourceTable={src}
                  targetTable={tgt}
                  sourcePos={srcPos}
                  targetPos={tgtPos}
                  detailLevel={detailLevel}
                  lod={lod}
                />
              );
            })}
        </svg>

        <div className="er-nodes-layer">
          {renderedTables.map((table) => {
            const pos = positions[table.name];
            if (!pos) return null;

            return (
              <ERTableNode
                key={table.name}
                table={table}
                position={pos}
                detailLevel={detailLevel}
                lod={lod}
                isSelected={selectedTableIds.has(table.name)}
                onToggleCollapse={handleToggleCollapse}
              />
            );
          })}
        </div>

        {/* Lasso. It lives inside the transformed layer so its coordinates are world units and
            it needs no inverse transform; only its border thickness is divided back out. */}
        <div className="er-marquee" ref={marqueeRef} hidden />
      </div>

      {showMinimap && (
        <ERMinimap
          positions={positions}
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
