import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  coreShape,
  helpersRun,
  parseServicesFile,
  resetServicesFileCache,
  serviceEnabled,
  serviceProfileOn,
  serviceSwitchable,
  toolService,
  toolServiceAvailable,
} from './services';

const KEYS = [
  'MANTLE_UPDATE_SIGNAL_DIR',
  'MANTLE_COMPOSE_PROFILES',
  'SANDBOXD_URL',
  'SANDBOXD_TOKEN',
  'MEDIA_SIDECAR_URL',
  'MEDIA_SIDECAR_TOKEN',
  'MANTLE_COMPOSE_FILE',
] as const;

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'svc-'));
  // An empty signal dir: no services.json until a test writes one.
  process.env.MANTLE_UPDATE_SIGNAL_DIR = dir;
  resetServicesFileCache();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  resetServicesFileCache();
});

function wire(): void {
  process.env.SANDBOXD_URL = 'http://sandboxd:8090';
  process.env.SANDBOXD_TOKEN = 't1';
  process.env.MEDIA_SIDECAR_URL = 'http://media:8095';
  process.env.MEDIA_SIDECAR_TOKEN = 't2';
}

function servicesJson(profiles: string, core = false): void {
  writeFileSync(
    join(dir, 'services.json'),
    JSON.stringify({
      profiles,
      services: { sandboxes: { profile: profiles.includes('sandboxes'), token: true } },
      mem_total_kb: 8_000_000,
      core,
      verbs: ['roll'],
    }),
  );
  resetServicesFileCache();
}

describe('parseServicesFile', () => {
  it('reads the updater shape, a comma list or an array', () => {
    const f = parseServicesFile(
      '{"profiles":"sandboxes, media","services":{"media":{"profile":true,"token":false,"container":"running","health":"healthy"}},"mem_total_kb":4000000,"mem_available_kb":1000,"disk_free_kb":5,"core":true,"verbs":["roll","service"],"checked_at":"2026-10-05T00:00:00Z"}',
    );
    expect(f).toEqual({
      profiles: ['sandboxes', 'media'],
      services: {
        media: { profile: true, token: false, container: 'running', health: 'healthy' },
      },
      memTotalKb: 4_000_000,
      memAvailableKb: 1000,
      diskFreeKb: 5,
      core: true,
      verbs: ['roll', 'service'],
      checkedAt: '2026-10-05T00:00:00Z',
    });
    expect(parseServicesFile('{"profiles":["media"]}')?.profiles).toEqual(['media']);
  });

  it('defaults a sparse entry and rejects what is not one', () => {
    expect(parseServicesFile('{"profiles":"","services":{"sandboxes":{}}}')?.services).toEqual({
      sandboxes: { profile: false, token: false, container: 'absent', health: 'none' },
    });
    expect(parseServicesFile('not json')).toBeNull();
    expect(parseServicesFile('[]')).toBeNull();
    expect(parseServicesFile('{"services":{}}')).toBeNull();
  });
});

describe('serviceProfileOn: services.json, then compose env, then unknown', () => {
  it('is unknown with neither source', () => {
    expect(serviceProfileOn('sandboxes')).toBeNull();
  });

  it('reads the compose env when there is no file', () => {
    process.env.MANTLE_COMPOSE_PROFILES = 'local-embedder,sandboxes';
    expect(serviceProfileOn('sandboxes')).toBe(true);
    expect(serviceProfileOn('media')).toBe(false);
    process.env.MANTLE_COMPOSE_PROFILES = '';
    expect(serviceProfileOn('sandboxes')).toBe(false);
  });

  it('the live file wins over a stale compose env', () => {
    process.env.MANTLE_COMPOSE_PROFILES = 'sandboxes';
    servicesJson('media');
    expect(serviceProfileOn('sandboxes')).toBe(false);
    expect(serviceProfileOn('media')).toBe(true);
  });
});

describe('serviceEnabled', () => {
  it('needs URL and token whatever the profile says', () => {
    process.env.MANTLE_COMPOSE_PROFILES = 'sandboxes,media';
    expect(serviceEnabled('sandboxes')).toBe(false);
    wire();
    expect(serviceEnabled('sandboxes')).toBe(true);
  });

  it('a token with the profile OFF is off (a disable keeps the token)', () => {
    wire();
    process.env.MANTLE_COMPOSE_PROFILES = 'media';
    expect(serviceEnabled('sandboxes')).toBe(false);
    expect(serviceEnabled('media')).toBe(true);
  });

  it('with no way to know the profile, the token alone decides (pre-switch behaviour)', () => {
    wire();
    expect(serviceEnabled('sandboxes')).toBe(true);
  });
});

describe('the token-less services: local embedder and helpers', () => {
  it('the embedder is on only when its profile is known to be on', () => {
    expect(serviceEnabled('local-embedder')).toBe(false);
    process.env.MANTLE_COMPOSE_PROFILES = 'local-embedder';
    expect(serviceEnabled('local-embedder')).toBe(true);
    servicesJson('sandboxes');
    expect(serviceEnabled('local-embedder')).toBe(false);
  });

  it('the core shape: live file first, then the compose file env', () => {
    expect(coreShape()).toBe(false);
    process.env.MANTLE_COMPOSE_FILE = 'docker-compose.yml:docker-compose.core.yml';
    expect(coreShape()).toBe(true);
    servicesJson('', false);
    expect(coreShape()).toBe(false);
  });

  it('the helpers always run on the full shape, and are not switchable there', () => {
    servicesJson('');
    expect(helpersRun()).toBe(true);
    expect(serviceEnabled('helpers')).toBe(true);
    expect(serviceSwitchable('helpers')).toBe(false);
    expect(serviceSwitchable('local-embedder')).toBe(true);
  });

  it('on a core box the helpers follow their profile', () => {
    servicesJson('', true);
    expect(helpersRun()).toBe(false);
    expect(serviceSwitchable('helpers')).toBe(true);
    servicesJson('helpers', true);
    expect(helpersRun()).toBe(true);
  });

  it('a core box with the full profile runs them whatever the switch says', () => {
    servicesJson('full', true);
    expect(helpersRun()).toBe(true);
    expect(serviceSwitchable('helpers')).toBe(false);
  });

  it('no tool needs either of them', () => {
    expect(toolService('embed')).toBeNull();
  });
});

describe('tool gating', () => {
  it('maps tools to their service', () => {
    expect(toolService('sandbox_exec')).toBe('sandboxes');
    expect(toolService('video_ingest')).toBe('media');
    expect(toolService('note_create')).toBeNull();
  });

  it('drops only the tools whose service is off', () => {
    wire();
    process.env.MANTLE_COMPOSE_PROFILES = 'media';
    expect(toolServiceAvailable('sandbox_exec')).toBe(false);
    expect(toolServiceAvailable('video_ingest')).toBe(true);
    expect(toolServiceAvailable('note_create')).toBe(true);
  });
});
