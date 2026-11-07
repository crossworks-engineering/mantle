/**
 * What a client says about an area screenshot (POST /api/screenshots, the
 * `meta` form field, a JSON string): an allowlist, every string capped,
 * unknown keys stripped. Stored as it is in the file's `data.screenshot`,
 * so nothing outside this list ever reaches the node. A lone UTF-16
 * surrogate in any string (half an emoji, a title cut by code unit) is
 * replaced by U+FFFD, and a NUL (\u0000) removed, before the check:
 * Postgres refuses both in jsonb, and the save would answer 500.
 */
import { z } from 'zod';
import { firstIssue } from './zod-issue';

/** The most the `meta` field holds before it is parsed. */
export const SCREENSHOT_META_MAX_CHARS = 16 * 1024;

/** The deepest the `meta` JSON nests (objects and arrays). The allowlist
 *  needs 2; the cap keeps the parse and the string walk below off the
 *  stack, the same on Node (a RangeError, a 500) and Bun. */
export const SCREENSHOT_META_MAX_DEPTH = 32;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** The allowlist: every key optional, each checked when present. */
export const ScreenshotMeta = z.object({
  route: z.string().max(500).optional(),
  screen: z.string().max(200).optional(),
  itemId: z.string().uuid().nullable().optional(),
  itemTitle: z.string().max(300).nullable().optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(),
  viewport: z.object({ w: int(1, 20000), h: int(1, 20000) }).optional(),
  dpr: z.number().min(0.5).max(8).optional(),
  rect: z
    .object({
      x: int(0, Number.MAX_SAFE_INTEGER),
      y: int(0, Number.MAX_SAFE_INTEGER),
      w: int(0, Number.MAX_SAFE_INTEGER),
      h: int(0, Number.MAX_SAFE_INTEGER),
    })
    .optional(),
  appVersion: z.string().max(40).optional(),
  shell: z.enum(['web', 'desktop', 'tauri']).optional(),
  note: z.string().max(2000).optional(),
});

export type ScreenshotMeta = z.output<typeof ScreenshotMeta>;

/** A high surrogate with no low after it, or a low with no high before. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The NUL character, which jsonb refuses in a string too. */
const NUL = '\u0000';

/**
 * How deep the JSON text `raw` nests, read from its brackets outside its
 * strings: no parse, no recursion, so the same answer on every runtime
 * before either is asked to parse it. Stops counting once over `max`.
 */
export function jsonNestsDeeperThan(raw: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (inString) {
      if (c === 0x5c)
        i++; // a backslash: the next char is escaped
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) return true;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return false;
}

/** `value` with every lone surrogate in every string (keys too, at any
 *  depth to SCREENSHOT_META_MAX_DEPTH) replaced by U+FFFD (the same length,
 *  so the caps read as sent) and every NUL removed. Below that depth a value
 *  is dropped (undefined): never a walk off the stack. */
export function wellFormedStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(LONE_SURROGATE, '\uFFFD').replaceAll(NUL, '');
  if (depth >= SCREENSHOT_META_MAX_DEPTH && value && typeof value === 'object') return undefined;
  if (Array.isArray(value)) return value.map((v) => wellFormedStrings(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        wellFormedStrings(k) as string,
        wellFormedStrings(v, depth + 1),
      ]),
    );
  }
  return value;
}

/**
 * The `meta` field read: the checked metadata, `capturedAt` the server's
 * time (`now`) when the client sent none; or a plain message for a 400.
 * No field at all is an empty one.
 */
export function parseScreenshotMeta(
  raw: string | null | undefined,
  now: Date = new Date(),
): { ok: true; meta: ScreenshotMeta } | { ok: false; error: string } {
  let value: unknown = {};
  if (raw != null && raw.trim() !== '') {
    if (raw.length > SCREENSHOT_META_MAX_CHARS) {
      return { ok: false, error: 'meta is too long' };
    }
    // Before the parse: a deep nest is refused the same way on every
    // runtime, never a stack overflow (a 500) on one and a parse error on
    // another.
    if (jsonNestsDeeperThan(raw, SCREENSHOT_META_MAX_DEPTH)) {
      return { ok: false, error: 'meta is nested too deeply' };
    }
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'meta is not valid JSON' };
    }
  }
  const parsed = ScreenshotMeta.safeParse(wellFormedStrings(value));
  if (!parsed.success) {
    return { ok: false, error: `invalid meta: ${firstIssue(parsed.error)}` };
  }
  return {
    ok: true,
    meta: { ...parsed.data, capturedAt: parsed.data.capturedAt ?? now.toISOString() },
  };
}
