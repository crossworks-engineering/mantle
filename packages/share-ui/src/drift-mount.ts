import type { DriftOptions } from './drift/options';
import { driftOptionsFromSpec, type DriftSpec } from './drift/spec';
import { readDriftThemeTokens } from './drift/theme';

/**
 * The one way a plain-script page puts a saved Drift spec onto a canvas: the
 * /s reader and app frames (share-page.js). The owner app's React shell
 * (DriftThemeBackdrop in the client) drives the same engine from the same
 * `@mantle/share-ui/drift` modules, so a spec looks the same everywhere.
 *
 *  - The engine is imported dynamically HERE, so the share-page bundle stays
 *    small and the WebGL code is a lazy chunk fetched only on brains that
 *    saved a background.
 *  - Colours are read off the live document per paint (shaders take
 *    literals, not `var()`); an unresolvable theme mounts NOTHING rather
 *    than a wrong guess, and the themed surface underneath is the fallback.
 *  - `prefers-reduced-motion` renders one still frame (the engine's
 *    `respectReducedMotion`, on by default); the wash still paints.
 *  - A mode or theme change is `repaint`: new colours as uniform writes on
 *    the same context, never a teardown.
 *
 * TIMING is the caller's job: mount and repaint only after the document's
 * theme class has settled (in practice, from a requestAnimationFrame
 * callback), or the tokens read belong to the OUTGOING theme. So is
 * CANCELLATION: mount resolves after an await, so a caller that has moved on
 * must destroy the returned handle instead of keeping it.
 */

export type DriftMountHandle = {
  /** Re-read the theme tokens and repaint in `mode`. */
  repaint: (mode: 'light' | 'dark') => void;
  destroy: () => void;
};

/**
 * Build the background onto `canvas`. Resolves to a handle, or null when
 * nothing mounted (unresolvable theme, no WebGL); null is the designed
 * fallback, never an error.
 */
export async function mountDrift(
  canvas: HTMLCanvasElement,
  spec: DriftSpec,
  mode: 'light' | 'dark',
  overrides: Partial<DriftOptions> = {},
): Promise<DriftMountHandle | null> {
  const { createDrift } = await import('./drift/engine');
  const tokens = readDriftThemeTokens();
  if (!tokens) return null;
  let engine: ReturnType<typeof createDrift>;
  try {
    engine = createDrift(canvas, { ...driftOptionsFromSpec(spec, tokens, mode), ...overrides });
  } catch {
    return null;
  }
  if (!engine) return null;
  const handle = engine;
  return {
    repaint(next) {
      const fresh = readDriftThemeTokens();
      if (fresh) handle.update({ ...driftOptionsFromSpec(spec, fresh, next), ...overrides });
    },
    destroy: () => handle.destroy(),
  };
}
