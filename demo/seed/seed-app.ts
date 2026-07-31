/**
 * Seed the demo's showcase mini-app.
 *
 * /apps is the hardest screen to demo, because an empty app list says nothing
 * about what the app builder can do. This pushes one deliberately good-looking
 * app through the REAL pipeline an owner would use — create, draft, build,
 * publish — so the demo shows a built, published app rather than a stub row.
 *
 * The app is a SHELL: every figure in it is a constant. That is the honest
 * choice for a read-only demo. A dashboard wired to nothing can never contradict
 * the brain behind it, and nobody is misled into thinking the demo is connected
 * to plant.
 *
 * The build step is where this earns its keep: it type-checks and bundles the
 * source exactly as the owner's Studio would, so a broken app fails HERE, in
 * the seed, rather than rendering an error card in front of an audience.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/seed-app.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:3902';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const OWNER_PASSWORD = process.env.DEMO_OWNER_PASSWORD ?? 'demo-brain-not-a-real-password';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '../apps/control-room');

const APP = {
  name: 'PS3 Control Room',
  description: 'Live-style station overview for the pumphouse — flow, pump set, and overnight events.',
  icon: '🎛️',
  tags: ['pumphouse', 'demo'],
  entry: 'App.tsx',
};

let cookie = '';
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return res;
}

/** Every source file under the app dir, keyed by its path relative to it. */
function readSources(dir: string, acc: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) readSources(p, acc);
    else if (/\.(tsx?|css)$/.test(name)) acc[relative(APP_DIR, p)] = readFileSync(p, 'utf8');
  }
  return acc;
}

async function main() {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!login.ok) {
    console.error(`✗ login failed: ${login.status}`);
    process.exit(1);
  }

  const files = readSources(APP_DIR);
  if (!files[APP.entry]) {
    console.error(`✗ entry ${APP.entry} not found in ${APP_DIR}`);
    process.exit(1);
  }
  console.log(`· ${Object.keys(files).length} source file(s), entry ${APP.entry}`);

  // Idempotent: reuse the app if it is already there, so a re-run updates the
  // source instead of stacking duplicates in the list.
  const list = (await (await api('/api/apps?limit=100')).json().catch(() => ({}))) as {
    apps?: { id: string; name: string }[];
  };
  let id = list.apps?.find((a) => a.name === APP.name)?.id;

  if (!id) {
    const res = await api('/api/apps', {
      method: 'POST',
      body: JSON.stringify({
        name: APP.name,
        description: APP.description,
        icon: APP.icon,
        tags: APP.tags,
      }),
    });
    if (!res.ok) {
      console.error(`✗ create failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      process.exit(1);
    }
    const out = (await res.json()) as { app?: { id: string }; id?: string };
    id = out.app?.id ?? out.id;
    console.log(`· created ${id}`);
  } else {
    console.log(`· reusing ${id}`);
  }
  if (!id) {
    console.error('✗ no app id came back');
    process.exit(1);
  }

  const draft = await api(`/api/apps/${id}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ entry: APP.entry, files }),
  });
  if (!draft.ok) {
    console.error(`✗ draft failed: ${draft.status} ${(await draft.text()).slice(0, 300)}`);
    process.exit(1);
  }

  // The build is the real check. Its errors are the compiler's, so a typo in
  // the app surfaces here with a line number rather than as a blank card.
  const build = await api(`/api/apps/${id}/build`, { method: 'POST' });
  const outcome = (await build.json().catch(() => ({}))) as { ok?: boolean; errors?: unknown[] };
  if (!build.ok || outcome.ok === false || (outcome.errors ?? []).length) {
    console.error(`✗ build failed:`);
    for (const e of outcome.errors ?? []) console.error('   ' + JSON.stringify(e).slice(0, 220));
    process.exit(1);
  }
  console.log('· built');

  const pub = await api(`/api/apps/${id}/publish`, { method: 'POST' });
  if (!pub.ok) {
    console.error(`✗ publish failed: ${pub.status} ${(await pub.text()).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`✓ app seeded, built and published: ${APP.name}`);
}

main().catch((err) => {
  console.error('✗ seed-app failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
