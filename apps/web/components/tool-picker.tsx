'use client';

/**
 * Shared tool multi-select. Groups tools by handler kind (built-in / http /
 * shell), shows each tool's slug + a "confirm" badge for gated tools, and is
 * searchable + collapsible via the underlying ToggleList. Used by both the
 * agents form (the agent's tool allowlist) and the skills form (the tools a
 * skill folds into any agent it's attached to) so the two stay identical.
 */

import { ToggleList, type ToggleListItem } from '@/components/toggle-list';

export type ToolOption = {
  slug: string;
  name: string;
  description: string;
  requiresConfirm: boolean;
  kind: string;
};

export function ToolPicker({
  available,
  selected,
  onChange,
}: {
  available: ToolOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  // Group by handler kind so built-ins, http, shell each cluster.
  const items: ToggleListItem[] = available.map((t) => ({
    value: t.slug,
    label: t.name,
    description: t.description,
    group: t.kind,
    meta: (
      <>
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
          {t.slug}
        </code>
        {t.requiresConfirm && (
          <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
            confirm
          </span>
        )}
      </>
    ),
  }));
  return (
    <ToggleList items={items} selected={selected} onChange={onChange} collapsible searchable />
  );
}
