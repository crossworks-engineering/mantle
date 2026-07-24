/**
 * The chat composer look shared by the owner assistant and Team Chat — one
 * definition so "styled as one design" stays true instead of two copy-pasted
 * class strings drifting apart. Tokens only (recolors per theme).
 */

/** Brand-tinted gradient rising from the edge behind the composer. */
export const COMPOSER_BAND_GRADIENT =
  'bg-gradient-to-t from-primary/15 via-primary/5 to-background';

/** The input box itself: comfortably tall, thick-framed. Flanking buttons
 *  stretch to match (items-stretch / self-stretch on the row). */
export const COMPOSER_BOX = 'min-h-24 border-[3px]';
