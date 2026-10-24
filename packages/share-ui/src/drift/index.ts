export { createDrift, type DriftHandle, type DriftStats } from './engine';
export {
  DRIFT_DEFAULTS,
  DRIFT_MAX_COLORS,
  DRIFT_STYLES,
  DRIFT_STYLE_RESOLUTION,
  normalizeDriftOptions,
  type DriftColor,
  type DriftOptions,
  type DriftStyle,
} from './options';
export {
  DRIFT_SPEC_DEFAULTS,
  DRIFT_SPEC_MAX,
  DRIFT_SPEED_MAX,
  decodeDriftSpec,
  driftOptionsFromSpec,
  encodeDriftSpec,
  randomDriftSpec,
  type DriftSpec,
} from './spec';
export {
  driftPaletteFromTheme,
  readDriftThemeTokens,
  type DriftPaletteSource,
  type DriftThemeTokens,
  type DriftTone,
} from './theme';
