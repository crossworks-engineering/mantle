'use client';

import { useEffect, useState } from 'react';

/** Token groups rendered as swatches. Values read live from CSS vars,
 *  so they reflect the active color theme + light/dark mode. */
const GROUPS: Array<{ label: string; tokens: Array<[string, string]> }> = [
  {
    label: 'Base',
    tokens: [
      ['background', 'foreground'],
      ['card', 'card-foreground'],
      ['popover', 'popover-foreground'],
      ['muted', 'muted-foreground'],
    ].flatMap(([bg, fg]) => [
      [bg, `var(--${bg})`],
      [fg, `var(--${fg})`],
    ]) as Array<[string, string]>,
  },
  {
    label: 'Accents',
    tokens: [
      ['primary', 'var(--primary)'],
      ['primary-foreground', 'var(--primary-foreground)'],
      ['secondary', 'var(--secondary)'],
      ['secondary-foreground', 'var(--secondary-foreground)'],
      ['accent', 'var(--accent)'],
      ['accent-foreground', 'var(--accent-foreground)'],
      ['destructive', 'var(--destructive)'],
      ['destructive-foreground', 'var(--destructive-foreground)'],
    ],
  },
  {
    label: 'Borders & rings',
    tokens: [
      ['border', 'var(--border)'],
      ['input', 'var(--input)'],
      ['ring', 'var(--ring)'],
    ],
  },
  {
    label: 'Charts',
    tokens: [
      ['chart-1', 'var(--chart-1)'],
      ['chart-2', 'var(--chart-2)'],
      ['chart-3', 'var(--chart-3)'],
      ['chart-4', 'var(--chart-4)'],
      ['chart-5', 'var(--chart-5)'],
    ],
  },
  {
    label: 'Sidebar',
    tokens: [
      ['sidebar', 'var(--sidebar)'],
      ['sidebar-foreground', 'var(--sidebar-foreground)'],
      ['sidebar-primary', 'var(--sidebar-primary)'],
      ['sidebar-accent', 'var(--sidebar-accent)'],
      ['sidebar-border', 'var(--sidebar-border)'],
    ],
  },
];

function Swatch({ name, value }: { name: string; value: string }) {
  const [resolved, setResolved] = useState('');
  useEffect(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
    setResolved(v);
  }, [name]);
  return (
    <div className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-muted/60">
      <div className="size-12 shrink-0 rounded-md border" style={{ backgroundColor: value }} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium leading-tight">{name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{resolved || value}</p>
      </div>
    </div>
  );
}

export function ColorPalette() {
  return (
    <div className="space-y-6 p-4">
      {GROUPS.map((group) => (
        <div key={group.label} className="space-y-2">
          <h3 className="text-sm font-semibold">{group.label}</h3>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {group.tokens.map(([name, value]) => (
              <Swatch key={name} name={name} value={value} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
