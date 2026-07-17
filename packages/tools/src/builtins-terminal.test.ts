/**
 * run_terminal feeds child stdout/stderr straight to the model, so the child's
 * env must never carry the at-rest encryption key or other secrets — otherwise
 * a single `env` call exfiltrates them. sanitizedEnv is that filter.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { sanitizedEnv } from './builtins-terminal';

const TOUCHED = [
  'MANTLE_MASTER_KEY',
  'SESSION_SECRET',
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'SOME_TOKEN',
  'DB_PASSWORD',
  'MY_PRIVATE_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'PATH',
  'MANTLE_TERMINAL_CWD',
  'MONKEY_BUSINESS',
  'KEYCLOAK_URL',
];

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
});

describe('sanitizedEnv', () => {
  it('drops the encryption/session/db roots and secret-shaped names', () => {
    process.env.MANTLE_MASTER_KEY = 'deadbeef';
    process.env.SESSION_SECRET = 'sess';
    process.env.DATABASE_URL = 'postgres://x';
    process.env.OPENAI_API_KEY = 'sk-1';
    process.env.SOME_TOKEN = 't';
    process.env.DB_PASSWORD = 'p';
    process.env.MY_PRIVATE_KEY = 'k';
    process.env.S3_ACCESS_KEY = 'ak';
    process.env.S3_SECRET_KEY = 'sk';

    const env = sanitizedEnv();

    expect(env.MANTLE_MASTER_KEY).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.MY_PRIVATE_KEY).toBeUndefined();
    // The gap this closes: plain *_KEY names (not just api_key/private_key).
    expect(env.S3_ACCESS_KEY).toBeUndefined();
    expect(env.S3_SECRET_KEY).toBeUndefined();
  });

  it('keeps non-secret vars so git/pnpm/builds still run (no substring false positives)', () => {
    process.env.MANTLE_TERMINAL_CWD = '/repo';
    process.env.MONKEY_BUSINESS = 'ok'; // contains "key" but not as a segment
    process.env.KEYCLOAK_URL = 'https://kc'; // starts with "key" but not a segment
    const env = sanitizedEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.MANTLE_TERMINAL_CWD).toBe('/repo');
    expect(env.MONKEY_BUSINESS).toBe('ok');
    expect(env.KEYCLOAK_URL).toBe('https://kc');
  });
});
