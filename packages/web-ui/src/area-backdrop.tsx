'use client';

import * as React from 'react';
import { GeneratedBackdrop } from './generated-backdrop';
import { useAreaBackground } from './background-provider';
import { BACKGROUND_OFF, type BackgroundAreaId } from './backgrounds';

/**
 * The generated background for ONE area of the shell, or nothing when that area
 * is off.
 *
 * The single place every decorated surface goes through, so "how a background
 * behaves in the menu" is defined once rather than re-tuned at four call sites.
 *
 * WHY THE PRESETS DIFFER PER AREA. The areas are not the same shape and do not
 * hold the same amount of text, so one setting cannot serve all four:
 *
 * - `menu` and `activity` are tall, narrow, and text-dense at the TOP. The crop
 *   anchors to the bottom (where wave crests sit) and the artwork is masked
 *   away upward, so the labels sit on clean surface.
 * - `header` is the brand: the logo-and-peer-name block at the head of the rail,
 *   plus the slim mobile bar that shows the same thing below `md`. Both are
 *   short strips, and a gradient mask across ~48px reads as a smudge rather
 *   than a fade, so it gets none and a lower opacity instead. The id predates
 *   the removal of the fixed header; the setting kept its meaning when the
 *   wordmark moved into the rail, so the stored value did not have to migrate.
 * - `chat` is the largest surface and the one people READ. It gets the lowest
 *   opacity of the four: at panel size a chart colour behind body text is the
 *   easiest way to fail contrast in the whole app.
 */
type Preset = {
  position: string;
  fade: 'to-top' | 'to-bottom' | 'none';
  opacity: number;
};

const PRESETS: Record<BackgroundAreaId, Preset> = {
  menu: { position: 'xMidYMax', fade: 'to-top', opacity: 0.2 },
  activity: { position: 'xMidYMax', fade: 'to-top', opacity: 0.2 },
  header: { position: 'xMidYMid', fade: 'none', opacity: 0.14 },
  chat: { position: 'xMidYMax', fade: 'to-top', opacity: 0.1 },
};

/**
 * The seed is the AREA ID, not the brain's name.
 *
 * It has to be one value that every call site agrees on, or the four areas draw
 * from different points in the ramp and the shell looks accidentally
 * mismatched, which is exactly what happened when two call sites passed the
 * site name and two did not. Keying on the area is stable, needs no data
 * fetch, gives each area its own character, and lets the picker preview the
 * EXACT artwork the area will get rather than an approximation of it.
 */
export function areaSeed(area: BackgroundAreaId): string {
  return area;
}

export function AreaBackdrop({ area, className }: { area: BackgroundAreaId; className?: string }) {
  const choice = useAreaBackground(area);
  if (choice === BACKGROUND_OFF) return null;
  const preset = PRESETS[area];
  return (
    <GeneratedBackdrop
      style={choice}
      seed={areaSeed(area)}
      position={preset.position}
      fade={preset.fade}
      opacity={preset.opacity}
      className={className}
    />
  );
}

/** The preset an area draws with, so a preview can match it exactly. */
export function areaPreset(area: BackgroundAreaId): Preset {
  return PRESETS[area];
}
