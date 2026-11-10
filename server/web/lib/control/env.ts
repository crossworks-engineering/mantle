/**
 * The Control Center's .env lines (docs/control-center.md, plan section
 * 2.1). Read from the process env only: no settings row, no route, no tool
 * sets them, so nothing in the box UI can change them.
 *
 *  - A subject box: MANTLE_CONTROL_CENTER (the CC's https URL) and
 *    MANTLE_CONTROL_CENTER_KEY (its public key). On only when both are set,
 *    the key is `ed25519:` + the standard base64 of 32 bytes, the URL is
 *    https, MANTLE_PUBLIC_URL is set, and the box is not itself a CC.
 *  - The CC: MANTLE_IS_CONTROL_CENTER=on.
 *
 * CC code is never loaded off a CC (owner decision B, 2026-11-09): SCIM,
 * the Fleet routes, the CC store (@mantle/db/control-center), the control_*
 * tools and the control service's loop each load behind the one check,
 * isControlCenter, with a lazy import after it. This module and the box
 * side (./box.ts, ./sign.ts) stay on every box. cc-only.test.ts pins it.
 */
import type { KeyObject } from 'node:crypto';
import { env, feature } from '@mantle/config';
import { NextResponse } from '@/server/http-compat';
import { parsePublicKeyLine } from './sign';

export type SubjectConfig =
  | { on: true; centerUrl: string; key: KeyObject; origin: string }
  | { on: false; reason: string | null };

/** The CC side: MANTLE_IS_CONTROL_CENTER set to an on word. */
export function isControlCenter(): boolean {
  return feature('controlCenter');
}

/** The plain 404 a CC-only route answers off a CC (the same for every
 *  path, with nothing that says the route exists), else null. A route
 *  calls it before it imports any CC code. */
export function ccOff(): Response | null {
  return isControlCenter() ? null : NextResponse.json({ error: 'not found' }, { status: 404 });
}

function httpsOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Whether this box obeys a CC, and if not, why (null: no line set). */
export function subjectConfig(): SubjectConfig {
  const url = (env('MANTLE_CONTROL_CENTER') ?? '').trim();
  const keyLine = (env('MANTLE_CONTROL_CENTER_KEY') ?? '').trim();
  if (!url && !keyLine) return { on: false, reason: null };
  if (!url || !keyLine) return { on: false, reason: 'set both MANTLE_CONTROL_CENTER lines' };
  if (isControlCenter()) {
    return { on: false, reason: 'a Control Center is never a subject box' };
  }
  const centerUrl = httpsOrigin(url);
  if (!centerUrl) return { on: false, reason: 'MANTLE_CONTROL_CENTER must be an https URL' };
  const key = parsePublicKeyLine(keyLine);
  if (!key) {
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
  return { on: true, centerUrl, key, origin };
}

/** The one boot line (server/main.ts). Null when no line is set. */
export function controlBootLine(): string | null {
  const parts: string[] = [];
  if (isControlCenter()) parts.push('this box is a Control Center');
  const s = subjectConfig();
  if (s.on) parts.push(`this box is managed by the Control Center at ${s.centerUrl}`);
  else if (s.reason) parts.push(`Control Center link off: ${s.reason}`);
  return parts.length ? parts.join('; ') : null;
}
