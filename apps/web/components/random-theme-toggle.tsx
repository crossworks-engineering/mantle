'use client';

import * as React from 'react';
import { Dices } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useColorTheme } from '@/components/color-theme-provider';
import { cn } from '@/lib/utils';

/**
 * A fun sibling to the light/dark toggle: when on, the color theme reshuffles
 * to a random one on every navigation. The state is remembered; turning it off
 * leaves the current (last random) theme in place. See ColorThemeProvider.
 */
export function RandomThemeToggle() {
  const { randomTheme, setRandomTheme } = useColorTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Random theme"
      aria-pressed={randomTheme}
      title={
        randomTheme
          ? 'Random theme: on — shuffles on every page'
          : 'Random theme: off'
      }
      onClick={() => setRandomTheme(!randomTheme)}
      className={cn(
        'size-8 rounded-full transition-colors',
        randomTheme
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'bg-foreground/10 hover:bg-foreground/15',
      )}
    >
      <Dices className={cn('transition-transform', randomTheme && 'rotate-12')} />
    </Button>
  );
}
