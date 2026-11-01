/**
 * A code tool's `target` argument, read without a store: `app:<id>` (an app's
 * draft source tree), or a bare app id. A leaf (no import of a builtin), so
 * the gate's readers of a call's arguments (item-args.ts, the client-sourced
 * rule, the author ceiling) read the app a target names the same way the
 * tools do. A target of another kind (a later `sandbox:<name>`) names no app.
 */
import { UUID_RE } from '@mantle/std';

export const APP_TARGET_PREFIX = 'app:';

/** The app id a target names (lower case), or null when it names none. */
export function appIdOfCodeTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  const id = v.startsWith(APP_TARGET_PREFIX) ? v.slice(APP_TARGET_PREFIX.length).trim() : v;
  return UUID_RE.test(id) ? id : null;
}

/** A file path as an app's tree keys it: trimmed, no leading `./` or `/`.
 *  The one rule for the code tools and app_file_write / app_file_delete. */
export function normCodePath(raw: unknown): string {
  return (typeof raw === 'string' ? raw : '').trim().replace(/^(\.\/|\/)+/, '');
}

/** The key a path names in a tree: the path exactly as given (trimmed) when
 *  the tree holds it (a key stored before the one rule, `./x.ts`), else the
 *  normalised path. */
export function codeFileKey(files: Readonly<Record<string, string>>, raw: unknown): string {
  const exact = typeof raw === 'string' ? raw.trim() : '';
  return exact && Object.hasOwn(files, exact) ? exact : normCodePath(raw);
}
