'use client';

/**
 * Collapsible, syntax-colored JSON tree for the response viewer.
 * Colors come from the categorical chart tokens so all ~40 themes hold.
 * Hovering a row reveals copy-value / copy-path actions.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const INITIAL_DEPTH = 3;

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="italic text-muted-foreground">null</span>;
  switch (typeof value) {
    case 'string':
      return <span className="text-chart-2 break-all">&quot;{value}&quot;</span>;
    case 'number':
      return <span className="text-chart-3">{String(value)}</span>;
    case 'boolean':
      return <span className="text-chart-4">{String(value)}</span>;
    default:
      return <span className="text-muted-foreground">{String(value)}</span>;
  }
}

function Node({
  nodeKey,
  value,
  path,
  depth,
}: {
  nodeKey: string | null;
  value: unknown;
  path: string;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < INITIAL_DEPTH);
  const toast = useToast();

  const isObject = value !== null && typeof value === 'object';
  const entries: Array<[string, unknown]> = isObject
    ? Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(value as Record<string, unknown>)
    : [];

  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${what}`),
      () => toast.error('Copy failed'),
    );
  };

  const keyLabel =
    nodeKey !== null ? (
      <span className="text-chart-1">&quot;{nodeKey}&quot;</span>
    ) : null;

  if (!isObject) {
    return (
      <div className="group flex items-start gap-1 rounded px-1 hover:bg-muted/50">
        <span className="min-w-0 flex-1">
          {keyLabel}
          {keyLabel && <span className="text-muted-foreground">: </span>}
          <Primitive value={value} />
        </span>
        <span className="invisible flex shrink-0 gap-0.5 group-hover:visible">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0"
            title={`Copy value (${path || '$'})`}
            onClick={() => copy(typeof value === 'string' ? value : JSON.stringify(value), 'value')}
          >
            <Copy className="size-3" />
          </Button>
        </span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;

  return (
    <div>
      <div className="group flex items-start gap-1 rounded px-1 hover:bg-muted/50">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-0.5 text-left"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">
            {keyLabel}
            {keyLabel && <span className="text-muted-foreground">: </span>}
            <span className="text-muted-foreground">
              {isArray ? '[' : '{'}
              {!open && (
                <span className="mx-1 text-[10px] uppercase tracking-wide">{summary}</span>
              )}
              {!open && (isArray ? ']' : '}')}
            </span>
          </span>
        </button>
        <span className="invisible flex shrink-0 gap-0.5 group-hover:visible">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0"
            title={`Copy JSON (${path || '$'})`}
            onClick={() => copy(JSON.stringify(value, null, 2), 'JSON')}
          >
            <Copy className="size-3" />
          </Button>
        </span>
      </div>
      {open && (
        <div className={cn('border-l border-border/60 pl-4', depth === 0 && 'ml-1')}>
          {entries.map(([k, v]) => (
            <Node
              key={k}
              nodeKey={isArray ? null : k}
              value={v}
              path={isArray ? `${path}[${k}]` : path ? `${path}.${k}` : k}
              depth={depth + 1}
            />
          ))}
          <div className="px-1 text-muted-foreground">{isArray ? ']' : '}'}</div>
        </div>
      )}
    </div>
  );
}

export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="font-mono text-xs leading-5">
      <Node nodeKey={null} value={value} path="" depth={0} />
    </div>
  );
}
