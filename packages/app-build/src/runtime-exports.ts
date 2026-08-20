/**
 * Load the shared runtime's export map — what `/app-runtime/manifest.json`
 * recorded about each specifier during `buildRuntime`.
 *
 * `buildApp` needs this to reject an app that imports a name the runtime does
 * not provide. Reading the GENERATED manifest (rather than re-deriving the
 * names here) keeps one source of truth: the check can only ever describe the
 * runtime that is actually deployed alongside it.
 *
 * Path convention matches server/web/lib/app-frame.ts, which reads the same
 * file for the import map: relative to cwd, which is server/web in dev and in
 * the image. Cached for the process — the file only changes on deploy.
 *
 * A missing or malformed manifest THROWS. It must never degrade to "no
 * exports known", because an empty map would flag every import as invalid, and
 * an optional map would silently stop guarding.
 */
import { readFile } from 'node:fs/promises';

const MANIFEST_PATH = 'public/app-runtime/manifest.json';

let cached: Promise<Record<string, string[]>> | null = null;

export function loadRuntimeExports(
  manifestPath: string = MANIFEST_PATH,
): Promise<Record<string, string[]>> {
  if (!cached) {
    cached = readFile(manifestPath, 'utf8')
      .then((raw) => {
        const m = JSON.parse(raw) as { exports?: Record<string, string[]> };
        if (!m.exports || Object.keys(m.exports).length === 0) {
          throw new Error(
            `${manifestPath} has no 'exports' map — regenerate it with the app-runtime build`,
          );
        }
        return m.exports;
      })
      .catch((e: unknown) => {
        cached = null; // let the next call retry rather than pinning the failure
        throw e;
      });
  }
  return cached;
}
