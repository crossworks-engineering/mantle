#!/usr/bin/env node
// Generate ANON_KEY and SERVICE_ROLE_KEY for self-hosted Supabase.
//
// Both keys are JWTs (HS256) signed with JWT_SECRET. The role claim
// (`anon` vs `service_role`) is what distinguishes their privilege level
// in Kong's API key auth + RLS policies.
//
// Usage:
//   JWT_SECRET=<your-secret> node scripts/gen-supabase-keys.mjs
//
// Or, picking up the secret from infra/supabase/.env:
//   node --env-file=infra/supabase/.env scripts/gen-supabase-keys.mjs
//
// Defaults to a 10-year expiry — long enough that renewal isn't a
// concern. Rotate by changing JWT_SECRET and regenerating both keys
// (then restart the compose and update apps/web/.env.local on the laptop).

import { createHmac } from 'node:crypto';

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('JWT_SECRET is not set. Export it or use --env-file.');
  process.exit(1);
}
if (secret.length < 32) {
  console.error(`JWT_SECRET must be at least 32 chars (got ${secret.length}).`);
  process.exit(1);
}

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sign(role, secret, years = 10) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + years * 365 * 24 * 60 * 60;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ role, iss: 'supabase', iat: now, exp }));
  const data = `${header}.${payload}`;
  const sig = createHmac('sha256', secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

const anon = sign('anon', secret);
const service = sign('service_role', secret);

console.log('ANON_KEY=' + anon);
console.log('SERVICE_ROLE_KEY=' + service);
console.log();
console.log('# Both signed with JWT_SECRET, valid 10 years.');
console.log('# Paste into infra/supabase/.env (server) AND apps/web/.env.local (laptop).');
