import { cn } from '@mantle/web-ui/lib/utils';
import type { HttpMethod, RequestKind } from '@/lib/dev-tools/types';

/** Color-coded HTTP method label. Categorical, so chart tokens (theme-safe). */
const METHOD_CLASSES: Record<HttpMethod, string> = {
  GET: 'text-chart-2',
  POST: 'text-chart-3',
  PUT: 'text-chart-1',
  PATCH: 'text-chart-4',
  DELETE: 'text-destructive',
};

export function MethodBadge({ method, className }: { method: HttpMethod; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block w-12 shrink-0 font-mono text-[10px] font-bold tracking-wide',
        METHOD_CLASSES[method],
        className,
      )}
    >
      {method}
    </span>
  );
}

/** Same slot, for non-http entries (agent tools / MCP tools). */
export function KindBadge({ kind, className }: { kind: RequestKind; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block w-12 shrink-0 font-mono text-[10px] font-bold tracking-wide',
        kind === 'mcp' ? 'text-chart-5' : 'text-chart-4',
        className,
      )}
    >
      {kind === 'mcp' ? 'MCP' : 'TOOL'}
    </span>
  );
}
