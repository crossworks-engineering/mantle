/**
 * The Control Center's .env lines (docs/control-center.md, plan section
 * 2.1): a subject only with both lines good, https, MANTLE_PUBLIC_URL set,
 * and never on a CC. No line at all: off, with no reason and no boot line.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlBootLine, controlScopeLine, isControlCenter, subjectConfig } from './env';
import { publicKeyLine } from './sign';

const KEY = publicKeyLine(generateKeyPairSync('ed25519').publicKey);

function set(vars: Record<string, string>) {
  vi.stubEnv('MANTLE_CONTROL_CENTER', '');
  vi.stubEnv('MANTLE_CONTROL_CENTER_KEY', '');
  vi.stubEnv('MANTLE_IS_CONTROL_CENTER', '');
  vi.stubEnv('MANTLE_PUBLIC_URL', 'https://box.example.invalid/');
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

describe('the subject lines', () => {
  it('none set: off, no reason, no boot line', () => {
    set({});
    expect(subjectConfig()).toEqual({ on: false, reason: null });
    expect(controlBootLine()).toBeNull();
    expect(isControlCenter()).toBe(false);
  });

  it('both good: on, with the origin from MANTLE_PUBLIC_URL', () => {
    set({ MANTLE_CONTROL_CENTER: 'https://cc.example.invalid', MANTLE_CONTROL_CENTER_KEY: KEY });
    const s = subjectConfig();
    expect(s.on).toBe(true);
    if (s.on) {
      expect(s.origin).toBe('https://box.example.invalid');
      expect(s.centerUrl).toBe('https://cc.example.invalid');
    }
    expect(controlBootLine()).toContain(
      'managed by the Control Center at https://cc.example.invalid',
    );
  });

  it('off, with the reason, for every bad shape', () => {
    const cases: Record<string, string>[] = [
      { MANTLE_CONTROL_CENTER: 'https://cc.example.invalid' },
      { MANTLE_CONTROL_CENTER_KEY: KEY },
      { MANTLE_CONTROL_CENTER: 'http://cc.example.invalid', MANTLE_CONTROL_CENTER_KEY: KEY },
      { MANTLE_CONTROL_CENTER: 'https://cc.example.invalid', MANTLE_CONTROL_CENTER_KEY: 'rsa:abc' },
      {
        MANTLE_CONTROL_CENTER: 'https://cc.example.invalid',
        MANTLE_CONTROL_CENTER_KEY: KEY,
        MANTLE_PUBLIC_URL: '',
      },
      {
        MANTLE_CONTROL_CENTER: 'https://cc.example.invalid',
        MANTLE_CONTROL_CENTER_KEY: KEY,
        MANTLE_IS_CONTROL_CENTER: 'on',
      },
    ];
    for (const c of cases) {
      set(c);
      const s = subjectConfig();
      expect(s.on, JSON.stringify(c)).toBe(false);
      expect(s.on ? null : s.reason, JSON.stringify(c)).toBeTruthy();
      expect(controlBootLine()).toBeTruthy();
    }
  });

  it('the scope line: admin by default, full or none; any other word is none, named at boot', () => {
    const linked = {
      MANTLE_CONTROL_CENTER: 'https://cc.example.invalid',
      MANTLE_CONTROL_CENTER_KEY: KEY,
    };
    set(linked);
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', '');
    expect(controlScopeLine()).toEqual({ scope: 'admin', bad: null });
    expect(controlBootLine()).toContain('(tool scope: admin)');
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'full');
    expect(controlScopeLine()).toEqual({ scope: 'full', bad: null });
    expect(controlBootLine()).toContain('(tool scope: full)');
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'none');
    expect(controlScopeLine()).toEqual({ scope: null, bad: null });
    expect(controlBootLine()).toContain('(tool scope: none)');
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'everything');
    expect(controlScopeLine()).toEqual({ scope: null, bad: 'everything' });
    const line = controlBootLine()!;
    expect(line).toContain('(tool scope: none)');
    expect(line).toContain('MANTLE_CONTROL_CENTER_SCOPE=everything is not admin, full or none');
    // A look-alike letter (Cyrillic a) is no admin: none.
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', '\u0430dmin');
    expect(controlScopeLine().scope).toBeNull();
    // One line: a value with a line break cannot start a second one.
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'x\nforged line');
    expect(controlBootLine()).not.toMatch(/\n/);
    // Not linked: no boot line, whatever the scope says.
    set({});
    vi.stubEnv('MANTLE_CONTROL_CENTER_SCOPE', 'full');
    expect(controlBootLine()).toBeNull();
  });

  it('the CC line reads an on word', () => {
    set({ MANTLE_IS_CONTROL_CENTER: 'on' });
    expect(isControlCenter()).toBe(true);
    set({ MANTLE_IS_CONTROL_CENTER: 'off' });
    expect(isControlCenter()).toBe(false);
  });
});
