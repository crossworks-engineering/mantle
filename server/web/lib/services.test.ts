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
  browser: null as boolean | null,
  documents: null as boolean | null,
  embedding: { provider: 'openrouter', baseUrl: null as string | null },
}));
vi.mock('./sandboxd', () => ({
  sandboxdHealth: async () => ({ up: probes.sandboxes }),
}));
vi.mock('./render-pdf', () => ({
  browserHealth: async () => ({ up: probes.browser, version: null }),
}));
vi.mock('@mantle/documents', () => ({
  gotenbergHealth: async () => ({ up: probes.documents, version: null, modules: {} }),
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
  'MANTLE_COMPOSE_FILE',
  'MANTLE_LOCAL_EMBEDDING_URL',
  'GOTENBERG_URL',
  'GOTENBERG_PASSWORD',
] as const;
const saved: Record<string, string | undefined> = {};
let sig: string;

/** What an updater that knows all four services reports. */
const ALL_SERVICES = {
  sandboxes: { profile: false },
  'local-embedder': { profile: false },
  helpers: { profile: false },
  documents: { profile: false },
};

function servicesJson(over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(sig, 'services.json'),
    JSON.stringify({
      profiles: '',
      services: ALL_SERVICES,
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
  process.env.GOTENBERG_URL = 'http://gotenberg:3000';
  process.env.GOTENBERG_PASSWORD = 'p';
  delete process.env.MANTLE_COMPOSE_PROFILES;
  updater.available = true;
  updater.status = null;
  probes.sandboxes = null;
  probes.browser = null;
  probes.documents = null;
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
    expect(await requestServiceSwitch('sandboxes', true)).toEqual({ ok: true });
    expect(existsSync(join(sig, 'request.json'))).toBe(false);
    const body = JSON.parse(readFileSync(join(sig, 'service-request.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(['enable', 'requested_at', 'service']);
    expect(body).toMatchObject({ service: 'sandboxes', enable: true });
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
          '{"phase":"pulling","service":"sandboxes","enable":true}',
        ),
      /already being switched/,
    ],
  ];
  for (const [label, arrange, why] of refusals) {
    it(`refuses with nothing written: ${label}`, async () => {
      arrange();
      const r = await requestServiceSwitch('sandboxes', true);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toMatch(why);
      expect(existsSync(join(sig, 'service-request.json'))).toBe(false);
    });
  }

  it('a finished run does not block the next', async () => {
    writeFileSync(join(sig, 'service-status.json'), '{"phase":"error","service":"sandboxes"}');
    expect(await requestServiceSwitch('sandboxes', true)).toEqual({ ok: true });
  });

  it('refuses the helpers on a full box, where nothing would stop them', async () => {
    expect(await requestServiceSwitch('helpers', false)).toMatchObject({ ok: false });
    expect(existsSync(join(sig, 'service-request.json'))).toBe(false);
    servicesJson({ core: true, profiles: 'helpers', services: { helpers: { profile: true } } });
    expect(await requestServiceSwitch('helpers', false)).toEqual({ ok: true });
  });

  it('refuses a newer service the box updater does not report yet', async () => {
    servicesJson({ services: { sandboxes: {} } });
    expect(await requestServiceSwitch('local-embedder', true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('does not know this service yet'),
    });
    expect(existsSync(join(sig, 'service-request.json'))).toBe(false);
  });

  it('switches the local embedder like any other service', async () => {
    servicesJson({ services: { 'local-embedder': { profile: false } } });
    expect(await requestServiceSwitch('local-embedder', true)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(sig, 'service-request.json'), 'utf8'))).toMatchObject({
      service: 'local-embedder',
      enable: true,
    });
  });

  it('refuses a name or a switch outside the whitelist', async () => {
    expect(await requestServiceSwitch('postgres' as never, true)).toMatchObject({ ok: false });
    expect(await requestServiceSwitch('sandboxes', 'yes' as never)).toMatchObject({ ok: false });
    // The removed media sidecar is not a service any more.
    expect(await requestServiceSwitch('media' as never, true)).toMatchObject({ ok: false });
    expect(existsSync(join(sig, 'service-request.json'))).toBe(false);
  });
});

describe('getServicesView', () => {
  it('off is off with a token set; on reads the probe', async () => {
    const off = await getServicesView('owner-1');
    expect(off.services.find((s) => s.name === 'sandboxes')?.state).toBe('off');
    servicesJson({
      profiles: 'sandboxes',
      services: { sandboxes: { profile: true, container: 'running', health: 'healthy' } },
    });
    probes.sandboxes = true;
    const v = await getServicesView('owner-1');
    const by = Object.fromEntries(v.services.map((s) => [s.name, s]));
    expect(by.sandboxes).toMatchObject({ state: 'up', container: 'running', health: 'healthy' });
    probes.sandboxes = false;
    const down = await getServicesView('owner-1');
    expect(down.services.find((s) => s.name === 'sandboxes')?.state).toBe('down');
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

  it('an older updater (no newer services reported): only the first is offered', async () => {
    servicesJson({ core: true, services: { sandboxes: {}, media: {} } });
    expect((await getServicesView('owner-1')).services.map((s) => s.name)).toEqual(['sandboxes']);
  });

  it('lists the helpers only on a core box without the full profile', async () => {
    const names = async () => (await getServicesView('owner-1')).services.map((s) => s.name);
    expect(await names()).toEqual(['sandboxes', 'local-embedder', 'documents']);
    servicesJson({ core: true });
    expect(await names()).toEqual(['sandboxes', 'local-embedder', 'helpers', 'documents']);
    servicesJson({ core: true, profiles: 'full' });
    expect(await names()).not.toContain('helpers');
  });

  it('the helper is off without its profile, up when the browser answers', async () => {
    servicesJson({ core: true });
    const helpers = async () =>
      (await getServicesView('owner-1')).services.find((s) => s.name === 'helpers');
    expect((await helpers())?.state).toBe('off');
    servicesJson({ core: true, profiles: 'helpers' });
    probes.browser = true;
    expect((await helpers())?.state).toBe('up');
    probes.browser = false;
    expect((await helpers())?.state).toBe('down');
    expect((await helpers())?.description.offWarning).toMatch(/PDF export stops/);
  });

  it('the documents engine is off without its profile, up when it answers, and warns before off', async () => {
    const docs = async () =>
      (await getServicesView('owner-1')).services.find((s) => s.name === 'documents');
    expect((await docs())?.state).toBe('off');
    servicesJson({
      profiles: 'documents',
      services: { ...ALL_SERVICES, documents: { profile: true } },
    });
    probes.documents = true;
    expect((await docs())?.state).toBe('up');
    probes.documents = false;
    expect((await docs())?.state).toBe('down');
    expect((await docs())?.description.offWarning).toMatch(/Office to PDF/);
    expect((await docs())?.description.memoryMaxMb).toBe(2048);
  });

  it('an updater that does not report the documents engine yet does not offer it', async () => {
    servicesJson({ services: { sandboxes: {}, 'local-embedder': {}, helpers: {} } });
    expect((await getServicesView('owner-1')).services.map((s) => s.name)).not.toContain(
      'documents',
    );
    expect(await requestServiceSwitch('documents', true)).toMatchObject({ ok: false });
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
        '{"phase":"done","service":"sandboxes","enable":false,"started_at":"a","finished_at":"b","ok":true,"error":""}',
      ),
    ).toEqual({
      phase: 'done',
      service: 'sandboxes',
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
