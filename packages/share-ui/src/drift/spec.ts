import type { DriftOptions } from './options';
import type { DriftSpec } from '@mantle/content-core/drift-spec';
import { driftPaletteFromTheme, type DriftThemeTokens } from './theme';

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

/** Spec + live tokens + mode, to engine options. Pure: the settings preview
 *  and every real surface derive the same picture from the same inputs. */
export function driftOptionsFromSpec(
  spec: DriftSpec,
  tokens: DriftThemeTokens,
  mode: 'light' | 'dark',
): Partial<DriftOptions> {
  const palette = driftPaletteFromTheme(tokens, {
    seed: spec.seed,
    tone: spec.tone,
    mode,
    source: spec.pal,
    strength: spec.str,
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
