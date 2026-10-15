/**
 * The one flag dialect, the one number dialect and the two registries (A10
 * #11; docs/configuration.md, "Flags and env"). The per-site record of what
 * every reader answered on main lives in server/web/server/a10-flags.test.ts;
 * this pins the parsers' rules and keeps the docs table in step with the
 * registries.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ENV_NUMBERS, envNum } from './numbers';
import { FEATURES, feature, featureSource } from './features';
import { parseFlag, parseNumber } from './parse';
import { resetServicesFileCache } from './services';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const touched = new Set<string>();
function setEnv(name: string, value: string | undefined): void {
  touched.add(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
const saved = { ...process.env };
afterEach(() => {
  for (const k of touched) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  touched.clear();
  resetServicesFileCache();
});

describe('parseFlag', () => {
  it('reads the on and off words in any case, trimmed', () => {
    for (const w of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(parseFlag(w, false), w).toBe(true);
    }
    for (const w of ['0', 'false', 'no', 'off', 'FALSE', ' Off ']) {
      expect(parseFlag(w, true), w).toBe(false);
    }
  });

  it('answers the default for unset, blank and anything else', () => {
    for (const raw of [undefined, null, '', '   ', 'garbage', '2', 'enabled']) {
      expect(parseFlag(raw, true), String(raw)).toBe(true);
      expect(parseFlag(raw, false), String(raw)).toBe(false);
    }
  });
});

describe('parseNumber', () => {
  it('answers the default for blank and for what is not a number', () => {
    for (const raw of [undefined, null, '', '  ', 'garbage', '16abc', 'NaN', 'Infinity']) {
      expect(parseNumber(raw, 7), String(raw)).toBe(7);
    }
  });

  it('reads the whole trimmed value', () => {
    expect(parseNumber(' 12 ', 0)).toBe(12);
    expect(parseNumber('1e3', 0)).toBe(1000);
    expect(parseNumber('2.5', 0)).toBe(2.5);
    expect(parseNumber('-1', 0)).toBe(-1);
  });

  it('applies int, then positive and atLeast, then the clamp', () => {
    expect(parseNumber('2.9', 5, { int: 'floor' })).toBe(2);
    expect(parseNumber('2.5', 5, { int: 'round' })).toBe(3);
    expect(parseNumber('0.5', 5, { int: 'floor', positive: true })).toBe(5);
    expect(parseNumber('0', 5, { positive: true })).toBe(5);
    expect(parseNumber('-3', 5, { positive: true })).toBe(5);
    expect(parseNumber('0', 5, { atLeast: 1 })).toBe(5);
    expect(parseNumber('1', 5, { atLeast: 1 })).toBe(1);
    expect(parseNumber('10', 300, { int: 'round', positive: true, min: 50, max: 600 })).toBe(50);
    expect(parseNumber('900', 300, { int: 'round', positive: true, min: 50, max: 600 })).toBe(600);
    expect(parseNumber('-5', 9, { int: 'floor', min: 0 })).toBe(0);
  });
});

describe('envNum', () => {
  it('reads a registered number with its registered default and range', () => {
    setEnv('MANTLE_RUNNER_CONCURRENCY', undefined);
    expect(envNum('MANTLE_RUNNER_CONCURRENCY')).toBe(8);
    setEnv('MANTLE_RUNNER_CONCURRENCY', '');
    expect(envNum('MANTLE_RUNNER_CONCURRENCY')).toBe(8);
    setEnv('MANTLE_RUNNER_CONCURRENCY', '4.7');
    expect(envNum('MANTLE_RUNNER_CONCURRENCY')).toBe(4);
    setEnv('DWG_RENDER_DPI', '10');
    expect(envNum('DWG_RENDER_DPI')).toBe(50);
  });

  it('takes a caller default where the table has none', () => {
    setEnv('MANTLE_LOCAL_EMBED_TIMEOUT_MS', undefined);
    expect(envNum('MANTLE_LOCAL_EMBED_TIMEOUT_MS', 1234)).toBe(1234);
    setEnv('MANTLE_LOCAL_EMBED_TIMEOUT_MS', '5000');
    expect(envNum('MANTLE_LOCAL_EMBED_TIMEOUT_MS', 1234)).toBe(5000);
  });
});

describe('feature', () => {
  it('reads an env switch in the one dialect, with its default', () => {
    setEnv('MANTLE_TURN_TOKENS', undefined);
    expect(feature('turnTokens')).toBe(true);
    setEnv('MANTLE_TURN_TOKENS', 'off');
    expect(feature('turnTokens')).toBe(false);
    setEnv('MANTLE_RUNS', 'garbage');
    expect(feature('runs')).toBe(false);
    setEnv('MANTLE_RUNS', 'yes');
    expect(feature('runs')).toBe(true);
  });

  it('honours the legacy name of a switch when the new one is unset', () => {
    setEnv('MANTLE_TURN_STREAMING', undefined);
    setEnv('NEXT_PUBLIC_MANTLE_TURN_STREAMING', '0');
    expect(feature('turnStreaming')).toBe(false);
    setEnv('MANTLE_TURN_STREAMING', '1');
    expect(feature('turnStreaming')).toBe(true);
  });

  it('takes the default from the caller for a context switch', () => {
    setEnv('MANTLE_MCP_TERMINAL', undefined);
    expect(feature('mcpTerminal', { default: true })).toBe(true);
    expect(feature('mcpTerminal', { default: false })).toBe(false);
    setEnv('MANTLE_MCP_TERMINAL', 'on');
    expect(feature('mcpTerminal', { default: false })).toBe(true);
  });

  it('keeps a dev-only switch off in production', () => {
    setEnv('MANTLE_DETACHED_DEV', '1');
    setEnv('NODE_ENV', 'development');
    expect(feature('detachedDev')).toBe(true);
    setEnv('NODE_ENV', 'production');
    expect(feature('detachedDev')).toBe(false);
  });

  it('reads a profile switch from the preferences with its PROFILE_FLAGS default', () => {
    expect(feature('shareNeat', { prefs: {} })).toBe(true);
    expect(feature('shareNeat', { prefs: { shareNeat: false } })).toBe(false);
    expect(feature('remoteMcp', { prefs: null })).toBe(false);
    expect(feature('remoteMcp', { prefs: { remoteMcpEnabled: 'true' } })).toBe(false);
    expect(feature('remoteMcp', { prefs: { remoteMcpEnabled: true } })).toBe(true);
  });

  it('reads a service switch from the service state', () => {
    setEnv('MANTLE_UPDATE_SIGNAL_DIR', '/nonexistent-signal-dir');
    setEnv('MANTLE_COMPOSE_PROFILES', 'media');
    setEnv('MEDIA_SIDECAR_URL', 'http://media:8095');
    setEnv('MEDIA_SIDECAR_TOKEN', 'x');
    setEnv('SANDBOXD_URL', undefined);
    expect(feature('media')).toBe(true);
    expect(feature('sandboxes')).toBe(false);
  });
});

describe('the docs table', () => {
  const doc = readFileSync(join(repoRoot, 'docs/configuration.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## Flags and env'));

  it('lists every feature with its source', () => {
    for (const name of Object.keys(FEATURES) as Array<keyof typeof FEATURES>) {
      expect(section, name).toContain(`| \`${name}\` | \`${featureSource(name)}\` |`);
    }
  });

  it('lists every registered number with its default', () => {
    for (const [name, spec] of Object.entries(ENV_NUMBERS)) {
      const def = spec.default === null ? 'the caller' : String(spec.default);
      expect(section, name).toContain(`| \`${name}\` | ${def} |`);
    }
  });
});
