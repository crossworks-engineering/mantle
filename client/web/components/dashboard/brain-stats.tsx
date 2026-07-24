import { AlertTriangle, Boxes, CheckCircle2, Network, Sparkles } from 'lucide-react';
import type { BrainCounts, GraphIntegrity, VectorCounts } from '@server/lib/dashboard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@mantle/web-ui/ui/card';
import { formatCount } from '@mantle/web-ui/lib/format-bytes';
import { VitalsBar } from './vitals-bar';

/** Memory-index coverage (how much of the brain is embedded/searchable) plus
 *  graph headline counts. Server component — no charts, just bars + numbers. */
export function BrainStats({
  vectors,
  brain,
  integrity,
}: {
  vectors: VectorCounts;
  brain: BrainCounts;
  integrity: GraphIntegrity;
}) {
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-base">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden /> Memory index
        </CardTitle>
        <CardDescription>
          {formatCount(vectors.vectorsTotal)} vectors indexed ·{' '}
          {formatCount(vectors.embeddingCacheRows)} cached
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <VitalsBar
          label="Nodes embedded"
          value={`${formatCount(vectors.nodesIndexed)} / ${formatCount(vectors.nodesTotal)}`}
          pct={pct(vectors.nodesIndexed, vectors.nodesTotal)}
        />
        <VitalsBar
          label="Facts embedded"
          value={`${formatCount(vectors.factsIndexed)} / ${formatCount(vectors.factsTotal)}`}
          pct={pct(vectors.factsIndexed, vectors.factsTotal)}
        />
        <VitalsBar
          label="Entities embedded"
          value={`${formatCount(vectors.entitiesIndexed)} / ${formatCount(vectors.entitiesTotal)}`}
          pct={pct(vectors.entitiesIndexed, vectors.entitiesTotal)}
        />
        <div className="grid grid-cols-3 gap-2 border-t pt-3 text-center">
          <Stat
            icon={<Boxes className="size-4" />}
            label="Entities"
            value={formatCount(brain.entitiesTotal)}
          />
          <Stat
            icon={<Network className="size-4" />}
            label="Edges"
            value={formatCount(brain.edgesTotal)}
          />
          <Stat
            icon={<Sparkles className="size-4" />}
            label="Facts"
            value={formatCount(brain.factsTotal)}
          />
        </div>
        <GraphIntegrityRow integrity={integrity} />
      </CardContent>
    </Card>
  );
}

/** Duplicate-edge guard. Healthy = clean; a non-zero count flags a regression
 *  in edge writing — the remedy is the one-shot `pnpm dedupe:edges --apply`,
 *  not a recurring auto-clean (which would mask it). */
function GraphIntegrityRow({ integrity }: { integrity: GraphIntegrity }) {
  const clean = integrity.duplicateEdgeGroups === 0;
  if (clean) {
    return (
      <div className="flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden />
        Graph integrity: no duplicate edges
      </div>
    );
  }
  return (
    <div className="space-y-1 border-t pt-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3.5" aria-hidden />
        {formatCount(integrity.duplicateEdgeGroups)} duplicate edge group
        {integrity.duplicateEdgeGroups === 1 ? '' : 's'} ·{' '}
        {formatCount(integrity.redundantEdgeRows)} redundant row
        {integrity.redundantEdgeRows === 1 ? '' : 's'}
      </div>
      <p className="text-muted-foreground">
        Edge writing may have regressed. Remedy: <code>pnpm dedupe:edges --apply</code> (one-shot).
      </p>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-center text-muted-foreground">{icon}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
