'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useColorTheme } from '@mantle/web-ui/color-theme-provider';

/**
 * Every token themes.css ships, as swatches with their resolved value. The
 * groups mirror the generator's own contract layers (see docs/themes.md): the
 * authored fills, the on-fill foregrounds solved against them, the inks solved
 * against every neutral surface, and the data-ink ramps. A token missing here
 * is a token nobody can audition.
 */
const GROUPS: Array<{ label: string; hint?: string; tokens: string[] }> = [
  {
    label: 'Surfaces',
    hint: 'Authored. Every ink below is solved to stay legible on these.',
    tokens: [
      'background',
      'foreground',
      'card',
      'card-foreground',
      'popover',
      'popover-foreground',
      'muted',
      'muted-foreground',
    ],
  },
  {
    label: 'Fills & their foregrounds',
    hint: 'Solved as pairs — text on a fill is never borrowed from elsewhere.',
    tokens: [
      'primary',
      'primary-foreground',
      'secondary',
      'secondary-foreground',
      'accent',
      'accent-foreground',
      'destructive',
      'destructive-foreground',
      'success',
      'success-foreground',
      'warning',
      'warning-foreground',
      'info',
      'info-foreground',
    ],
  },
  {
    label: 'Inks',
    hint: 'Coloured text on neutral surfaces, at 4.5:1. Use these, never the fill.',
    tokens: ['primary-ink', 'destructive-ink', 'success-ink', 'warning-ink', 'info-ink'],
  },
  {
    label: 'Code',
    hint: 'Syntax palette — keyword carries the brand hue, the rest are fixed.',
    tokens: ['code-keyword', 'code-string', 'code-number', 'code-title', 'code-variable'],
  },
  {
    label: 'Borders & rings',
    tokens: ['border', 'input', 'ring'],
  },
  {
    label: 'Charts',
    hint: 'Categorical data ink at 3:1 — decoration, not text.',
    tokens: ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'],
  },
  {
    label: 'Sidebar',
    tokens: [
      'sidebar',
      'sidebar-foreground',
      'sidebar-primary',
      'sidebar-primary-foreground',
      'sidebar-accent',
      'sidebar-accent-foreground',
      'sidebar-border',
      'sidebar-ring',
    ],
  },
];

const ALL_TOKENS = GROUPS.flatMap((g) => g.tokens);

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-muted/60">
      <div
        className="size-12 shrink-0 rounded-md border"
        style={{ backgroundColor: `var(--${name})` }}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium leading-tight">{name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{value || '—'}</p>
      </div>
    </div>
  );
}

export function ColorPalette() {
  // The swatch chips paint from the CSS var directly, so they always follow the
  // theme. The printed value has to be re-read: resolving it once on mount left
  // every hex a lie the moment you switched theme or mode — the surface whose
  // entire job is telling you what a token IS.
  const { colorTheme } = useColorTheme();
  const { resolvedTheme } = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const next: Record<string, string> = {};
    for (const name of ALL_TOKENS) next[name] = style.getPropertyValue(`--${name}`).trim();
    setValues(next);
  }, [colorTheme, resolvedTheme]);

  return (
    <div className="space-y-6 p-4">
      {GROUPS.map((group) => (
        <div key={group.label} className="space-y-2">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold">{group.label}</h3>
            {group.hint && <p className="text-xs text-muted-foreground">{group.hint}</p>}
          </div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {group.tokens.map((name) => (
              <Swatch key={name} name={name} value={values[name] ?? ''} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
