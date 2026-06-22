/**
 * Next.js boot hook — runs once when the web server process starts (and thus on
 * every update, since the container recreates on a new image). We use it to bring
 * an existing brain in line with the system manifest, so a self-hoster who just
 * pulls a new image gets new tools / skills / tool-group membership without having
 * to know to run the `seed:*` scripts. See lib/system-manifest/reconcile.ts.
 *
 * Fire-and-forget + nodejs-only: never delays or blocks request serving, and the
 * reconcile self-guards (production-only, provisioned-only, once per version,
 * best-effort).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { reconcileManifestOnBoot } = await import('@/lib/system-manifest/reconcile');
  void reconcileManifestOnBoot();
}
