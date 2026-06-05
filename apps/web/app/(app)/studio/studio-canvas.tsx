'use client';

/**
 * The Studio wiring canvas — the agent→skill (uses) + agent→agent (delegates)
 * DAG, laid out with dagre and rendered with @xyflow/react. Read-only in Phase 1
 * (no dragging, no edge-drawing); clicking a node selects it for the inspector.
 *
 * Mirrors the layout mechanics of /traces (apps/web/app/(app)/traces/[id]/
 * trace-detail.tsx) — same dagre→xyflow position transform.
 */

import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  ReactFlowProvider,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { Star } from 'lucide-react';
import type { StudioNode, StudioEdge } from '@/lib/studio/graph';

const NODE_W = 220;
const NODE_H = 66;

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

function buildFlow(
  studioNodes: StudioNode[],
  studioEdges: StudioEdge[],
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of studioNodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of studioEdges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const nodes: Node[] = studioNodes.map((n) => {
    const pos = g.node(n.id);
    const unhealthy = n.issues.length > 0;
    const selected = n.id === selectedId;
    return {
      id: n.id,
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { label: <NodeLabel node={n} /> },
      style: {
        width: NODE_W,
        height: NODE_H,
        borderRadius: 10,
        border: `1px solid ${unhealthy ? 'var(--destructive)' : 'var(--border)'}`,
        background: n.kind === 'agent' ? 'var(--card)' : n.kind === 'group' ? 'var(--accent)' : 'var(--muted)',
        color: 'var(--card-foreground)',
        padding: 0,
        opacity: n.enabled ? 1 : 0.55,
        boxShadow: selected ? '0 0 0 2px var(--primary)' : undefined,
      },
    };
  });

  const edges: Edge[] = studioEdges
    .filter((e) => g.hasNode(e.source) && g.hasNode(e.target))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
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
