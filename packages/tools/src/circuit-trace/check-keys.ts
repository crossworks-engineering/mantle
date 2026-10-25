/**
 * The image check's keys: what a stored check (the Checks tab of a DWG's
 * table) is filed under, so a later trace finds it again. Built from DWG
 * handles and drawing coordinates, never from the trace's node numbers or
 * pixels: handles and coordinates survive a re-index of the same drawing
 * (dwg-reindex), node numbers need not.
 */
import { createHash } from 'node:crypto';

/** Longest key kept as text; past it the handle list is hashed. */
const KEY_MAX = 200;

/** A join through another layer: the handles of its path, sorted. */
export function joinKey(handles: readonly string[]): string {
  const list = [...new Set(handles)].sort().join(',');
  const key = `join:${list}`;
  return key.length <= KEY_MAX
    ? key
    : `join:#${createHash('sha1').update(list).digest('hex').slice(0, 20)}`;
}

/** A coordinate as the bones tabs round it (one decimal). */
const at = (v: number) => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : '?');

/** A run's end: the handle of the segment it is the end of, and where. */
export function endKey(handle: string, x: number, y: number): string {
  return `end:${handle || '?'}@${at(x)},${at(y)}`;
}

/** A guessed sheet link, keyed by the end it leaves from. */
export function linkKey(handle: string, x: number, y: number): string {
  return `link:${handle || '?'}@${at(x)},${at(y)}`;
}

/** A valve whose type was read from its block name. */
export function valveKey(handle: string): string {
  return `valve:${handle}`;
}
