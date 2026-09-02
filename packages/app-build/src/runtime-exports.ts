/**
 * Load the shared runtime's export map — what `/app-runtime/manifest.json`
 * recorded about each specifier during `buildRuntime`.
 *
 * `buildApp` needs this to reject an app that imports a name the runtime does
 * not provide. Reading the GENERATED manifest (rather than re-deriving the
 * names here) keeps one source of truth: the check can only ever describe the
 * runtime that is actually deployed alongside it.
 *
 * Resolution deliberately does NOT trust the working directory. The manifest is
 * generated into server/web/public, and server/web's cwd is what
 * `server/web/lib/app-frame.ts` relies on — but app_build also runs from the
 * MCP server, whose cwd is server/mcp, and a bare relative path there resolves
 * to nothing. That cost a live build outage: every agent-driven app_build
 * failed with ENOENT until the lookup stopped assuming one caller. So the
 * package locates the manifest relative to ITSELF first (the repo and the image
 * share the same layout), falls back to the cwd convention for anything that
 * relocates it, and takes an explicit env override ahead of both.
 *
 * A missing or malformed manifest THROWS, naming every path it tried. It must
 * never degrade to "no exports known": an empty map would flag every import as
 * invalid, and an optional one would silently stop guarding.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '@mantle/config';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** In order of trust: explicit override, package-relative, cwd convention. */
export function manifestCandidates(): string[] {
  const override = env('MANTLE_APP_RUNTIME_MANIFEST');
  return [
    ...(override ? [override] : []),
    // packages/app-build/src → <root>/server/web/public/app-runtime/manifest.json
    path.resolve(HERE, '../../../server/web/public/app-runtime/manifest.json'),
    path.resolve('public/app-runtime/manifest.json'),
  ];
}

/** Keyed by the candidate list rather than a single flag: the paths are stable
 *  in production (so this is still one read per process), and a changed
 *  override naturally re-resolves instead of serving another location's
 *  answer. */
const cache = new Map<string, Promise<Record<string, string[]>>>();

export function loadRuntimeExports(
  /** Injectable for tests only — production always uses the real candidates.
   *  A test cannot isolate the not-found path otherwise, because the
   *  package-relative candidate resolves inside the repo itself. */
  candidates: string[] = manifestCandidates(),
): Promise<Record<string, string[]>> {
  const key = candidates.join('\u0000');
  let cached = cache.get(key);
  if (!cached) {
    cached = (async () => {
      const tried: string[] = [];
      for (const candidate of candidates) {
        tried.push(candidate);
        let raw: string;
        try {
          raw = await readFile(candidate, 'utf8');
        } catch {
          continue; // not here; try the next location
        }
        // Present but unusable is a hard error — never fall through to another
        // candidate, or a stale copy elsewhere could silently win.
        const m = JSON.parse(raw) as { exports?: Record<string, string[]> };
        if (!m.exports || Object.keys(m.exports).length === 0) {
          throw new Error(
            `${candidate} has no 'exports' map — regenerate it with the app-runtime build`,
          );
        }
        return m.exports;
      }
      throw new Error(
        `app-runtime manifest not found. Tried:\n  ${tried.join('\n  ')}\n` +
          'Generate it with the app-runtime build, or set MANTLE_APP_RUNTIME_MANIFEST.',
      );
    })().catch((e: unknown) => {
      cache.delete(key); // let the next call retry rather than pinning the failure
      throw e;
    });
    cache.set(key, cached);
  }
  return cached;
}
