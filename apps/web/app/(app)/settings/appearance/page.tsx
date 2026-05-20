'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Check, Moon, Sun, Monitor, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useColorTheme } from '@/components/color-theme-provider';
import { COLOR_THEMES } from '@/lib/themes';

const MODES: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

export default function AppearancePage() {
  const { theme, setTheme } = useTheme();
  const { colorTheme, setColorTheme } = useColorTheme();
  const [mounted, setMounted] = useState(false);

  // next-themes resolves only on the client; gate to avoid a mismatch.
  useEffect(() => setMounted(true), []);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Appearance</h1>
        <p className="text-sm text-muted-foreground">
          Choose how Mantle looks. Mode controls light/dark; the color theme sets the palette.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Mode</h2>
        <div className="grid grid-cols-3 gap-3">
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
                  'flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-primary bg-accent/50 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
              >
                <Icon className="size-5" aria-hidden />
                {m.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Color theme</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {COLOR_THEMES.map((t) => {
            const active = colorTheme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setColorTheme(t.id)}
                aria-pressed={active}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-accent/40',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="flex">
                    {t.swatches.map((c, i) => (
                      <span
                        key={i}
                        className="size-4 rounded-full border border-border/50 -ml-1 first:ml-0"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </span>
                  <span className="font-medium text-foreground">{t.label}</span>
                </span>
                {active && <Check className="size-4 text-primary" aria-hidden />}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          More themes coming soon — generate them at tweakcn.com and drop them in.
        </p>
      </section>
    </div>
  );
}
