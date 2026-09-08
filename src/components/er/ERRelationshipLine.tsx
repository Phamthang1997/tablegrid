import React from 'react';
import type { ERRelationship, ERTable, ERNodePosition, ERDetailLevel } from './erTypes';
import type { ERLodLevel } from './erViewport';
import { connectorSockets, computeBezierPath } from './erLayoutEngine';

interface ERRelationshipLineProps {
  relationship: ERRelationship;
  sourceTable: ERTable;
  targetTable: ERTable;
  /**
   * The two endpoints, not the whole `ERLayoutPositions` map. Dragging one table replaces that
   * map on every frame, so a line taking the map could never memo out — taking the two entries
   * lets every line that does not touch the dragged node skip its render entirely.
   */
  sourcePos: ERNodePosition;
  targetPos: ERNodePosition;
  detailLevel: ERDetailLevel;
  /**
   * Never `blocks` — the canvas draws that level as a single flattened path, so this
   * component is not mounted there at all.
   */
  lod: ERLodLevel;
}

const ERRelationshipLineInner: React.FC<ERRelationshipLineProps> = ({
  relationship,
  sourceTable,
  targetTable,
  sourcePos,
  targetPos,
  detailLevel,
  lod,
}) => {
  const { source: sourceSocket, target: targetSocket } = connectorSockets(
    relationship,
    sourceTable,
    targetTable,
    sourcePos,
    targetPos,
    detailLevel
  );

  const path = computeBezierPath(sourceSocket, targetSocket);

  return (
    // `highlighted` / `dimmed` are written onto this element by the canvas, not passed in:
    // see the note in ERTableNode.
    <g data-er-rel={relationship.id} className="er-rel-group">
      <path d={path} className="er-rel-hitbox" />
      {/* The arrow and dot markers, and the dash pattern, only at `full`. Markers are the
          most expensive thing SVG can put on a path — two instances per connector — and at
          half zoom both they and a 4-and-2 dash are under a device pixel. */}
      <path
        d={path}
        className={`er-rel-path ${lod === 'full' ? 'dashed' : ''}`}
        markerStart={lod === 'full' ? 'url(#er-marker-source-dot)' : undefined}
        markerEnd={lod === 'full' ? 'url(#er-marker-target-arrow)' : undefined}
      />
      {lod === 'full' && (
        <>
          <circle cx={targetSocket.x} cy={targetSocket.y} r={3.5} className="er-rel-socket-target" />
          <circle cx={sourceSocket.x} cy={sourceSocket.y} r={3.5} className="er-rel-socket-source" />
        </>
      )}
    </g>
  );
};

export const ERRelationshipLine = React.memo(ERRelationshipLineInner);
