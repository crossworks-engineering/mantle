/**
 * Optional services (sandboxes, media, the local embedder and, on a core box,
 * the doc helpers) for the dashboard switches: what each one is, whether it
 * is on, and asking the updater sidecar to switch one.
 *
 * "On" is @mantle/config `serviceEnabled` (the profile, live from the
 * updater's services.json). Switching writes /signal/service-request.json,
 * which only an updater that advertises the `service` verb reads; the
 * request carries a service name and a boolean, nothing else, and the
 * updater whitelists both again (infra/updater/updater.sh). Progress comes
 * back in service-status.json and service.log.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  env,
  OPTIONAL_SERVICES,
  readServicesFile,
  serviceEnabled,
  serviceSwitchable,
  signalDir,
  type OptionalService,
} from '@mantle/config';
import { resolveEmbeddingConfig } from '@mantle/embeddings';
import { mediaSidecarHealth, tikaVersion } from '@mantle/files';
import type {
  ServiceDescription,
  ServiceInfo,
  ServiceRunPhase,
  ServiceRunStatus,
  ServicesView,
  ServiceSwitchResult,
} from '@mantle/client-types';
import { browserHealth } from './render-pdf';
import { sandboxdHealth } from './sandboxd';
import { readUpdaterStatus, updaterAvailable } from './updates';

export function isOptionalService(v: unknown): v is OptionalService {
  return typeof v === 'string' && (OPTIONAL_SERVICES as readonly string[]).includes(v);
}

/** What the UI says about each service. Sizes: the compressed images on the
 *  registry (mantle-media, mantle-sandbox base, ollama plus its model, tika
 *  plus browserless); memory: the compose caps. */
export const SERVICE_DESCRIPTIONS: Record<OptionalService, ServiceDescription> = {
  sandboxes: {
    title: 'Sandboxes',
    what: 'Isolated workspaces where the coder and app agents run code, build apps and test packages. Each sandbox is its own Linux container with no route to your data.',
    usedBy:
      'The coder agent and the sandbox tools, and services or MCP servers an agent runs inside a sandbox.',
    whenOff:
      'Agents cannot create or use sandboxes. Running sandboxes stop, and services published from a sandbox stop answering.',
    keeps:
      'Every sandbox, its files and the apps and services in it. They come back when you switch it on again.',
    downloadMb: 430,
    memory: '512 MB, plus up to 1 GB for each running sandbox (3 at a time)',
    memoryMaxMb: 3584,
    note: null,
  },
  media: {
    title: 'Media',
    what: 'Makes transcripts from video and audio, from a web link or an uploaded file, and reads and draws CAD drawings (DWF, DWG and DXF).',
    usedBy: 'The video_ingest tool, and file ingest for CAD drawings.',
    whenOff:
      'Video and audio get no transcript. DWG files are not read, and DWF files show only their small preview pictures.',
    keeps: 'Everything already ingested. Nothing is stored in this service.',
    downloadMb: 300,
    memory: 'up to 1 GB (3 GB is advised for large DWF drawing sets)',
    memoryMaxMb: 3072,
    note: 'It runs a downloader (yt-dlp) that updates itself every day and fetches pages from the open web. It holds no keys and cannot reach your data.',
  },
  'local-embedder': {
    title: 'Local embedder',
    what: 'Turns text into search vectors on this box (EmbeddingGemma), so the text you index never leaves it.',
    usedBy:
      'Search and ingest, when Settings > Embedding uses the local provider on the bundled address.',
    whenOff:
      'A brain that embeds with it cannot index new content: new files, notes and pages are not searchable until it is on again. A brain that embeds online is not affected.',
    keeps: 'The downloaded model and everything already indexed.',
    downloadMb: 3900,
    memory: 'up to 2 GB',
    memoryMaxMb: 2048,
    note: null,
    offWarning: null,
  },
  helpers: {
    title: 'Helpers',
    what: 'Two small helpers for a core box: Tika reads rare file types, and a headless browser makes PDF exports.',
    usedBy:
      'File ingest for formats the brain cannot read itself (ODT, PPTX, DOC, RTF and others), PDF export, and drawing pictures in exports.',
    whenOff:
      'PDF, Word, text and Markdown files are still read, and everything else keeps working.',
    keeps: 'Everything already ingested. The helpers store nothing.',
    downloadMb: 1200,
    memory: 'up to 3.5 GB (Tika 2 GB, the browser 1.5 GB)',
    memoryMaxMb: 3072,
    note: null,
    offWarning:
      'Rare file types (ODT, PPTX, DOC, RTF) are not read and PDF export stops until you switch it on again.',
  },
};

/** The embedder default compose gives the app: the bundled ollama service. */
const BUNDLED_EMBED_URL = 'http://ollama:11434/v1';

function bundledEmbedUrl(): string {
  return (env('MANTLE_LOCAL_EMBEDDING_URL') || BUNDLED_EMBED_URL).replace(/\/+$/, '');
}

/** Pure, for tests: does this embedding route use the BUNDLED embedder? The
 *  local provider with no base URL (or one on the bundled host) does; a local
 *  server elsewhere (LM Studio on your own machine) and any online provider
 *  do not, so switching the bundled one off costs them nothing. */
export function usesBundledEmbedder(
  route: { provider: string; baseUrl?: string | null },
  bundledUrl: string = bundledEmbedUrl(),
): boolean {
  if (route.provider !== 'local') return false;
  const base = (route.baseUrl || bundledUrl).replace(/\/+$/, '');
  try {
    return new URL(base).host === new URL(bundledUrl).host;
  } catch {
    return false;
  }
}

/** The bundled embedder answers its OpenAI-compatible model list. */
async function bundledEmbedderUp(timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await fetch(`${bundledEmbedUrl()}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The warning before the embedder goes off: only when this brain embeds with
 *  it, because only then does new content stop being searchable. */
const EMBEDDER_IN_USE_WARNING =
  'This brain embeds with the local embedder. New content is not searchable until you switch it on again.';

/** At or below this much memory a box gets the warning before a switch. */
const SMALL_BOX_BYTES = 6 * 1024 ** 3;

function file(name: string): string {
  return path.join(signalDir(), name);
}

const RUN_PHASES: readonly ServiceRunPhase[] = [
  'idle',
  'requested',
  'pulling',
  'starting',
  'stopping',
  'done',
  'error',
];
const BUSY: readonly ServiceRunPhase[] = ['requested', 'pulling', 'starting', 'stopping'];

/** Pure, for tests: a service-status.json body. */
export function parseServiceRun(raw: string): ServiceRunStatus | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const phase = RUN_PHASES.includes(j.phase as ServiceRunPhase)
      ? (j.phase as ServiceRunPhase)
      : 'idle';
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return {
      phase,
      service: isOptionalService(j.service) ? j.service : null,
      enable: typeof j.enable === 'boolean' ? j.enable : null,
      startedAt: str(j.started_at),
      finishedAt: str(j.finished_at),
      ok: typeof j.ok === 'boolean' ? j.ok : null,
      error: str(j.error),
    };
  } catch {
    return null;
  }
}

/** The current or last switch run. A request the updater has not picked up
 *  yet reads as its own phase, so the UI shows progress at once. */
export async function readServiceRun(): Promise<ServiceRunStatus | null> {
  const pendingRaw = await fs.readFile(file('service-request.json'), 'utf8').catch(() => null);
  if (pendingRaw !== null) {
    let pending: Record<string, unknown> = {};
    try {
      pending = JSON.parse(pendingRaw) as Record<string, unknown>;
    } catch {
      // half-written or foreign: still pending
    }
    return {
      phase: 'requested',
      service: isOptionalService(pending.service) ? pending.service : null,
      enable: typeof pending.enable === 'boolean' ? pending.enable : null,
      startedAt: typeof pending.requested_at === 'string' ? pending.requested_at : null,
      finishedAt: null,
      ok: null,
      error: null,
    };
  }
  const raw = await fs.readFile(file('service-status.json'), 'utf8').catch(() => null);
  return raw === null ? null : parseServiceRun(raw);
}

export async function readServiceLog(maxLines = 40): Promise<string> {
  try {
    const lines = (await fs.readFile(file('service.log'), 'utf8')).split('\n');
    return lines
      .slice(Math.max(0, lines.length - maxLines))
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

/** Is a switch run in progress? Rolls check this too: one change at a time. */
export async function serviceRunBusy(): Promise<boolean> {
  const run = await readServiceRun();
  return run !== null && BUSY.includes(run.phase);
}

/** The two services every updater with the `service` verb knows. The newer
 *  two need an updater that knows them too; it reports them in
 *  services.json, so until a roll brings that updater the row is not
 *  offered (an older updater would refuse it as an unknown service). */
const FIRST_SERVICES: readonly OptionalService[] = ['sandboxes', 'media'];

/** Is this service offered on this box? Switchable here (the helpers only
 *  on a core box), and known to the box's updater when there is one. */
export function serviceOffered(name: OptionalService): boolean {
  if (!serviceSwitchable(name)) return false;
  if (FIRST_SERVICES.includes(name)) return true;
  const f = readServicesFile();
  return !f || f.services[name] !== undefined;
}

/** Why this box cannot switch services from the UI, or null when it can. */
async function switchBlocker(): Promise<string | null> {
  if (!(await updaterAvailable())) {
    return 'This box has no updater sidecar, so services can only be changed on the server.';
  }
  const f = readServicesFile();
  if (!f || !f.verbs.includes('service')) {
    return 'The updater on this box is too old to switch services. Update the box once, then try again.';
  }
  return null;
}

/** `ownerId` reads the embedding config, for the embedder's off warning. */
export async function getServicesView(ownerId: string): Promise<ServicesView> {
  const f = readServicesFile();
  const names = OPTIONAL_SERVICES.filter(serviceOffered);
  const helpers = names.includes('helpers');
  const [blocker, run, sbx, media, embedUp, tika, browser, embedCfg] = await Promise.all([
    switchBlocker(),
    readServiceRun(),
    sandboxdHealth().catch(() => null),
    mediaSidecarHealth(1_500).catch(() => null),
    serviceEnabled('local-embedder') ? bundledEmbedderUp() : Promise.resolve(false),
    helpers ? tikaVersion(1_500).catch(() => null) : Promise.resolve(null),
    helpers ? browserHealth(1_500).catch(() => null) : Promise.resolve(null),
    resolveEmbeddingConfig(ownerId).catch(() => null),
  ]);
  const probe: Record<OptionalService, boolean | null | undefined> = {
    sandboxes: sbx?.up,
    media: media?.up,
    'local-embedder': embedUp,
    helpers: Boolean(tika) && browser?.up !== false,
  };
  const embedderInUse = embedCfg !== null && usesBundledEmbedder(embedCfg.primary);
  const services: ServiceInfo[] = names.map((name) => {
    const entry = f?.services[name];
    const on = serviceEnabled(name);
    const description =
      name === 'local-embedder' && embedderInUse
        ? { ...SERVICE_DESCRIPTIONS[name], offWarning: EMBEDDER_IN_USE_WARNING }
        : SERVICE_DESCRIPTIONS[name];
    return {
      name,
      state: !on ? 'off' : probe[name] === true ? 'up' : 'down',
      container: entry?.container ?? null,
      health: entry?.health ?? null,
      description,
    };
  });
  const kb = (v: number | null | undefined) => (typeof v === 'number' ? v * 1024 : null);
  const memTotalBytes = kb(f?.memTotalKb);
  return {
    services,
    switching: { available: blocker === null, reason: blocker },
    box: {
      memTotalBytes,
      memAvailableBytes: kb(f?.memAvailableKb),
      diskFreeBytes: kb(f?.diskFreeKb),
      core: f?.core ?? false,
      smallBox: (f?.core ?? false) || (memTotalBytes !== null && memTotalBytes <= SMALL_BOX_BYTES),
    },
    run,
  };
}

/** Ask the updater to switch one service. Refuses (with the reason) when the
 *  box cannot switch, or a roll or another switch is in progress. */
export async function requestServiceSwitch(
  name: OptionalService,
  enable: boolean,
): Promise<ServiceSwitchResult> {
  if (!isOptionalService(name)) return { ok: false, error: `unknown service '${String(name)}'` };
  if (typeof enable !== 'boolean') return { ok: false, error: 'enable must be true or false' };
  if (!serviceSwitchable(name)) {
    return {
      ok: false,
      error: 'The helpers always run on this box, so there is nothing to switch.',
    };
  }
  if (!serviceOffered(name)) {
    return {
      ok: false,
      error:
        'The updater on this box does not know this service yet. Update the box once, then try again.',
    };
  }
  const blocker = await switchBlocker();
  if (blocker) return { ok: false, error: blocker };
  const roll = await readUpdaterStatus();
  if (
    roll &&
    (roll.phase === 'requested' || roll.phase === 'pulling' || roll.phase === 'rolling')
  ) {
    return { ok: false, error: 'An update is in progress. Try again when it has finished.' };
  }
  if (await serviceRunBusy()) {
    return { ok: false, error: 'A service is already being switched. Wait for it to finish.' };
  }
  const body = JSON.stringify({ service: name, enable, requested_at: new Date().toISOString() });
  const tmp = file(`.service-request.${process.pid}.tmp`);
  try {
    // Temp + rename: the updater polls every 5 s and must never read half a
    // request (it would refuse it, but the switch would look broken).
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, file('service-request.json'));
    return { ok: true };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    console.error('[services] could not write the switch request:', err);
    return { ok: false, error: 'Could not hand the request to the updater. See the server log.' };
  }
}
