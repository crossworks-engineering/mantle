/**
 * The image check's keys: what a stored check (the Checks tab of a DWG's
 * table) is filed under, so a later trace finds it again. Built from DWG
 * handles and drawing coordinates, never from the trace's node numbers or
 * pixels: handles and coordinates survive a re-index of the same drawing
 * (dwg-reindex), node numbers need not.
 */
import { createHash } from 'node:crypto';
import type { CheckKind } from './check';

/** The words an image check's no may name for each kind, past the
 *  drawing's own names (check.ts asks with them, pid.ts draws them): here,
 *  away from the trace's modules, so both read one list. */
export const ALT_WORDS = {
  join: ['separate', 'crossing', 'gap', 'other'],
  end: ['break', 'continues', 'open', 'other'],
  link: ['none', 'other'],
  valve: ['instrument', 'not-a-valve', 'other'],
} as const satisfies Record<CheckKind, readonly string[]>;
/** An end word the drawing draws (every end word but "other"). */
export type EndWord = Exclude<(typeof ALT_WORDS.end)[number], 'other'>;

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

/** A guessed sheet link, keyed by the end it leaves from AND the sheet it
 *  was guessed to continue on: an answer about one target never applies
 *  after a later upload moves the guess to another sheet. */
export function linkKey(handle: string, x: number, y: number, target: string): string {
  const base = `link:${handle || '?'}@${at(x)},${at(y)}>`;
  const t = target.trim().toUpperCase();
  const key = base + t;
  return key.length <= KEY_MAX
    ? key
    : `${base}#${createHash('sha1').update(t).digest('hex').slice(0, 20)}`;
}

/** A valve whose type was read from its block name. */
export function valveKey(handle: string): string {
  return `valve:${handle}`;
}

/** A circuit's name as every match of it reads it: trimmed, lower case,
 *  runs of white space as one space. The trace finds a circuit's layers
 *  by it (walk.ts), and circuit_verify's guard compares claims and Checks
 *  rows by it and locks the circuit under it (verify.ts, checks-store.ts),
 *  so `ABC`, `abc` and ` Abc ` are one circuit everywhere. */
export function circuitKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
