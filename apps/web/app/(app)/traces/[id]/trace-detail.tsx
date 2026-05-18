'use client';

import { useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
  ReactFlowProvider,
} from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';
import type { TraceDetail as TraceDetailType, TraceStepSummary } from '@/lib/traces';
import { formatDuration } from '@/lib/traces';

const NODE_W = 260;
const NODE_H = 80;

export function TraceDetail({ trace }: { trace: TraceDetailType }) {
  const [selectedId, setSelectedId] = useState<string | null>(
    trace.steps[0]?.id ?? null,
  );

  const { nodes, edges } = useMemo(() => buildGraph(trace.steps), [trace.steps]);

  const selected = useMemo(
    () => trace.steps.find((s) => s.id === selectedId) ?? null,
    [trace.steps, selectedId],
  );

  if (trace.steps.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        No steps recorded for this trace.
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="h-[640px] rounded-md border border-border bg-muted/20">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes.map((n) =>
              n.id === selectedId
                ? { ...n, selected: true, style: { ...n.style, boxShadow: '0 0 0 2px rgb(59 130 246)' } }
                : n,
            )}
            edges={edges}
            onNodeClick={(_e, n) => setSelectedId(n.id)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
          >
            <Background gap={16} size={1} />
            <Controls />
          </ReactFlow>
        </ReactFlowProvider>
      </div>

      <aside className="rounded-md border border-border bg-card p-3 text-sm">
        {selected ? <StepPanel step={selected} /> : <p>Click a step.</p>}
      </aside>
    </div>
  );
}

function buildGraph(steps: TraceStepSummary[]): { nodes: Node[]; edges: Edge[] } {
  // Build a dagre graph for top-down layout.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const s of steps) {
    g.setNode(s.id, { width: NODE_W, height: NODE_H });
  }

  // Edges: parent → child (nesting). For root-level steps (no parent),
  // chain them sequentially by ordinal.
  const rootByOrdinal = [...steps]
    .filter((s) => !s.parentStepId)
    .sort((a, b) => a.ordinal - b.ordinal);
  for (let i = 1; i < rootByOrdinal.length; i++) {
    g.setEdge(rootByOrdinal[i - 1]!.id, rootByOrdinal[i]!.id);
  }
  for (const s of steps) {
    if (s.parentStepId) {
      g.setEdge(s.parentStepId, s.id);
    }
  }

  dagre.layout(g);

  const nodes: Node[] = steps.map((s) => {
    const pos = g.node(s.id);
    return {
      id: s.id,
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { label: <StepNodeLabel step={s} /> },
      style: {
        width: NODE_W,
        height: NODE_H,
        borderRadius: 8,
        border: `1px solid ${borderForStatus(s.status)}`,
        background: bgForStatus(s.status),
        padding: 0,
      },
    };
  });

  const edges: Edge[] = g.edges().map((e) => ({
    id: `${e.v}__${e.w}`,
    source: e.v,
    target: e.w,
    style: { stroke: 'rgb(148 163 184)', strokeWidth: 1.5 },
  }));

  return { nodes, edges };
}

function StepNodeLabel({ step }: { step: TraceStepSummary }) {
  return (
    <div className="flex h-full w-full flex-col gap-1 px-3 py-2 text-left">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium text-xs">{step.name}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {formatDuration(step.durationMs)}
        </span>
      </div>
      <div className="flex items-baseline gap-2 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-wider">{step.kind}</span>
        {step.status !== 'success' && (
          <span
            className={
              step.status === 'error'
                ? 'text-destructive'
                : step.status === 'skipped'
                  ? 'text-muted-foreground/70'
                  : 'text-amber-700 dark:text-amber-300'
            }
          >
            {step.status}
          </span>
        )}
      </div>
      {summaryLine(step) && (
        <div className="truncate text-[10px] text-muted-foreground">{summaryLine(step)}</div>
      )}
    </div>
  );
}

function summaryLine(s: TraceStepSummary): string | null {
  // Surface a single line of "what happened" inferred from meta/output.
  const m = s.meta;
  if (typeof m.model === 'string') {
    const tin = num(m.tokens_in);
    const tout = num(m.tokens_out);
    if (tin + tout > 0) return `${m.model} · ${tin}+${tout}`;
    return `${m.model}`;
  }
  if (typeof m.cache_hits === 'number') {
    return `cache ${m.cache_hits}/${num(m.cache_hits) + num(m.cache_misses)} · api ${num(m.api_calls)}`;
  }
  const o = s.output;
  if (typeof o.count === 'number') return `count ${o.count}`;
  return null;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function borderForStatus(status: string): string {
  switch (status) {
    case 'success':
      return 'rgb(16 185 129)'; // emerald
    case 'error':
      return 'rgb(239 68 68)'; // red
    case 'running':
      return 'rgb(245 158 11)'; // amber
    case 'skipped':
      return 'rgb(148 163 184)'; // slate
    default:
      return 'rgb(148 163 184)';
  }
}

function bgForStatus(status: string): string {
  switch (status) {
    case 'success':
      return 'rgb(236 253 245)'; // emerald-50
    case 'error':
      return 'rgb(254 226 226)'; // red-100
    case 'running':
      return 'rgb(254 243 199)'; // amber-100
    case 'skipped':
      return 'rgb(241 245 249)'; // slate-100
    default:
      return 'rgb(255 255 255)';
  }
}

function StepPanel({ step }: { step: TraceStepSummary }) {
  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{step.name}</h3>
        <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
          <span className="rounded-sm bg-muted px-1.5 py-0.5 uppercase tracking-wider">
            {step.kind}
          </span>
          <span>{step.status}</span>
          <span>{formatDuration(step.durationMs)}</span>
        </div>
      </div>

      {step.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs">
          <div className="text-[10px] uppercase tracking-wider text-destructive">error</div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{step.error}</pre>
        </div>
      )}

      <JsonBlock title="Input" value={step.input} />
      <JsonBlock title="Output" value={step.output} />
      <JsonBlock title="Meta" value={step.meta} />
    </div>
  );
}

function JsonBlock({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown>;
}) {
  if (!value || Object.keys(value).length === 0) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</h4>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
