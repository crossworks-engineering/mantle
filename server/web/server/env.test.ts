import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFiles } from './env';

let dir: string;
const env = process.env;

beforeEach(() => {
  process.env = { ...env };
  dir = mkdtempSync(join(tmpdir(), 'env-test-'));
});
afterEach(() => {
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});

describe('loadEnvFiles', () => {
  it('explicit process env ALWAYS beats file values (the e2e contract)', () => {
    writeFileSync(join(dir, '.env.local'), 'DATABASE_URL=postgres://file/db\n');
    process.env.DATABASE_URL = 'postgres://explicit/db';
    loadEnvFiles(dir);
    expect(process.env.DATABASE_URL).toBe('postgres://explicit/db');
  });

  it('.env.local wins over .env; first definition wins', () => {
    writeFileSync(join(dir, '.env.local'), 'A=local\n');
    writeFileSync(join(dir, '.env'), 'A=base\nB=base\n');
    delete process.env.A;
    delete process.env.B;
    loadEnvFiles(dir);
    expect(process.env.A).toBe('local');
    expect(process.env.B).toBe('base');
  });

  it('parses quotes, export prefix, comments and trailing comments', () => {
    writeFileSync(
      join(dir, '.env.local'),
      [
        '# a comment',
        'export QUOTED="hello world"',
        "SINGLE='keep #this'",
        'PLAIN=value # trailing note',
        'EMPTY=',
        'NOISE_LINE_WITHOUT_EQUALS',
      ].join('\n'),
    );
    for (const k of ['QUOTED', 'SINGLE', 'PLAIN', 'EMPTY']) delete process.env[k];
    loadEnvFiles(dir);
    expect(process.env.QUOTED).toBe('hello world');
    expect(process.env.SINGLE).toBe('keep #this');
    expect(process.env.PLAIN).toBe('value');
    expect(process.env.EMPTY).toBe('');
  });

  it('is a no-op when no files exist', () => {
    expect(() => loadEnvFiles(dir)).not.toThrow();
  });
});
