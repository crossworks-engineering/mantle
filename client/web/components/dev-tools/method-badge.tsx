import { cn } from '@mantle/web-ui/lib/utils';
import type { HttpMethod, RequestKind } from '@/lib/dev-tools/types';

/** Color-coded HTTP method label — semantic inks, AA-safe on any surface. */
const METHOD_CLASSES: Record<HttpMethod, string> = {
  GET: 'text-info-ink',
  POST: 'text-success-ink',
  PUT: 'text-warning-ink',
  PATCH: 'text-primary-ink',
  DELETE: 'text-destructive-ink',
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
        kind === 'mcp' ? 'text-primary-ink' : 'text-warning-ink',
        className,
      )}
    >
      {kind === 'mcp' ? 'MCP' : 'TOOL'}
    </span>
  );
}
