/**
 * The two Control Center lines of a subject box, held to their form
 * (docs/control-center.md): the one check of "is this box linked to a CC",
 * for the web server's subjectConfig (which then reads the key) and the
 * task_submit tool's Send to IT. No crypto here: the key's form only.
 */
import { env, feature } from './index';

export type ControlLines =
  | { on: true; centerUrl: string; keyLine: string; origin: string }
  | { on: false; reason: string | null };

/** `ed25519:` and the standard base64 of 32 bytes. */
const KEY_LINE = /^ed25519:[A-Za-z0-9+/]{43}=$/;

function httpsOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export function controlSubjectLines(): ControlLines {
  const url = (env('MANTLE_CONTROL_CENTER') ?? '').trim();
  const keyLine = (env('MANTLE_CONTROL_CENTER_KEY') ?? '').trim();
  if (!url && !keyLine) return { on: false, reason: null };
  if (!url || !keyLine) return { on: false, reason: 'set both MANTLE_CONTROL_CENTER lines' };
  if (feature('controlCenter')) {
    return { on: false, reason: 'a Control Center is never a subject box' };
  }
  const centerUrl = httpsOrigin(url);
  if (!centerUrl) return { on: false, reason: 'MANTLE_CONTROL_CENTER must be an https URL' };
  if (!KEY_LINE.test(keyLine)) {
    return {
      on: false,
      reason: 'MANTLE_CONTROL_CENTER_KEY must be ed25519: and 32 bytes of base64',
    };
  }
  let origin: string;
  try {
    origin = new URL((env('MANTLE_PUBLIC_URL') ?? '').trim()).origin;
  } catch {
    return { on: false, reason: 'MANTLE_PUBLIC_URL must be set' };
  }
  if (origin === 'null') return { on: false, reason: 'MANTLE_PUBLIC_URL must be set' };
  return { on: true, centerUrl, keyLine, origin };
}
