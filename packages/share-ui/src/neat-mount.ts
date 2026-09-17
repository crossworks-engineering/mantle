import {
  neatConfigFromSpec,
  type NeatBackgroundSpec,
  type NeatThemeTokens,
} from './neat-background';

/**
 * The one true way to put a Neat spec onto a canvas — shared by every
 * renderer (the /s reader's vanilla runtime here in mantle; jackdaw's React
 * NeatBackdrop wraps it too), so the hard-won WebGL specifics live exactly
 * once:
 *
 *  - `@firecms/neat` is dynamically imported HERE, so every consumer's
 *    bundler splits the ~80KB WebGL chunk out and only fetches it on
 *    surfaces that actually paint a gradient.
 *  - Colours are read off the live document per call — shaders take
 *    literals, not `var()` — and an unresolvable theme mounts NOTHING
 *    rather than a wrong guess; the themed surface underneath is the
 *    designed fallback.
 *  - Neat's `seed` is NOT a randomness seed: it is the animation clock's
 *    starting value (u_time, fp32 on the GPU). A raw 32-bit seed exceeds
 *    fp32 precision and collapses the shader's small offsets into ONE FLAT
 *    COLOUR. It is modded into the library's own clock range here; the full
 *    seed still drives the parameter PRNG.
 *  - `prefers-reduced-motion` freezes the animation (speed 0); the wash
 *    still paints.
 *
 * TIMING is the caller's job: mount only after the document's theme
 * class/attributes have settled (in practice, from a requestAnimationFrame
 * callback), or the tokens read here belong to the OUTGOING theme. So is
 * CANCELLATION: this resolves after an await, so a caller that has moved on
 * must destroy the returned handle instead of keeping it.
 */

export type NeatMountHandle = { destroy: () => void };

/** The four tokens the shader derives every colour from, resolved to literal
 *  values off the live document. Null when the theme is unresolvable (a test
 *  DOM, a broken stylesheet) — paint nothing rather than a wrong guess. */
export function readNeatThemeTokens(): NeatThemeTokens | null {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string) => cs.getPropertyValue(name).trim();
  const tokens = {
    background: read('--background'),
    primary: read('--primary'),
    accent: read('--accent'),
    secondary: read('--secondary'),
  };
  return tokens.background && tokens.primary ? tokens : null;
}

/**
 * Build the gradient onto `canvas`. Resolves to a handle to destroy, or null
 * when nothing mounted (unresolvable theme, WebGL unavailable) — null is the
 * designed fallback, never an error.
 */
export async function mountNeat(
  canvas: HTMLCanvasElement,
  spec: NeatBackgroundSpec,
  mode: 'light' | 'dark',
  opts: { resolution?: number; licenseKey?: string } = {},
): Promise<NeatMountHandle | null> {
  const { NeatGradient } = await import('@firecms/neat');
  const tokens = readNeatThemeTokens();
  if (!tokens) return null;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const config = neatConfigFromSpec(spec, tokens, mode);
  try {
    return new NeatGradient({
      ...config,
      ref: canvas,
      seed: spec.seed % 3600,
      resolution: opts.resolution ?? 1,
      speed: reduced ? 0 : config.speed,
      ...(opts.licenseKey ? { licenseKey: opts.licenseKey } : {}),
    });
  } catch {
    // WebGL unavailable (headless browser, exhausted contexts).
    return null;
  }
}
