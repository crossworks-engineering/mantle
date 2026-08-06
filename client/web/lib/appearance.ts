// Server-module only (fetches with process.env; imported by the root layout,
// a Server Component). Do not import from client components.
import type { BrainAppearance } from '@mantle/web-ui/appearance';

/**
 * Server-side loader for the brain's system-wide appearance (colour theme,
 * display fonts, avatar style), fetched from the server tier's public GET /api/appearance.
 * The root layout awaits this and renders the values straight into the
 * `<html>` tag — the ONLY delivery path; there are no before-paint scripts and
 * no localStorage cache (see @mantle/web-ui/appearance).
 *
 * In-process cache: this sits on the critical path of every SSR. Successes
 * cache 30s so an admin's change shows up promptly; failures cache 5s
 * (keeping any last-known-good value) so an unreachable server tier costs ONE
 * 2s timeout per window, not a 2s render stall on every request. A page must
 * never fail to render over branding — every failure path returns a value.
 */
const TTL_OK_MS = 30_000;
const TTL_FAIL_MS = 5_000;
let cached: { at: number; ok: boolean; value: BrainAppearance | null } | null = null;

export async function loadBrainAppearance(): Promise<BrainAppearance | null> {
  const origin = (process.env.MANTLE_SERVER_ORIGIN ?? '').replace(/\/+$/, '');
  if (!origin) return null; // unset (build, misconfig) — render the defaults
  const now = Date.now();
  if (cached && now - cached.at < (cached.ok ? TTL_OK_MS : TTL_FAIL_MS)) return cached.value;
  try {
    const res = await fetch(`${origin}/api/appearance`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      cached = { at: now, ok: false, value: cached?.value ?? null };
      return cached.value;
    }
    const value = (await res.json()) as BrainAppearance;
    cached = { at: now, ok: true, value };
    return value;
  } catch {
    cached = { at: now, ok: false, value: cached?.value ?? null };
    return cached.value;
  }
}
