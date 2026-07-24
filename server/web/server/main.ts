/**
 * server/web entry point — the Hono replacement for `next start`/`next dev`.
 * Run via tsx (dev: `tsx watch server/main.ts`, prod: image CMD), like
 * server/api and every worker already are.
 *
 * Order matters: env files load BEFORE any app import, because workspace
 * packages capture env at module init (DATABASE_URL, S3_*, …).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from './env';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFiles(webRoot);

// Build identity. Next used to inline NEXT_PUBLIC_* at compile time; under tsx
// the shared @mantle/web-ui/version module reads the same vars at import — so
// resolve them HERE, before anything imports it. Version comes from the ROOT
// package.json (single source of truth); SHA + build time are stamped into the
// image as MANTLE_* (Dockerfile build args).
try {
  const rootPkg = JSON.parse(readFileSync(join(webRoot, '../../package.json'), 'utf8')) as {
    version?: string;
  };
  process.env.NEXT_PUBLIC_APP_VERSION ??= rootPkg.version ?? '0.0.0';
} catch {
  /* keep the module's 0.0.0 fallback */
}
process.env.NEXT_PUBLIC_GIT_SHA ??= process.env.MANTLE_GIT_SHA ?? '';
process.env.NEXT_PUBLIC_BUILD_TIME ??= process.env.MANTLE_BUILD_TIME ?? '';

const { serve } = await import('@hono/node-server');
const { createApp } = await import('./app');

// Boot hook (was instrumentation.ts): bring an existing brain in line with the
// system manifest on every image update. Fire-and-forget — never delays or
// blocks request serving; the reconcile self-guards (production-only,
// provisioned-only, once per version, best-effort).
if (!process.env.MANTLE_PUBLIC_URL && process.env.NEXT_PUBLIC_APP_URL) {
  console.warn(
    '[boot] MANTLE_PUBLIC_URL is unset — falling back to NEXT_PUBLIC_APP_URL for ' +
      'server-side URLs (shares, Microsoft OAuth redirect). Set MANTLE_PUBLIC_URL.',
  );
}
void import('../lib/system-manifest/reconcile')
  .then(({ reconcileManifestOnBoot }) => reconcileManifestOnBoot())
  .catch((err) => console.error('[boot] manifest reconcile failed:', err));

const app = await createApp();
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || '0.0.0.0';

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[server] mantle server/web (hono) listening on http://${hostname}:${info.port}`);
});

// Compose sends SIGTERM on stop/update — close the listener, let in-flight
// requests finish, and bail hard if something (an SSE stream) pins the process.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[server] ${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
