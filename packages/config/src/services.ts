/**
 * Optional services: is the sandboxes or media service switched on for this
 * box? The ONE answer every caller reads (the dashboard pills, /api/sandboxes,
 * the sandbox tools, video_ingest, the CAD render path, the agent tool list).
 * Two more services carry no token and gate no tool, but are switched the
 * same way from Settings > Services: the bundled local embedder (profile
 * `local-embedder`) and, on a core box only, the doc helpers (Tika and the
 * PDF browser, profile `helpers`). See the end of this module.
 *
 * Sandboxes and media are compose PROFILES. Before this module, "on" meant "the
 * bearer token is in this container's env", which is wrong twice over: a
 * disable keeps the token (the pill turned red, "unreachable", instead of
 * grey), and a token pre-provisioned on every box would make every box look
 * on. So "on" is now the profile, derived at read time, never stored:
 *
 *   1. /signal/services.json, which the updater sidecar rewrites from the
 *      box's .env (boot, every ~5 min, after a roll and after a switch).
 *      Live: a switch that starts one container (`up --no-deps`) leaves the
 *      app containers' env as it was, and this file is what they see change.
 *   2. MANTLE_COMPOSE_PROFILES, the COMPOSE_PROFILES compose resolved when it
 *      created THIS container. Correct until the next switch; the fallback
 *      for a box whose updater predates services.json.
 *   3. Neither (a dev process outside compose): unknown, and the token alone
 *      decides, exactly as before.
 *
 * "On" still also needs the URL and token (a profile without its token runs a
 * degraded container that refuses every call). Whether the service ANSWERS is
 * a separate question for the health probes; this module never makes a
 * network call, so it is safe on every hot path, and a service that is off is
 * never dialled (its hostname does not exist on the compose network).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, type KnownEnvName } from './index';

/** Every service Settings > Services can switch. Each name is also its
 *  compose profile. */
export const OPTIONAL_SERVICES = ['sandboxes', 'media', 'local-embedder', 'helpers'] as const;
export type OptionalService = (typeof OPTIONAL_SERVICES)[number];

/** The services the app talks to with a bearer token. "On" needs the token
 *  too; the other two are on when their profile is. */
const WIRING: Partial<Record<OptionalService, { url: KnownEnvName; token: KnownEnvName }>> = {
  sandboxes: { url: 'SANDBOXD_URL', token: 'SANDBOXD_TOKEN' },
  media: { url: 'MEDIA_SIDECAR_URL', token: 'MEDIA_SIDECAR_TOKEN' },
};

/** One service as the updater saw it. `container` is docker's State.Status
 *  ('running', 'exited', ...) or 'absent'; `health` is the healthcheck status
 *  or 'none'. */
export type ServiceFileEntry = {
  profile: boolean;
  token: boolean;
  container: string;
  health: string;
};

/** /signal/services.json, written by infra/updater/updater.sh. */
export type ServicesFile = {
  profiles: string[];
  services: Partial<Record<OptionalService, ServiceFileEntry>>;
  /** Host memory from the updater's /proc/meminfo (a container sees the
   *  host's), for the small-box warning. */
  memTotalKb: number | null;
  memAvailableKb: number | null;
  /** Free space on the filesystem holding the stack dir. */
  diskFreeKb: number | null;
  /** docker-compose.core.yml is loaded: the 4 GB brain-core shape. */
  core: boolean;
  /** Request kinds this updater understands ('roll'; 'service' once it can
   *  switch a service). The UI offers a switch only when it is listed. */
  verbs: string[];
  checkedAt: string | null;
};

export function splitProfiles(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Pure, for tests: a services.json body, or null when it is not one. */
export function parseServicesFile(raw: string): ServicesFile | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (typeof o.profiles !== 'string' && !Array.isArray(o.profiles)) return null;
  const profiles = Array.isArray(o.profiles)
    ? o.profiles.filter((p): p is string => typeof p === 'string')
    : splitProfiles(o.profiles as string);
  const services: ServicesFile['services'] = {};
  const rawServices = (o.services ?? {}) as Record<string, unknown>;
  for (const name of OPTIONAL_SERVICES) {
    const s = rawServices[name] as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object') continue;
    services[name] = {
      profile: s.profile === true,
      token: s.token === true,
      container: typeof s.container === 'string' && s.container ? s.container : 'absent',
      health: typeof s.health === 'string' && s.health ? s.health : 'none',
    };
  }
  return {
    profiles,
    services,
    memTotalKb: num(o.mem_total_kb),
    memAvailableKb: num(o.mem_available_kb),
    diskFreeKb: num(o.disk_free_kb),
    core: o.core === true,
    verbs: Array.isArray(o.verbs) ? o.verbs.filter((v): v is string => typeof v === 'string') : [],
    checkedAt: typeof o.checked_at === 'string' && o.checked_at ? o.checked_at : null,
  };
}

/** A few seconds of cache: the file changes on a switch or a roll, and the
 *  callers include per-turn and per-file paths. */
const CACHE_MS = 3_000;
let cache: { at: number; dir: string; value: ServicesFile | null } | null = null;

export function signalDir(): string {
  return env('MANTLE_UPDATE_SIGNAL_DIR') ?? '/signal';
}

/** The updater's services.json, or null when this process cannot read one
 *  (no /signal mount, an updater that predates it, a dev process). */
export function readServicesFile(): ServicesFile | null {
  const dir = signalDir();
  const now = Date.now();
  if (cache && cache.dir === dir && now - cache.at < CACHE_MS) return cache.value;
  let value: ServicesFile | null;
  try {
    value = parseServicesFile(readFileSync(join(dir, 'services.json'), 'utf8'));
  } catch {
    value = null;
  }
  cache = { at: now, dir, value };
  return value;
}

/** Tests only: forget the cached file. */
export function resetServicesFileCache(): void {
  cache = null;
}

/** Is the service's profile active? true/false when this process can tell,
 *  null when it cannot (see the module note for the order of sources). */
export function serviceProfileOn(name: OptionalService): boolean | null {
  const file = readServicesFile();
  if (file) return file.profiles.includes(name);
  const fromCompose = env('MANTLE_COMPOSE_PROFILES');
  if (fromCompose !== undefined) return splitProfiles(fromCompose).includes(name);
  return null;
}

/** URL and token are both set: the app side is wired to talk to it. A
 *  service with no token is wired whenever compose runs it. */
export function serviceConfigured(name: OptionalService): boolean {
  const w = WIRING[name];
  return !w || Boolean(env(w.url) && env(w.token));
}

/** The service is switched on for this box: wired AND its profile active (or
 *  the profile cannot be known here, the pre-switch behaviour). The gate for
 *  every caller; a running-but-unhealthy service is still "on" and its calls
 *  fail with their own error. */
export function serviceEnabled(name: OptionalService): boolean {
  if (name === 'local-embedder') return serviceProfileOn(name) === true;
  if (name === 'helpers') return helpersRun();
  return serviceConfigured(name) && serviceProfileOn(name) !== false;
}

/** docker-compose.core.yml is loaded: the 4 GB core shape. Live from
 *  services.json, else what compose gave this container. */
export function coreShape(): boolean {
  const file = readServicesFile();
  if (file) return file.core;
  return (env('MANTLE_COMPOSE_FILE') ?? '').includes('docker-compose.core.yml');
}

/** The profiles active on this box: live from services.json, else what
 *  compose gave this container, else null (a dev process). */
function activeProfiles(): string[] | null {
  const file = readServicesFile();
  if (file) return file.profiles;
  const fromCompose = env('MANTLE_COMPOSE_PROFILES');
  return fromCompose === undefined ? null : splitProfiles(fromCompose);
}

/** Do the doc helpers (Tika, the PDF browser) run? Always on the full shape:
 *  they have no profile there. On a core box only with the `helpers` profile
 *  (or `full`, which a core is not meant to use). */
export function helpersRun(): boolean {
  if (!coreShape()) return true;
  const profiles = activeProfiles() ?? [];
  return profiles.includes('helpers') || profiles.includes('full');
}

/** Can Settings > Services switch this service on THIS box? The helpers only
 *  on a core box without the `full` profile: anywhere else nothing would
 *  stop them, so the screen does not offer the row. */
export function serviceSwitchable(name: OptionalService): boolean {
  if (name !== 'helpers') return true;
  return coreShape() && !(activeProfiles() ?? []).includes('full');
}

/** Tools that need an optional service, by slug. The sandbox verbs share one
 *  prefix (pinned by a test against the sandbox tool list). */
export function toolService(slug: string): OptionalService | null {
  if (slug.startsWith('sandbox_')) return 'sandboxes';
  if (slug === 'video_ingest') return 'media';
  return null;
}

/** False when the tool needs a service that is off on this box: the agent's
 *  tool list leaves it out, so a model never plans around a tool that can
 *  only refuse. */
export function toolServiceAvailable(slug: string): boolean {
  const svc = toolService(slug);
  return svc === null || serviceEnabled(svc);
}
