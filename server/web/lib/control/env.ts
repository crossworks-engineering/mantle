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
import { controlSubjectLines, env, feature } from '@mantle/config';
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

/** Whether this box obeys a CC, and if not, why (null: no line set). The
 *  lines' form is @mantle/config's controlSubjectLines, the one check the
 *  task_submit tool asks too; here the key is read. */
export function subjectConfig(): SubjectConfig {
  const lines = controlSubjectLines();
  if (!lines.on) return lines;
  const key = parsePublicKeyLine(lines.keyLine);
  if (!key) {
    return {
      on: false,
      reason: 'MANTLE_CONTROL_CENTER_KEY must be ed25519: and 32 bytes of base64',
    };
  }
  return { on: true, centerUrl: lines.centerUrl, key, origin: lines.origin };
}

/** The Control Center's name on this box's Send button
 *  (MANTLE_CONTROL_CENTER_LABEL, set with the two CC lines): IT by default.
 *  Plain words only, at most 24 characters. */
export function controlCenterLabel(): string {
  const v = (env('MANTLE_CONTROL_CENTER_LABEL') ?? '').trim();
  return /^[\p{L}\p{N} ._-]{1,24}$/u.test(v) ? v : 'IT';
}

/** The admin channel's scope (docs/control-center.md, "The admin channel"):
 *  what a linked box lets the CC run through its signed `tool` call. */
export type ControlScope = 'admin' | 'full';

/**
 * The box's scope line, MANTLE_CONTROL_CENTER_SCOPE (owner decision,
 * 2026-11-12: admin by default, so linking stays the two lines). Absent or
 * empty: admin. `full`: every tool, data reads too. `none`: the channel
 * off (the fixed cases only). Any other word fails closed: none, and `bad`
 * names it for the boot line. Read only on a linked box: an unlinked one
 * answers 404 to every call before any scope is read.
 */
export function controlScopeLine(): { scope: ControlScope | null; bad: string | null } {
  const raw = (env('MANTLE_CONTROL_CENTER_SCOPE') ?? '').trim();
  const v = raw.toLowerCase();
  if (v === '' || v === 'admin') return { scope: 'admin', bad: null };
  if (v === 'full') return { scope: 'full', bad: null };
  if (v === 'none') return { scope: null, bad: null };
  return { scope: null, bad: raw.replace(/[^\x21-\x7e]/g, '?').slice(0, 40) };
}

/** The one boot line (server/main.ts). Null when no line is set. */
export function controlBootLine(): string | null {
  const parts: string[] = [];
  if (isControlCenter()) parts.push('this box is a Control Center');
  const s = subjectConfig();
  if (s.on) {
    const { scope, bad } = controlScopeLine();
    parts.push(
      `this box is managed by the Control Center at ${s.centerUrl} (tool scope: ${scope ?? 'none'})`,
    );
    if (bad !== null) {
      parts.push(
        `MANTLE_CONTROL_CENTER_SCOPE=${bad} is not admin, full or none: the tool scope is none`,
      );
    }
  } else if (s.reason) parts.push(`Control Center link off: ${s.reason}`);
  return parts.length ? parts.join('; ') : null;
}
