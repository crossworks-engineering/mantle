'use client';

import * as React from 'react';
import { Sparkles } from 'lucide-react';
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@mantle/web-ui/ui/dropdown-menu';
import { useColorTheme } from '@mantle/web-ui/color-theme-provider';
import { RANDOM_THEME_INTERVALS } from '@mantle/web-ui/lib/themes';

const OFF = 'off';

/**
 * How often the colour theme reshuffles to a random one — Off, or a cadence
 * (hourly … weekly) — plus a one-off "Surprise me". The choice is remembered;
 * turning it Off leaves the current (last random) theme in place. The cadence
 * timer lives in ColorThemeProvider.
 *
 * BARE menu items, with no menu or trigger of their own, because the only host
 * is the rail's profile menu and a DropdownMenu nested inside a menu ITEM opens
 * a second popup that the parent's dismiss logic then fights. The host supplies
 * the submenu; this supplies the choices.
 *
 * There was a standalone dice button around these items until appearance moved
 * into the profile menu. Nothing rendered it afterwards, so it is gone rather
 * than left to rot — `git log` has it if the shape is ever wanted again.
 */
export function RandomThemeItems() {
  const { randomTheme, setRandomTheme, intervalMs, setIntervalMs, shuffleNow } = useColorTheme();
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
    </>
  );
}
