/**
 * What a client says about an area screenshot (POST /api/screenshots, the
 * `meta` form field, a JSON string): an allowlist, every string capped,
 * unknown keys stripped. Stored as it is in the file's `data.screenshot`,
 * so nothing outside this list ever reaches the node.
 */
import { z } from 'zod';
import { firstIssue } from './zod-issue';

/** The most the `meta` field holds before it is parsed. */
export const SCREENSHOT_META_MAX_CHARS = 16 * 1024;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** The allowlist: every key optional, each checked when present. */
export const ScreenshotMeta = z.object({
  route: z.string().max(500).optional(),
  screen: z.string().max(200).optional(),
  itemId: z.string().uuid().nullable().optional(),
  itemTitle: z.string().max(300).optional(),
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
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'meta is not valid JSON' };
    }
  }
  const parsed = ScreenshotMeta.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: `invalid meta: ${firstIssue(parsed.error)}` };
  }
  return {
    ok: true,
    meta: { ...parsed.data, capturedAt: parsed.data.capturedAt ?? now.toISOString() },
  };
}
