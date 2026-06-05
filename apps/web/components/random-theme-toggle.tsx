'use client';

import * as React from 'react';
import { Dices, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useColorTheme } from '@/components/color-theme-provider';
import { RANDOM_THEME_INTERVALS } from '@/lib/themes';
import { cn } from '@/lib/utils';

const OFF = 'off';

/**
 * A fun sibling to the light/dark toggle: a dice button that opens a menu to
 * pick how often the color theme reshuffles to a random one — Off, or a cadence
 * (hourly … weekly) — plus a one-off "Surprise me". The choice is remembered;
 * turning it Off leaves the current (last random) theme in place. The cadence
 * timer lives in ColorThemeProvider.
 */
export function RandomThemeToggle() {
  const { randomTheme, setRandomTheme, intervalMs, setIntervalMs, shuffleNow } =
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
  );
}
