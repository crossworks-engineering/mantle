/**
 * Pictures per caller: one at a time, and at most RENDERS_PER_WINDOW in
 * RENDER_WINDOW_MS, for every picture tool (present_render and the canvas
 * saves, diagram_render, app_render): one budget per caller for all of them.
 */
import type { ToolHandlerContext } from './types';

/** The renderer's slots are shared by every caller (and
 *  the render tools are reads a read-only key holds), so one caller must not
 *  hold them all. A caller is a login (its own MCP or a team surface), else
 *  the entry and the agent of the turn. */
const RENDERS_PER_WINDOW = 20;
const RENDER_WINDOW_MS = 5 * 60_000;
const renderCalls = new Map<string, { running: boolean; at: number[] }>();

export function renderCallerKey(ctx: ToolHandlerContext): string {
  const s = ctx.surface as { loginId?: string } | undefined;
  if (s?.loginId) return `login:${s.loginId}`;
  return `${ctx.caller?.entry ?? 'turn'}:${ctx.agent?.slug ?? '-'}:${ctx.ownerId}`;
}

/** Take a render turn for this caller, or the reason it must wait. Shared
 *  with app_render (app-render/tool.ts): one budget per caller for both. */
export function takeRenderTurn(
  key: string,
): { ok: true; done: () => void } | { ok: false; why: string } {
  const now = Date.now();
  const entry = renderCalls.get(key) ?? { running: false, at: [] };
  entry.at = entry.at.filter((t) => now - t < RENDER_WINDOW_MS);
  if (entry.running) {
    return {
      ok: false,
      why: 'Another picture of yours is still being drawn; look again when it is done.',
    };
  }
  if (entry.at.length >= RENDERS_PER_WINDOW) {
    return {
      ok: false,
      why: `That is ${RENDERS_PER_WINDOW} pictures in ${RENDER_WINDOW_MS / 60_000} minutes; look again in a few minutes.`,
    };
  }
  entry.running = true;
  entry.at.push(now);
  renderCalls.set(key, entry);
  if (renderCalls.size > 5000) {
    for (const [k, v] of renderCalls) {
      if (!v.running && v.at.every((t) => now - t >= RENDER_WINDOW_MS)) renderCalls.delete(k);
    }
  }
  return {
    ok: true,
    done: () => {
      entry.running = false;
    },
  };
}
