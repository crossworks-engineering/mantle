'use client';

import * as React from 'react';
import { Dices, Sparkles } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@mantle/web-ui/ui/dropdown-menu';
import { useColorTheme } from '@mantle/web-ui/color-theme-provider';
import { RANDOM_THEME_INTERVALS, themeLabel } from '@mantle/web-ui/lib/themes';
import { cn } from '@mantle/web-ui/lib/utils';

const OFF = 'off';

/**
 * A fun sibling to the light/dark toggle: a dice button that opens a menu to
 * pick how often the color theme reshuffles to a random one — Off, or a cadence
 * (hourly … weekly) — plus a one-off "Surprise me". The choice is remembered;
 * turning it Off leaves the current (last random) theme in place. The cadence
 * timer lives in ColorThemeProvider.
 */
export function RandomThemeToggle() {
  const { colorTheme, randomTheme, setRandomTheme, intervalMs, setIntervalMs, shuffleNow } =
    useColorTheme();

  const value = randomTheme ? String(intervalMs) : OFF;

  const onValueChange = (next: string) => {
    if (next === OFF) {
      setRandomTheme(false);
      return;
    }
    const ms = Number(next);
    setIntervalMs(ms);
    if (!randomTheme) setRandomTheme(true); // enabling shuffles immediately
  };

  return (
    <>
      {/* One spelling of a theme's name everywhere: the picker says "Amethyst
          Haze", so a shuffle landing on it must not report "amethyst-haze".
          Sized to flex inside the rail's theme row and truncate rather than
          push the two round buttons out of the column; gone entirely at
          icon-rail width, where the buttons stack instead. */}
      <span
        className="min-w-0 flex-1 select-none truncate pr-1 text-xs text-muted-foreground group-data-[nav-collapsed=true]/shell:hidden"
        title="Current theme"
      >
        {themeLabel(colorTheme)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Random theme"
            aria-pressed={randomTheme}
            title={randomTheme ? 'Random theme: on' : 'Random theme: off'}
            className={cn(
              'size-8 rounded-full transition-colors',
              randomTheme
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-foreground/10 hover:bg-foreground/15',
            )}
          >
            <Dices className={cn('transition-transform', randomTheme && 'rotate-12')} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Random theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
            <DropdownMenuRadioItem value={OFF}>Off</DropdownMenuRadioItem>
            {RANDOM_THEME_INTERVALS.map((opt) => (
              <DropdownMenuRadioItem key={opt.ms} value={String(opt.ms)}>
                {opt.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={shuffleNow}>
            <Sparkles className="size-4" /> Surprise me
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
