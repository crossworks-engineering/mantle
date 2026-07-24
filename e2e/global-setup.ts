import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from '@playwright/test';
import { ensureOwner } from './lib/bootstrap';
import {
  ARTIFACTS_DIR,
  BEARER_PATH,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  SERVER_URL,
  STORAGE_STATE_PATH,
} from './lib/env';

/**
 * One-time setup for the whole run:
 *  1. ensure an onboarded owner exists (real signup/onboarding on fresh stacks)
 *  2. mint the same-origin credential: session COOKIE captured as storageState
 *  3. mint the split credential: a kind-'m' BEARER token. Prefers the
 *     productionized POST /api/auth/token (lands in Phase 2); falls back to
 *     the long-standing /api/auth/mobile-login so the suite runs on any build.
 */
export default async function globalSetup(): Promise<void> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await ensureOwner();

  // Same-origin: cookie session → storageState file.
  const cookieCtx = await request.newContext({ baseURL: SERVER_URL });
  const login = await cookieCtx.post('/api/auth/login', {
    data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  if (!login.ok()) throw new Error(`global-setup: cookie login failed (${login.status()})`);
  await cookieCtx.storageState({ path: STORAGE_STATE_PATH });
  await cookieCtx.dispose();

  // Split: bearer token → artifact file.
  const bearerCtx = await request.newContext({ baseURL: SERVER_URL });
  const creds = { email: OWNER_EMAIL, password: OWNER_PASSWORD, deviceName: 'e2e-suite' };
  let res = await bearerCtx.post('/api/auth/token', { data: creds });
  if (res.status() === 404 || res.status() === 405) {
    res = await bearerCtx.post('/api/auth/mobile-login', { data: creds });
  }
  if (!res.ok()) throw new Error(`global-setup: bearer mint failed (${res.status()})`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('global-setup: bearer response had no token');
  writeFileSync(BEARER_PATH, JSON.stringify({ token: body.token }), 'utf8');
  await bearerCtx.dispose();
}
