/**
 * The service switch, brain side: what it tells the UI, and the one file it
 * hands the updater. What must hold:
 *
 *  - A switch request goes ONLY to service-request.json, never request.json
 *    (an older updater reads any request.json as "roll to latest"), and the
 *    body is the service name, the boolean and a timestamp, nothing else.
 *  - It is refused, with nothing written, when the box has no updater, when
 *    the updater does not advertise the `service` verb, while a roll runs and
 *    while another switch runs.
 *  - The view says off (grey) for a service whose profile is off even with a
 *    token set, up/down from the probe when on, and warns a small box.
 *  - The helpers row exists only on a core box (anywhere else nothing would
 *    stop them), and the embedder carries its off warning only when this
 *    brain embeds with it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updater = vi.hoisted(() => ({
  available: true,
  status: null as null | { phase: string },
}));
vi.mock('./updates', () => ({
  updaterAvailable: async () => updater.available,
  readUpdaterStatus: async () => updater.status,
}));
const probes = vi.hoisted(() => ({
  sandboxes: null as boolean | null,
  media: null as boolean | null,
  tika: null as string | null,
  browser: null as boolean | null,
  embedding: { provider: 'openrouter', baseUrl: null as string | null },
}));
vi.mock('./sandboxd', () => ({
  sandboxdHealth: async () => ({ up: probes.sandboxes }),
}));
vi.mock('./render-pdf', () => ({
  browserHealth: async () => ({ up: probes.browser, version: null }),
}));
vi.mock('@mantle/files', () => ({
  mediaSidecarHealth: async () => ({ up: probes.media }),
  tikaVersion: async () => probes.tika,
}));
vi.mock('@mantle/embeddings', () => ({
  resolveEmbeddingConfig: async () => ({ model: 'm', primary: probes.embedding }),
}));

import { resetServicesFileCache } from '@mantle/config';
import {
  getServicesView,
  parseServiceRun,
  readServiceRun,
  requestServiceSwitch,
  SERVICE_DESCRIPTIONS,
  usesBundledEmbedder,
} from './services';

const KEYS = [
  'MANTLE_UPDATE_SIGNAL_DIR',
  'MANTLE_COMPOSE_PROFILES',
  'SANDBOXD_URL',
  'SANDBOXD_TOKEN',
  'MEDIA_SIDECAR_URL',
  'MEDIA_SIDECAR_TOKEN',
  'MANTLE_COMPOSE_FILE',
  'MANTLE_LOCAL_EMBEDDING_URL',
] as const;
const saved: Record<string, string | undefined> = {};
let sig: string;

function servicesJson(over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(sig, 'services.json'),
    JSON.stringify({
      profiles: '',
      services: {},
      mem_total_kb: 16 * 1024 * 1024,
      mem_available_kb: 8 * 1024 * 1024,
      disk_free_kb: 50 * 1024 * 1024,
      core: false,
      verbs: ['roll', 'service'],
      checked_at: '2026-10-05T00:00:00Z',
      ...over,
    }),
  );
  resetServicesFileCache();
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  sig = mkdtempSync(join(tmpdir(), 'svc-sig-'));
  process.env.MANTLE_UPDATE_SIGNAL_DIR = sig;
  process.env.SANDBOXD_URL = 'http://sandboxd:8090';
  process.env.SANDBOXD_TOKEN = 'a';
  process.env.MEDIA_SIDECAR_URL = 'http://media:8095';
  process.env.MEDIA_SIDECAR_TOKEN = 'b';
  delete process.env.MANTLE_COMPOSE_PROFILES;
  updater.available = true;
  updater.status = null;
  probes.sandboxes = null;
  probes.media = null;
  probes.tika = null;
  probes.browser = null;
  probes.embedding = { provider: 'openrouter', baseUrl: null };
  delete process.env.MANTLE_COMPOSE_FILE;
  delete process.env.MANTLE_LOCAL_EMBEDDING_URL;
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
  servicesJson();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(sig, { recursive: true, force: true });
  resetServicesFileCache();
  vi.unstubAllGlobals();
});

describe('requestServiceSwitch', () => {
  it('writes only service-request.json, with the name, the switch and a time', async () => {
    expect(await requestServiceSwitch('media', true)).toEqual({ ok: true });
    expect(existsSync(join(sig, 'request.json'))).toBe(false);
    const body = JSON.parse(readFileSync(join(sig, 'service-request.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(['enable', 'requested_at', 'service']);
    expect(body).toMatchObject({ service: 'media', enable: true });
  });

  it('a pending request reads as requested at once', async () => {
    await requestServiceSwitch('sandboxes', false);
    expect(await readServiceRun()).toMatchObject({
      phase: 'requested',
      service: 'sandboxes',
      enable: false,
    });
  });

  const refusals: [string, () => void, RegExp][] = [
    ['no updater', () => (updater.available = false), /no updater sidecar/],
    [
      'an updater without the service verb',
      () => servicesJson({ verbs: ['roll'] }),
      /too old to switch services/,
    ],
    [
      'an updater that wrote no services.json',
      () => {
        rmSync(join(sig, 'services.json'));
        resetServicesFileCache();
      },
      /too old/,
    ],
    ['a roll in progress', () => (updater.status = { phase: 'rolling' }), /update is in progress/],
    ['a roll requested', () => (updater.status = { phase: 'requested' }), /update is in progress/],
    [
      'another switch running',
      () =>
        writeFileSync(
          join(sig, 'service-status.json'),
          '{"phase":"pulling","service":"media","enable":true}',
        ),
      /already being switched/,
    ],
  ];
  for (const [label, arrange, why] of refusals) {
    it(`refuses with nothing written: ${label}`, async () => {
      arrange();
      const r = await requestServiceSwitch('media', true);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toMatch(why);
      expect(existsSync(join(sig, 'service-request.json'))).toBe(false);
    });
  }

  it('a finished run does not block the next', async () => {
    writeFileSync(join(sig, 'service-status.json'), '{"phase":"error","service":"media"}');
    expect(await requestServiceSwitch('media', true)).toEqual({ ok: true });
  });

  it('refuses the helpers on a full box, where nothing would stop them', async () => {
    expect(await requestServiceSwitch('helpers', false)).toMatchObject({ ok: false });
    expect(existsSync(join(sig, 'service-request.json'))).toBe(false);
    servicesJson({ core: true, profiles: 'helpers' });
    expect(await requestServiceSwitch('helpers', false)).toEqual({ ok: true });
  });

  it('switches the local embedder like any other service', async () => {
    expect(await requestServiceSwitch('local-embedder', true)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(sig, 'service-request.json'), 'utf8'))).toMatchObject({
      service: 'local-embedder',
      enable: true,
    });
  });

  it('refuses a name or a switch outside the whitelist', async () => {
    expect(await requestServiceSwitch('postgres' as never, true)).toMatchObject({ ok: false });
    expect(await requestServiceSwitch('media', 'yes' as never)).toMatchObject({ ok: false });
    expect(existsSync(join(sig, 'service-request.json'))).toBe(false);
  });
});

describe('getServicesView', () => {
  it('off is off with a token set; on reads the probe', async () => {
    servicesJson({
      profiles: 'media',
      services: { media: { profile: true, container: 'running', health: 'healthy' } },
    });
    probes.media = true;
    const v = await getServicesView('owner-1');
    const by = Object.fromEntries(v.services.map((s) => [s.name, s]));
    expect(by.sandboxes?.state).toBe('off');
    expect(by.media).toMatchObject({ state: 'up', container: 'running', health: 'healthy' });
    probes.media = false;
    const down = await getServicesView('owner-1');
    expect(down.services.find((s) => s.name === 'media')?.state).toBe('down');
  });

  it('switching is available only with the verb, and says why not', async () => {
    expect((await getServicesView('owner-1')).switching).toEqual({ available: true, reason: null });
    servicesJson({ verbs: ['roll'] });
    expect((await getServicesView('owner-1')).switching.available).toBe(false);
  });

  it('warns a small box, and a core box whatever its memory', async () => {
    expect((await getServicesView('owner-1')).box.smallBox).toBe(false);
    servicesJson({ mem_total_kb: 4 * 1024 * 1024 });
    expect((await getServicesView('owner-1')).box).toMatchObject({
      smallBox: true,
      memTotalBytes: 4 * 1024 ** 3,
    });
    servicesJson({ core: true });
    expect((await getServicesView('owner-1')).box.smallBox).toBe(true);
  });

  it('lists the helpers only on a core box without the full profile', async () => {
    const names = async () => (await getServicesView('owner-1')).services.map((s) => s.name);
    expect(await names()).toEqual(['sandboxes', 'media', 'local-embedder']);
    servicesJson({ core: true });
    expect(await names()).toEqual(['sandboxes', 'media', 'local-embedder', 'helpers']);
    servicesJson({ core: true, profiles: 'full' });
    expect(await names()).not.toContain('helpers');
  });

  it('the helpers are off without their profile, up when both answer', async () => {
    servicesJson({ core: true });
    const helpers = async () =>
      (await getServicesView('owner-1')).services.find((s) => s.name === 'helpers');
    expect((await helpers())?.state).toBe('off');
    servicesJson({ core: true, profiles: 'helpers' });
    probes.tika = '3.3.1';
    probes.browser = true;
    expect((await helpers())?.state).toBe('up');
    probes.tika = null;
    expect((await helpers())?.state).toBe('down');
    expect((await helpers())?.description.offWarning).toMatch(/PDF export stops/);
  });

  it('the embedder is on with its profile, and warns only when it is in use', async () => {
    const embedder = async () =>
      (await getServicesView('owner-1')).services.find((s) => s.name === 'local-embedder');
    expect((await embedder())?.state).toBe('off');
    servicesJson({ profiles: 'local-embedder' });
    expect((await embedder())?.state).toBe('up');
    expect((await embedder())?.description.offWarning).toBeNull();
    probes.embedding = { provider: 'local', baseUrl: null };
    expect((await embedder())?.description.offWarning).toMatch(/not searchable/);
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await embedder())?.state).toBe('down');
  });

  it('every service carries the plain-language description', async () => {
    for (const s of (await getServicesView('owner-1')).services) {
      expect(s.description).toBe(SERVICE_DESCRIPTIONS[s.name]);
      for (const text of [s.description.what, s.description.whenOff, s.description.keeps]) {
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/[–—]/); // house style: no en or em dashes
      }
    }
  });
});

describe('usesBundledEmbedder', () => {
  const bundled = 'http://ollama:11434/v1';
  it('the local provider on the bundled host, or with no address', () => {
    expect(usesBundledEmbedder({ provider: 'local', baseUrl: null }, bundled)).toBe(true);
    expect(
      usesBundledEmbedder({ provider: 'local', baseUrl: 'http://ollama:11434/v1/' }, bundled),
    ).toBe(true);
  });
  it('not a local server elsewhere, nor an online provider', () => {
    expect(
      usesBundledEmbedder({ provider: 'local', baseUrl: 'http://my-gpu-box:1234/v1' }, bundled),
    ).toBe(false);
    expect(usesBundledEmbedder({ provider: 'openrouter', baseUrl: null }, bundled)).toBe(false);
  });
});

describe('parseServiceRun', () => {
  it('reads the updater shape and tolerates junk', () => {
    expect(
      parseServiceRun(
        '{"phase":"done","service":"media","enable":false,"started_at":"a","finished_at":"b","ok":true,"error":""}',
      ),
    ).toEqual({
      phase: 'done',
      service: 'media',
      enable: false,
      startedAt: 'a',
      finishedAt: 'b',
      ok: true,
      error: null,
    });
    expect(parseServiceRun('{"phase":"bogus","service":"x","enable":null}')).toMatchObject({
      phase: 'idle',
      service: null,
      enable: null,
    });
    expect(parseServiceRun('nope')).toBeNull();
  });
});
