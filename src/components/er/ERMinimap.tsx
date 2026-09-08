import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { ERLayoutPositions, ERViewport, ERViewportSubscribe } from './erTypes';
import { computeDiagramBounds } from './erLayoutEngine';
import { clampZoom } from './erViewport';

interface ERMinimapProps {
  positions: ERLayoutPositions;
  /** Drawn in the accent colour, so the minimap answers "where is the thing I picked". */
  selectedTableIds: Set<string>;
  containerWidth: number;
  containerHeight: number;
  /** Live viewport feed. The indicator follows a pan at 60fps without re-rendering the rects. */
  subscribeViewport: ERViewportSubscribe;
  onPanTo: (target: ERViewport, duration?: number) => void;
}

const MINIMAP_WIDTH = 208;
const MINIMAP_HEIGHT = 140;
const PADDING = 16;

/**
 * The viewport is shown by DIMMING everything outside it rather than by painting a translucent
 * slab over it. Two reasons, both of which the slab got wrong:
 *
 *  - a filled rectangle sits on top of the very node rects the user is looking for, and at a few
 *    hundred tables those rects are only a few pixels each to begin with;
 *  - the slab had to be clamped to the box, so the moment the viewport reached past the diagram
 *    the rectangle was cut down to the minimap's own edges and rendered as a corner with two
 *    borders and no shape. Dimming needs no clamping: the shade is cropped by the SVG, and a
 *    viewport larger than the whole diagram correctly leaves the map completely clear.
 */
const ERMinimapInner: React.FC<ERMinimapProps> = ({
  positions,
  selectedTableIds,
  containerWidth,
  containerHeight,
  subscribeViewport,
  onPanTo,
}) => {
  const minimapRef = useRef<HTMLDivElement>(null);
  const holeRef = useRef<SVGRectElement>(null);
  const frameRef = useRef<SVGRectElement>(null);
  const lastViewportRef = useRef<ERViewport>({ x: 0, y: 0, zoom: 1 });

  // The node rects are the expensive half and they only matter as a rough shape, so they are
  // allowed to lag a drag by a frame or two instead of being recomputed with it.
  const deferredPositions = useDeferredValue(positions);

  const geometry = useMemo(() => {
    const bounds = computeDiagramBounds(deferredPositions);
    const totalWidth = bounds.width + PADDING * 2;
    const totalHeight = bounds.height + PADDING * 2;
    const scale = Math.min(MINIMAP_WIDTH / totalWidth, MINIMAP_HEIGHT / totalHeight);
    return {
      originX: bounds.minX - PADDING,
      originY: bounds.minY - PADDING,
      scale,
      offsetX: (MINIMAP_WIDTH - totalWidth * scale) / 2,
      offsetY: (MINIMAP_HEIGHT - totalHeight * scale) / 2,
    };
  }, [deferredPositions]);

  const geometryRef = useRef(geometry);

  const drawIndicator = useCallback(
    (vp: ERViewport) => {
      lastViewportRef.current = vp;
      const hole = holeRef.current;
      const frame = frameRef.current;
      if (!hole || !frame) return;

      const geom = geometryRef.current;
      const x = (-vp.x / vp.zoom - geom.originX) * geom.scale + geom.offsetX;
      const y = (-vp.y / vp.zoom - geom.originY) * geom.scale + geom.offsetY;
      const w = (containerWidth / vp.zoom) * geom.scale;
      const h = (containerHeight / vp.zoom) * geom.scale;

      // Clamped only to a legal SVG size, never to the box: letting the rectangle keep its real
      // shape is the whole point, and the SVG crops whatever falls outside.
      for (const el of [hole, frame]) {
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('width', String(Math.max(0, w)));
        el.setAttribute('height', String(Math.max(0, h)));
      }
    },
    [containerWidth, containerHeight]
  );

  useEffect(() => subscribeViewport(drawIndicator), [subscribeViewport, drawIndicator]);

  // The indicator is placed from geometry that changes with the layout, so it has to be redrawn
  // after a render too — the live feed only fires while a gesture is running. The geometry mirror
  // is set here rather than during render because the react/refs rule forbids touching a ref in
  // the render pass, and it must be set BEFORE the redraw below reads it.
  useLayoutEffect(() => {
    geometryRef.current = geometry;
    drawIndicator(lastViewportRef.current);
  }, [geometry, drawIndicator]);

  const panToPoint = useCallback(
    (clientX: number, clientY: number, duration: number) => {
      const el = minimapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const geom = geometryRef.current;
      const worldX = (clientX - rect.left - geom.offsetX) / geom.scale + geom.originX;
      const worldY = (clientY - rect.top - geom.offsetY) / geom.scale + geom.originY;
      const zoom = clampZoom(lastViewportRef.current.zoom);
      onPanTo(
        {
          x: -(worldX * zoom - containerWidth / 2),
          y: -(worldY * zoom - containerHeight / 2),
          zoom,
        },
        duration
      );
    },
    [containerWidth, containerHeight, onPanTo]
  );

  const draggingRef = useRef(false);

  return (
    <div
      className="er-minimap-container"
      ref={minimapRef}
      onPointerDown={(e) => {
        e.stopPropagation();
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        panToPoint(e.clientX, e.clientY, 180);
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current) return;
        // Zero duration while dragging: an eased tween per frame would fight the pointer.
        panToPoint(e.clientX, e.clientY, 0);
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
    >
      <svg width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT} className="er-minimap-svg">
        <defs>
          {/* White and black here are mask luminance, not colours — white keeps the shade,
              black punches the viewport out of it. They must NOT become theme tokens. */}
          <mask id="er-minimap-spotlight">
            <rect x="0" y="0" width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT} fill="#fff" />
            <rect ref={holeRef} rx="2" fill="#000" />
          </mask>
        </defs>

        {Object.entries(deferredPositions).map(([tableName, pos]) => (
          <rect
            key={tableName}
            className={`er-minimap-node ${selectedTableIds.has(tableName) ? 'selected' : ''}`}
            x={(pos.x - geometry.originX) * geometry.scale + geometry.offsetX}
            y={(pos.y - geometry.originY) * geometry.scale + geometry.offsetY}
            width={Math.max(pos.width * geometry.scale, 2)}
            height={Math.max(pos.height * geometry.scale, 1.5)}
            rx={1}
          />
        ))}

        <rect
          className="er-minimap-shade"
          x="0"
          y="0"
          width={MINIMAP_WIDTH}
          height={MINIMAP_HEIGHT}
          mask="url(#er-minimap-spotlight)"
        />
        <rect ref={frameRef} className="er-minimap-frame" rx="2" />
      </svg>
    </div>
  );
};

export const ERMinimap = React.memo(ERMinimapInner);
