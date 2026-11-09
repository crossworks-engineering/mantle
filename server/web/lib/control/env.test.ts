/**
 * The Control Center's .env lines (docs/control-center.md, plan section
 * 2.1): a subject only with both lines good, https, MANTLE_PUBLIC_URL set,
 * and never on a CC. No line at all: off, with no reason and no boot line.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlBootLine, isControlCenter, subjectConfig } from './env';
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

  it('the CC line reads an on word', () => {
    set({ MANTLE_IS_CONTROL_CENTER: 'on' });
    expect(isControlCenter()).toBe(true);
    set({ MANTLE_IS_CONTROL_CENTER: 'off' });
    expect(isControlCenter()).toBe(false);
  });
});
