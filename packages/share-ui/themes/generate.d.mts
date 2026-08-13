/** Hand-written declarations for generate.mjs. */
import type { ThemeModeSeed } from './seeds.mjs';

export const ROLE_HUES: Record<string, number>;
export function resolveSeed(mode: ThemeModeSeed): Record<string, string>;
export function generateMode(
  modeSeed: ThemeModeSeed,
  opts: { mode: 'light' | 'dark' },
): Record<string, string>;
export function generateCss(): string;
export function generateRegistry(): string;
