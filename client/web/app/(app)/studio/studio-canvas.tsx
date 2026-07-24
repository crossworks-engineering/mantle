'use client';

/**
 * The Studio wiring canvas — the focused agent's star subgraph (skills +
 * delegates + tool groups), rendered with @xyflow/react. Read-only in Phase 1
 * (no dragging, no edge-drawing); clicking a node selects it for the inspector.
 *
 * Layout is hand-rolled around the star shape (studio-view always feeds one
 * focused agent + its direct targets — no deeper chains), replacing the earlier
 * dagre rankdir=LR pass that stacked every satellite into one long vertical
 * column:
 *
 *           [delegate] [delegate]          ← horizontal row, into the card's TOP
 *                 │       │
 *               [ main agent ]  ──→ [skill]   ← skills column off the RIGHT
 *                 │       │         [skill]
 *           [ group ]  [ group ]          ← horizontal row, out of the card's BOTTOM
 */

import { useMemo } from 'react';
import {
  Handle,
  Position,
  ReactFlow,
  Background,
  Controls,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Star } from 'lucide-react';
import type { StudioNode, StudioEdge } from '@server/lib/studio/graph';

const NODE_W = 220;
const NODE_H = 66;
/** Horizontal gap between cards within the delegate/group rows. */
const ROW_GAP_X = 24;
/** Vertical distance between the delegate row, the main card, and the group row. */
const ROW_GAP_Y = 88;
/** Horizontal distance from the layout's right edge to the skills column. */
const COL_GAP_X = 96;
/** Vertical gap between cards in the skills column. */
const SKILL_GAP_Y = 16;

/** Where a node sits in the star — drives both its position and its handle side. */
type StarRole = 'main' | 'delegate' | 'group' | 'skill';

/** Handles are connection points only (the canvas is read-only) — keep them
 *  invisible so the cards stay clean. */
const HANDLE_STYLE: React.CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  pointerEvents: 'none',
};

function NodeLabel({ node }: { node: StudioNode }) {
  const unhealthy = node.issues.length > 0;
  return (
    <div className="flex h-full w-full flex-col justify-center gap-0.5 px-3 py-2 text-left">
      <div className="flex items-center gap-1.5">
        <span
          className={
            'size-2 shrink-0 rounded-full ' +
            (!node.enabled
              ? 'bg-muted-foreground/40'
              : unhealthy
                ? 'bg-destructive'
                : 'bg-emerald-500')
          }
          aria-hidden
        />
        <span className="truncate text-xs font-medium">{node.label}</span>
        {node.isPersona && <Star className="size-3 shrink-0 text-amber-500" aria-hidden />}
      </div>
      <div className="flex items-center gap-1.5 pl-3.5 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-wider">{node.kind}</span>
        <span className="truncate">· {node.sublabel}</span>
      </div>
    </div>
  );
}

/** Custom node: the main card sources edges from three sides (top → delegates,
 *  bottom → groups, right → skills); satellites take their edge on the side
 *  facing the main card. */
function StarNode({ data }: NodeProps) {
  const { node, role } = data as unknown as { node: StudioNode; role: StarRole };
  return (
    <>
      {role === 'main' ? (
        <>
          <Handle type="source" position={Position.Top} id="top" style={HANDLE_STYLE} />
          <Handle type="source" position={Position.Bottom} id="bottom" style={HANDLE_STYLE} />
          <Handle type="source" position={Position.Right} id="right" style={HANDLE_STYLE} />
        </>
      ) : (
        <Handle
          type="target"
          position={
            role === 'delegate' ? Position.Bottom : role === 'group' ? Position.Top : Position.Left
          }
          style={HANDLE_STYLE}
        />
      )}
      <NodeLabel node={node} />
    </>
  );
}

const nodeTypes = { star: StarNode };

/** Cards per row before the delegate/group bands wrap onto another line —
 *  Saskia grants ~17 groups; one unwrapped row forces fitView to an unreadable
 *  zoom. */
const MAX_PER_ROW = 5;
/** Vertical gap between wrapped lines within one band. */
const BAND_GAP_Y = 20;

/** Width of a horizontal row of n cards. */
function rowWidth(n: number): number {
  return n > 0 ? n * NODE_W + (n - 1) * ROW_GAP_X : 0;
}

/** Chunk a band's nodes into rows of MAX_PER_ROW. */
function chunkRows<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_PER_ROW) rows.push(items.slice(i, i + MAX_PER_ROW));
  return rows;
}

/** Height of a band of n cards once wrapped. */
function bandHeight(n: number): number {
  const rows = Math.ceil(n / MAX_PER_ROW);
  return rows > 0 ? rows * NODE_H + (rows - 1) * BAND_GAP_Y : 0;
}

/** Lay a band out as centred, wrapped rows starting at `startY`, stacking
 *  downward. Each (possibly partial) row centres on `cx`. */
function placeBand(
  items: { id: string }[],
  cx: number,
  startY: number,
  positions: Map<string, { x: number; y: number }>,
): void {
  chunkRows(items).forEach((row, r) => {
    const startX = cx - rowWidth(row.length) / 2;
    row.forEach((n, i) => {
      positions.set(n.id, {
        x: startX + i * (NODE_W + ROW_GAP_X),
        y: startY + r * (NODE_H + BAND_GAP_Y),
      });
    });
  });
}

function buildFlow(
  studioNodes: StudioNode[],
  studioEdges: StudioEdge[],
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  // The star centre: every edge studio-view feeds originates from the focused
  // agent. Fall back to the first agent node for the edgeless case.
  const mainId = studioEdges[0]?.source ?? studioNodes.find((n) => n.kind === 'agent')?.id ?? null;

  const roleByNode = new Map<string, StarRole>();
  for (const n of studioNodes) {
    if (n.id === mainId) roleByNode.set(n.id, 'main');
    else if (n.kind === 'agent') roleByNode.set(n.id, 'delegate');
    else if (n.kind === 'group') roleByNode.set(n.id, 'group');
    else roleByNode.set(n.id, 'skill');
  }

  const delegates = studioNodes.filter((n) => roleByNode.get(n.id) === 'delegate');
  const groups = studioNodes.filter((n) => roleByNode.get(n.id) === 'group');
  const skills = studioNodes.filter((n) => roleByNode.get(n.id) === 'skill');

  // Centre the delegate band, the main card, and the group band on one axis.
  const maxRowW = Math.max(
    rowWidth(Math.min(delegates.length, MAX_PER_ROW)),
    rowWidth(Math.min(groups.length, MAX_PER_ROW)),
    NODE_W,
  );
  const cx = maxRowW / 2;
  const delegBandH = bandHeight(delegates.length);
  const mainY = delegBandH > 0 ? delegBandH + ROW_GAP_Y : 0;
  const groupsY = mainY + NODE_H + ROW_GAP_Y;
  const mainCenterY = mainY + NODE_H / 2;

  const positions = new Map<string, { x: number; y: number }>();
  if (mainId) positions.set(mainId, { x: cx - NODE_W / 2, y: mainY });
  placeBand(delegates, cx, 0, positions);
  placeBand(groups, cx, groupsY, positions);
  // Skills column to the right, clear of whichever row is widest, vertically
  // centred on the main card.
  const skillsX = cx + maxRowW / 2 + COL_GAP_X;
  const skillsTotalH = skills.length * NODE_H + Math.max(0, skills.length - 1) * SKILL_GAP_Y;
  skills.forEach((n, i) => {
    positions.set(n.id, {
      x: skillsX,
      y: mainCenterY - skillsTotalH / 2 + i * (NODE_H + SKILL_GAP_Y),
    });
  });

  const nodes: Node[] = studioNodes.map((n) => {
    const unhealthy = n.issues.length > 0;
    const selected = n.id === selectedId;
    return {
      id: n.id,
      type: 'star',
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: { node: n, role: roleByNode.get(n.id) ?? 'skill' },
      style: {
        width: NODE_W,
        height: NODE_H,
        borderRadius: 10,
        border: `1px solid ${unhealthy ? 'var(--destructive)' : 'var(--border)'}`,
        background:
          n.kind === 'agent'
            ? 'var(--card)'
            : n.kind === 'group'
              ? 'var(--accent)'
              : 'var(--muted)',
        color: 'var(--card-foreground)',
        padding: 0,
        opacity: n.enabled ? 1 : 0.55,
        boxShadow: selected ? '0 0 0 2px var(--primary)' : undefined,
      },
    };
  });

  const validIds = new Set(studioNodes.map((n) => n.id));
  const edges: Edge[] = studioEdges
    .filter((e) => validIds.has(e.source) && validIds.has(e.target))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.kind === 'delegate' ? 'top' : e.kind === 'group' ? 'bottom' : 'right',
      animated: e.kind === 'delegate',
      style:
        e.kind === 'delegate'
          ? { stroke: 'rgb(59 130 246)', strokeWidth: 1.5, strokeDasharray: '4 3' }
          : e.kind === 'group'
            ? { stroke: 'rgb(139 92 246)', strokeWidth: 1.5 }
            : { stroke: 'rgb(148 163 184)', strokeWidth: 1.5 },
    }));

  return { nodes, edges };
}

export function StudioCanvas({
  nodes: studioNodes,
  edges: studioEdges,
  selectedId,
  onSelect,
}: {
  nodes: StudioNode[];
  edges: StudioEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(
    () => buildFlow(studioNodes, studioEdges, selectedId),
    [studioNodes, studioEdges, selectedId],
  );

  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_e, n) => onSelect(n.id)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.2}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
