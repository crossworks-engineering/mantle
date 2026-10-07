/**
 * Give the demo brain its look: colour theme, avatar style and the Neat
 * animated background, through the owner routes the Appearance screens use.
 * They are brain-level preferences (they land on the shared anchor row), so
 * every visitor and every member sees them.
 *
 * The values live in demo/world/world.json (`appearance`). A saved Neat spec
 * is what turns Neat on; an empty one turns it off. DEMO_NEAT_BACKGROUND
 * overrides the spec (compact JSON {v:1, seed, tone, speed}).
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/set-appearance.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPassword } from './lib/secrets.ts';

const here = dirname(fileURLToPath(import.meta.url));
const world = JSON.parse(readFileSync(join(here, '..', 'world', 'world.json'), 'utf8')) as {
  appearance: { colorTheme: string; avatarStyle: string; neatBackground: { v: 1; seed: number; tone: string; speed: number } };
};
const SERVER = process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:3902';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';

let cookie = '';
async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

async function main() {
  const a = world.appearance;
  const neat = (process.env.DEMO_NEAT_BACKGROUND ?? JSON.stringify(a.neatBackground)).trim();
  await call('POST', '/api/auth/login', { email: OWNER_EMAIL, password: ownerPassword() });
  await call('PUT', '/api/profile/color-theme', { colorTheme: a.colorTheme });
  await call('PUT', '/api/profile/avatar', { avatarStyle: a.avatarStyle });
  await call('PUT', '/api/profile/neat-background', { neatBackground: neat });
  // Read back what a visitor's client will read: a value the brain does not
  // know is stored as unset, never as an error, so check it took.
  const shown = await call('GET', '/api/appearance');
  const problems: string[] = [];
  if (shown.colorTheme !== a.colorTheme) problems.push(`colorTheme is ${String(shown.colorTheme)}`);
  if (shown.avatarStyle !== a.avatarStyle) problems.push(`avatarStyle is ${String(shown.avatarStyle)}`);
  if (shown.neatBackground !== neat) problems.push(`neatBackground is ${String(shown.neatBackground)}`);
  if (problems.length) throw new Error(`the brain did not keep the look: ${problems.join('; ')}`);
  console.log(`✓ look set: theme ${a.colorTheme}, avatars ${a.avatarStyle}, Neat ${neat}`);
}

main().catch((err) => {
  console.error('✗ set-appearance failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
