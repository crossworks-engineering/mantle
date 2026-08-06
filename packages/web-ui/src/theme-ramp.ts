'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { useColorTheme } from './color-theme-provider';

/**
 * The active theme's `--chart-1..5`, resolved to hex.
 *
 * Extracted from generated-avatar so the avatar and the backdrop read the ramp
 * the same way — they must agree, or a themed backdrop and the avatars sitting
 * on it drift onto two different palettes.
 *
 * Read off the document rather than imported: these tokens change with BOTH the
 * colour theme and light/dark mode, and SVG fill attributes cannot resolve
 * `var()`, so the resolved values have to be passed into DiceBear as literals.
 * themes.css emits every token as hex, which is exactly what DiceBear accepts.
 */

/** Clean Slate (the default theme) `--chart-1..5`, light mode — used for the
 *  first paint before the live tokens can be read, so the default theme never
 *  flashes. Values are GENERATED (themes/seeds.mjs → `pnpm themes:build`); if
 *  the ramp recipe changes, refresh them from `:root` in themes.css. */
export const FALLBACK_RAMP = ['#666ed1', '#ae467f', '#ad5700', '#4b830f', '#00889b'];

// A list of 40 agents would otherwise run 40 identical getComputedStyle reads on
// mount. The ramp only depends on (colour theme, mode), so cache on that.
const rampCache = new Map<string, string[]>();

export function readChartRamp(key: string): string[] {
  const hit = rampCache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return FALLBACK_RAMP;
  const cs = getComputedStyle(document.documentElement);
  const vals = [1, 2, 3, 4, 5]
    .map((i) => cs.getPropertyValue(`--chart-${i}`).trim())
    .filter((v) => v.length > 0);
  const ramp = vals.length >= 2 ? vals : FALLBACK_RAMP;
  rampCache.set(key, ramp);
  return ramp;
}

/**
 * The live chart ramp, re-read whenever the colour theme or mode changes.
 *
 * Server render and first paint get FALLBACK_RAMP; the effect swaps in the real
 * values once the document is readable. Both inputs land on `<html>` as a class
 * or attribute, which is why the effect keys on them rather than polling.
 */
export function useChartRamp(): string[] {
  const { resolvedTheme } = useTheme();
  const { colorTheme } = useColorTheme();
  const [ramp, setRamp] = React.useState<string[]>(FALLBACK_RAMP);
  React.useEffect(() => {
    setRamp(readChartRamp(`${colorTheme}:${resolvedTheme}`));
  }, [colorTheme, resolvedTheme]);
  return ramp;
}
