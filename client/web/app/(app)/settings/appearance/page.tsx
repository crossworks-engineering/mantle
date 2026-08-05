'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { Check, Moon, Search, Sun, Monitor, type LucideIcon } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { useColorTheme } from '@mantle/web-ui/color-theme-provider';
import { COLOR_THEMES, type ThemeSwatches } from '@mantle/web-ui/lib/themes';
import { Input } from '@mantle/web-ui/ui/input';
import { RadioGroup, RadioGroupCard } from '@mantle/web-ui/ui/radio-group';
import { SetPageTitle } from '@/components/layout/page-title';
import { PreviewTabs } from '@/components/theme-preview/preview-tabs';

const MODES: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

/** Fold a label or id to letters+digits so "cleanslate", "Clean Slate" and
 *  "clean-slate" are all the same needle. */
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The [primary, accent, background] dots. Both modes are in the DOM and the
 *  `dark:` variant picks one, so the strip is right on the server, right
 *  before hydration, and right in system mode — no resolvedTheme round-trip
 *  that would flash the wrong palette. */
function Swatches({ swatches }: { swatches: { light: ThemeSwatches; dark: ThemeSwatches } }) {
  const dots = (triple: ThemeSwatches) =>
    triple.map((c, i) => (
      <span
        key={i}
        className="-ml-1 size-4 rounded-full border border-border/50 first:ml-0"
        style={{ backgroundColor: c }}
      />
    ));
  return (
    <span className="flex shrink-0" aria-hidden>
      <span className="flex dark:hidden">{dots(swatches.light)}</span>
      <span className="hidden dark:flex">{dots(swatches.dark)}</span>
    </span>
  );
}

function Controls() {
  const { theme, setTheme } = useTheme();
  const { colorTheme, setColorTheme } = useColorTheme();
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  // Once the visitor drives the list themselves, stop moving it under them.
  const touched = useRef(false);

  const needle = fold(query);
  const matches = useMemo(
    () =>
      needle
        ? COLOR_THEMES.filter((t) => fold(t.label).includes(needle) || t.id.includes(needle))
        : COLOR_THEMES,
    [needle],
  );

  // ~40 themes do not fit the column: bring the active one into view instead of
  // leaving the visitor to scroll for the row that is already theirs. Runs on
  // the id settling too (the provider reads it off <html> after mount), which
  // is why it keys on colorTheme rather than mounting once.
  useEffect(() => {
    const el = activeRef.current;
    const box = listRef.current;
    if (touched.current || !el || !box) return;
    const scroller = box.closest<HTMLElement>('[data-theme-scroller]');
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
    const item = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (item.top >= view.top && item.bottom <= view.bottom) return;
    scroller.scrollTop += item.top - view.top - (view.height - item.height) / 2;
  }, [colorTheme]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2
          id="mode-heading"
          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Mode
        </h2>
        <RadioGroup
          value={theme ?? ''}
          onValueChange={setTheme}
          aria-labelledby="mode-heading"
          className="grid-cols-3 gap-2"
        >
          {MODES.map((m) => {
            const Icon = m.icon;
            return (
              <RadioGroupCard
                key={m.id}
                value={m.id}
                className={cn(
                  'flex flex-col items-center gap-1.5 border-border p-2.5 text-xs text-muted-foreground',
                  'hover:bg-accent/40 hover:text-foreground',
                  'data-[state=checked]:border-primary data-[state=checked]:bg-accent/50 data-[state=checked]:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {m.label}
              </RadioGroupCard>
            );
          })}
        </RadioGroup>
      </section>

      {/* Brand identity (logo + wordmark/peer-name fonts) lives in the LOGO
          tab of the preview strip, not here — the sidebar is mode + theme. */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2
            id="color-theme-heading"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Color theme
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {needle ? `${matches.length} of ${COLOR_THEMES.length}` : COLOR_THEMES.length}
          </span>
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => {
              touched.current = true;
              setQuery(e.target.value);
            }}
            placeholder="Filter themes"
            aria-label="Filter themes"
            className="h-8 rounded-lg pl-8 pr-2"
          />
        </div>

        {matches.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted-foreground">
            No theme matches &ldquo;{query.trim()}&rdquo;.
          </p>
        ) : (
          <RadioGroup
            ref={listRef}
            value={colorTheme}
            onValueChange={(id) => {
              touched.current = true;
              setColorTheme(id);
            }}
            aria-labelledby="color-theme-heading"
            className="gap-1.5"
          >
            {matches.map((t) => {
              const active = colorTheme === t.id;
              return (
                <RadioGroupCard
                  key={t.id}
                  ref={active ? activeRef : undefined}
                  value={t.id}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 border-border p-2 text-sm',
                    'hover:bg-accent/40',
                    'data-[state=checked]:border-primary data-[state=checked]:ring-1 data-[state=checked]:ring-primary',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Swatches swatches={t.swatches} />
                    <span className="truncate font-medium text-foreground">{t.label}</span>
                  </span>
                  {active && <Check className="size-4 shrink-0 text-primary-ink" aria-hidden />}
                </RadioGroupCard>
              );
            })}
          </RadioGroup>
        )}
      </section>
    </div>
  );
}

export default function AppearancePage() {
  return (
    <div>
      <SetPageTitle title="Appearance" />
      <div className="flex flex-col gap-6 px-6 py-6 lg:flex-row">
        <aside
          data-theme-scroller
          className="scrollbar-thin shrink-0 lg:sticky lg:top-0 lg:max-h-[calc(100vh-4rem)] lg:w-1/5 lg:min-w-[220px] lg:self-start lg:overflow-y-auto lg:pr-1"
        >
          <Controls />
        </aside>
        <div className="min-w-0 flex-1">
          <PreviewTabs />
        </div>
      </div>
    </div>
  );
}
