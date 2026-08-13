'use client';

import * as React from 'react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

/**
 * The three mode choices as BARE menu items, so a host menu can nest them in a
 * submenu rather than opening a second popup beside its own. `ThemeToggle`
 * below is the standalone button that wraps these same items in its own menu —
 * one list of modes, two placements.
 */
export function ThemeModeItems() {
  const { setTheme } = useTheme();
  return (
    <>
      <DropdownMenuItem onClick={() => setTheme('light')}>
        <Sun className="size-4" /> Light
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => setTheme('dark')}>
        <Moon className="size-4" /> Dark
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => setTheme('system')}>
        <Monitor className="size-4" /> System
      </DropdownMenuItem>
    </>
  );
}

export function ThemeToggle() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          className="size-8 rounded-full bg-foreground/10 hover:bg-foreground/15"
        >
          <Sun className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <ThemeModeItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
