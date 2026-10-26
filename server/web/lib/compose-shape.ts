/**
 * Which deploy shape this box runs, read from the very values compose used to
 * start it. docker-compose.yml passes the box's COMPOSE_FILE and
 * COMPOSE_PROFILES to web as MANTLE_COMPOSE_FILE / MANTLE_COMPOSE_PROFILES,
 * and compose interpolates them from .env on every `up`, the updater's
 * included. So the answer is derived, never stored: an updater roll, an
 * installer re-run with -y, `--helpers`, or a hand edit of COMPOSE_FILE all
 * change it the next time web starts, and nothing can go stale.
 */
import { env, readServicesFile } from '@mantle/config';

export type ComposeShape = {
  /** docker-compose.core.yml is loaded: the brain-core shape. */
  core: boolean;
  /** The `helpers` profile is active: the PDF browser runs on a core. */
  helpers: boolean;
  /** The `tika` profile is active: the Tika add-on runs (any shape). */
  tika: boolean;
};

/** Pure, for tests: the shape from a COMPOSE_FILE and a COMPOSE_PROFILES. */
export function composeShapeFrom(
  composeFile: string | undefined,
  composeProfiles: string | undefined,
): ComposeShape {
  const core = (composeFile ?? '').includes('docker-compose.core.yml');
  const profiles = (composeProfiles ?? '').split(',').map((p) => p.trim());
  return { core, helpers: profiles.includes('helpers'), tika: profiles.includes('tika') };
}

/** Live from the updater's services.json when there is one: Settings >
 *  Services can switch the helpers without recreating web, so web's own env
 *  goes stale. Else the values compose gave this container. */
export function composeShape(): ComposeShape {
  const file = readServicesFile();
  if (file) {
    return {
      core: file.core,
      helpers: file.profiles.includes('helpers'),
      tika: file.profiles.includes('tika'),
    };
  }
  return composeShapeFrom(env('MANTLE_COMPOSE_FILE'), env('MANTLE_COMPOSE_PROFILES'));
}

/** Tika is an opt-in add-on on every shape: the in-process readers cover the
 *  formats it used to. Only a box that turned on the `tika` profile expects
 *  it, and there a missing Tika is a real fault. */
export function tikaIsOptional(shape: ComposeShape = composeShape()): boolean {
  return !shape.tika;
}
