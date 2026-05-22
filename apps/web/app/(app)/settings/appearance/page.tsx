'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Check, Moon, Sun, Monitor, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useColorTheme } from '@/components/color-theme-provider';
import { COLOR_THEMES } from '@/lib/themes';
import { SetPageTitle } from '@/components/layout/page-title';
import { PreviewTabs } from '@/components/theme-preview/preview-tabs';

const MODES: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

function Controls() {
  const { theme, setTheme } = useTheme();
  const { colorTheme, setColorTheme } = useColorTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Mode
        </h2>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => {
            const Icon = m.icon;
            const active = mounted && theme === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setTheme(m.id)}
                aria-pressed={active}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border p-2.5 text-xs transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-primary bg-accent/50 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {m.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Color theme
        </h2>
        <div className="space-y-1.5">
          {COLOR_THEMES.map((t) => {
            const active = colorTheme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setColorTheme(t.id)}
                aria-pressed={active}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-lg border p-2 text-left text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-accent/40',
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex shrink-0">
                    {t.swatches.map((c, i) => (
                      <span
                        key={i}
                        className="-ml-1 size-4 rounded-full border border-border/50 first:ml-0"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </span>
                  <span className="truncate font-medium text-foreground">{t.label}</span>
                </span>
                {active && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default function AppearancePage() {
  return (
    <div>
      <SetPageTitle title="Appearance" />
      <div className="flex flex-col gap-6 px-6 py-6 lg:flex-row">
        <aside className="scrollbar-thin shrink-0 lg:sticky lg:top-0 lg:max-h-[calc(100vh-4rem)] lg:w-1/5 lg:min-w-[220px] lg:self-start lg:overflow-y-auto lg:pr-1">
          <Controls />
        </aside>
        <div className="min-w-0 flex-1">
          <PreviewTabs />
        </div>
      </div>
    </div>
  );
}
