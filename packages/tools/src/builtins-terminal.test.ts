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
  'PATH',
  'MANTLE_TERMINAL_CWD',
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

    const env = sanitizedEnv();

    expect(env.MANTLE_MASTER_KEY).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.MY_PRIVATE_KEY).toBeUndefined();
  });

  it('keeps non-secret vars so git/pnpm/builds still run', () => {
    process.env.MANTLE_TERMINAL_CWD = '/repo';
    const env = sanitizedEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.MANTLE_TERMINAL_CWD).toBe('/repo');
  });
});
