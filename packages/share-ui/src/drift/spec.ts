import type { DriftOptions } from './options';
import type { DriftSpec } from '@mantle/content-core/drift-spec';
import { DRIFT_TEXT_FLOOR, driftPaletteFromTheme, type DriftThemeTokens } from './theme';

/**
 * The stored spec and its codec live in @mantle/content-core/drift-spec, the
 * one codec the brain validates with and every renderer decodes with. This
 * module adds the step only a renderer needs: spec + live tokens + mode, to
 * engine options.
 */
export {
  DRIFT_SPEC_DEFAULTS,
  DRIFT_SPEC_MAX,
  DRIFT_SPEED_MAX,
  decodeDriftSpec,
  encodeDriftSpec,
  randomDriftSpec,
  type DriftSpec,
} from '@mantle/content-core/drift-spec';

/**
 * Where a background paints, the one switch between its two looks (owner
 * decision 2026-10-24):
 *  - 'app': inside the signed-in shell, and every frame whose own text sits
 *    on the gradient (mini apps, owner or shared). The palette holds the
 *    legibility floor, so muted text reads at AA on every colour painted.
 *  - 'public': the sign-in, invite and /s reader pages. The full colour the
 *    spec asks for, no floor: these pages put no text directly on the
 *    gradient (their content sits on an opaque card or sheet), which is what
 *    makes dropping the floor safe. A new public surface keeps that rule.
 */
export type DriftSurface = 'public' | 'app';

/** A surface named by markup (a host div's `data-drift-surface`): only the
 *  exact 'public' gets the full-colour look; anything else is the floored
 *  'app' one, so a missing or garbled attribute can never drop the floor. */
export function readDriftSurface(raw: string | null | undefined): DriftSurface {
  return raw === 'public' ? 'public' : 'app';
}

/** Spec + live tokens + mode + surface, to engine options. Pure: the
 *  settings preview and every real surface derive the same picture from the
 *  same inputs. The 'app' surface holds the legibility floor
 *  (DRIFT_TEXT_FLOOR against --muted-foreground), so no strength makes
 *  content text unreadable; 'public' paints the spec's full colour (see
 *  DriftSurface). Pointer lean is never set here: real surfaces keep it off. */
export function driftOptionsFromSpec(
  spec: DriftSpec,
  tokens: DriftThemeTokens,
  mode: 'light' | 'dark',
  surface: DriftSurface,
): Partial<DriftOptions> {
  const palette = driftPaletteFromTheme(tokens, {
    seed: spec.seed,
    tone: spec.tone,
    mode,
    source: spec.pal,
    strength: spec.str,
    textFloor: surface === 'app' ? DRIFT_TEXT_FLOOR : undefined,
  });
  return {
    style: spec.style,
    seed: spec.seed,
    background: palette.background,
    colors: palette.colors,
    // The stored range is the Neat spec's 0 to 6 (default 2); the engine's
    // natural pace is 1.
    speed: spec.speed / 2,
    scale: spec.scale,
    warp: spec.warp,
    softness: spec.soft,
    lighting: spec.light,
    grain: spec.grain,
    angle: spec.angle,
  };
}
