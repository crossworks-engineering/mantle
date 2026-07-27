/**
 * sandboxd — the CLI-sandboxes supervisor. The ONLY process that talks to the
 * Docker socket on behalf of the app; holding the socket is root-equivalent,
 * so this service is a security boundary and stays deliberately narrow:
 *
 *   - a FIXED verb set (create / start / exec / stop / rm / list / healthz) —
 *     no raw Docker passthrough, ever (the updater's "don't become a general
 *     remote executor" lesson, applied by construction);
 *   - it only touches containers it created, selected by the
 *     `mantle.sandbox=true` label — never by caller-supplied container id;
 *   - the container spec is templated HERE: callers pick name/image/network
 *     tier, never mounts, caps, or devices;
 *   - every request must carry the shared bearer token (SANDBOXD_TOKEN).
 *
 * Sandboxes are hardened-runc Ubuntu containers on the isolated
 * `mantle_sandbox` network (egress only — no route to postgres/minio/web).
 * Each owns `${SANDBOXES_DIR}/<id>/files`, bind-mounted at /files (default
 * cwd): the container is disposable, /files survives rm unless purged.
 * Containers run as root (apt must work); /files may therefore be root-owned
 * on the host — copy with sudo, or via the M2 export tool.
 *
 * Compose runs this from the standard server image behind the `sandboxes`
 * profile: a box that hasn't opted in simply doesn't have the feature.
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import * as docker from './docker';

const PORT = Number(process.env.SANDBOXD_PORT || 8090);
const TOKEN = process.env.SANDBOXD_TOKEN || '';
const SANDBOXES_DIR = process.env.SANDBOXES_DIR || '/data/sandboxes';
const SANDBOX_NETWORK = process.env.SANDBOX_NETWORK || 'mantle_sandbox';
const DEFAULT_IMAGE = process.env.SANDBOX_DEFAULT_IMAGE || 'ubuntu:24.04';
const MAX_SANDBOXES = Number(process.env.SANDBOX_MAX_COUNT || 3);
const MEM_BYTES = Number(process.env.SANDBOX_MEM_BYTES || 1024 * 1024 * 1024);
const NANO_CPUS = Number(process.env.SANDBOX_NANO_CPUS || 1e9); // 1 CPU
const PIDS_LIMIT = Number(process.env.SANDBOX_PIDS_LIMIT || 512);
const MAX_TIMEOUT_S = 1800;
const RAW_CAPTURE_CAP = 16 * 1024 * 1024;

const LABEL = 'mantle.sandbox';
const label = (id: string) => `${LABEL}.id=${id}`;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]*(:[a-zA-Z0-9._-]+)?$/;

if (!TOKEN) {
  console.error('[sandboxd] SANDBOXD_TOKEN is required — refusing to start without auth');
  process.exit(1);
}

/* ── helpers ──────────────────────────────────────────────────────────── */

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const filesDir = (id: string) => path.join(SANDBOXES_DIR, id, 'files');

function authed(req: http.IncomingMessage): boolean {
  const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1024 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

async function findContainer(id: string): Promise<docker.ContainerSummary> {
  const rows = await docker.listContainers([`${LABEL}=true`, label(id)]);
  if (!rows.length) throw new HttpError(404, `no container for sandbox ${id}`);
  return rows[0]!;
}

async function ensureImage(image: string): Promise<void> {
  // Create-then-pull-on-404 would need a throwaway create; probing the pull
  // path directly is simpler and a no-op when the image is already local.
  await docker.pullImage(image);
}

/* ── verbs ────────────────────────────────────────────────────────────── */

type CreateInput = { id: string; ownerId: string; image?: string; network?: 'full' | 'none' };

async function createSandbox(input: CreateInput) {
  const { id, ownerId } = input;
  if (!ID_RE.test(id)) throw new HttpError(400, 'id must be a uuid');
  if (typeof ownerId !== 'string' || !ownerId) throw new HttpError(400, 'ownerId is required');
  const image = input.image ?? DEFAULT_IMAGE;
  if (!IMAGE_RE.test(image)) throw new HttpError(400, `image '${image}' is not a valid reference`);
  const network = input.network === 'none' ? 'none' : 'full';

  const existing = await docker.listContainers([`${LABEL}=true`]);
  if (existing.length >= MAX_SANDBOXES) {
    throw new HttpError(
      409,
      `sandbox limit reached (${MAX_SANDBOXES}) — remove one with sandbox_rm (or stop+rm via the UI) before creating another`,
    );
  }

  await mkdir(filesDir(id), { recursive: true });
  await ensureImage(image);

  const { Id: containerId } = await docker.createContainer(`mantle-sbx-${id.slice(0, 12)}`, {
    Image: image,
    Cmd: ['sleep', 'infinity'],
    WorkingDir: '/files',
    Env: ['DEBIAN_FRONTEND=noninteractive', 'LANG=C.UTF-8', 'HOME=/root'],
    Labels: { [LABEL]: 'true', [`${LABEL}.id`]: id, [`${LABEL}.owner`]: ownerId },
    HostConfig: {
      // The work outlives the container: /files is the sandbox's host dir.
      Binds: [`${filesDir(id)}:/files:rw`],
      // Hardening + guardrails. Caps: minimal set apt/dpkg need as root.
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'KILL', 'SETPCAP'],
      SecurityOpt: ['no-new-privileges'],
      Memory: MEM_BYTES,
      NanoCpus: NANO_CPUS,
      PidsLimit: PIDS_LIMIT,
      Init: true, // reap zombies under the sleep-infinity PID 1
      NetworkMode: network === 'none' ? 'none' : SANDBOX_NETWORK,
      RestartPolicy: { Name: 'no' },
    },
  });
  await docker.startContainer(containerId);
  return { containerId, image, network };
}

async function execSandbox(id: string, body: Record<string, unknown>) {
  const command = typeof body.command === 'string' ? body.command : '';
  if (!command.trim()) throw new HttpError(400, 'command is required');
  const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd : '/files';
  const timeoutS = Math.min(
    MAX_TIMEOUT_S,
    Math.max(1, typeof body.timeoutSeconds === 'number' ? body.timeoutSeconds : 120),
  );

  const c = await findContainer(id);
  if (c.State !== 'running') await docker.startContainer(c.Id);

  const started = Date.now();
  // coreutils `timeout` enforces the limit IN the container (exit 124);
  // the transport backstop severs a wedged stream a bit later.
  const result = await docker.execInContainer(
    c.Id,
    ['timeout', '--signal=TERM', '--kill-after=10', `${timeoutS}s`, '/bin/bash', '-lc', command],
    { workingDir: cwd, hardTimeoutMs: (timeoutS + 20) * 1000, maxBytes: RAW_CAPTURE_CAP },
  );
  return {
    exitCode: result.exitCode === 124 ? null : result.exitCode,
    timedOut: result.exitCode === 124,
    durationMs: Date.now() - started,
    cwd,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
}

async function listSandboxes() {
  const rows = await docker.listContainers([`${LABEL}=true`]);
  return rows.map((c) => ({
    id: c.Labels[`${LABEL}.id`],
    ownerId: c.Labels[`${LABEL}.owner`],
    containerId: c.Id,
    state: c.State,
    status: c.Status,
  }));
}

async function rmSandbox(id: string, purge: boolean) {
  try {
    const c = await findContainer(id);
    await docker.removeContainer(c.Id);
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) throw e; // already gone: fine
  }
  if (purge) await rm(path.join(SANDBOXES_DIR, id), { recursive: true, force: true });
  return { filesPreserved: !purge, filesDir: purge ? null : filesDir(id) };
}

/* ── server ───────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  };

  try {
    const url = new URL(req.url ?? '/', 'http://sandboxd');
    const seg = url.pathname.split('/').filter(Boolean); // e.g. ['sandboxes', ':id', 'exec']

    if (req.method === 'GET' && url.pathname === '/healthz') {
      const dockerOk = await docker.ping().catch(() => false);
      return send(dockerOk ? 200 : 503, { ok: dockerOk, docker: dockerOk });
    }

    if (!authed(req)) return send(401, { error: 'missing or invalid bearer token' });

    if (req.method === 'GET' && url.pathname === '/sandboxes') {
      return send(200, { sandboxes: await listSandboxes() });
    }
    if (req.method === 'POST' && url.pathname === '/sandboxes') {
      const body = await readBody(req);
      return send(201, await createSandbox(body as CreateInput));
    }
    if (seg[0] === 'sandboxes' && seg[1] && ID_RE.test(seg[1])) {
      const id = seg[1];
      if (req.method === 'POST' && seg[2] === 'exec') {
        return send(200, await execSandbox(id, await readBody(req)));
      }
      if (req.method === 'POST' && seg[2] === 'start') {
        const c = await findContainer(id);
        if (c.State !== 'running') await docker.startContainer(c.Id);
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && seg[2] === 'stop') {
        const c = await findContainer(id);
        if (c.State === 'running') await docker.stopContainer(c.Id);
        return send(200, { ok: true });
      }
      if (req.method === 'DELETE' && !seg[2]) {
        return send(200, await rmSandbox(id, url.searchParams.get('purge') === '1'));
      }
    }
    return send(404, { error: `no such route: ${req.method} ${url.pathname}` });
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message });
    if (e instanceof docker.DockerError) return send(502, { error: `docker: ${e.message}` });
    console.error('[sandboxd] unhandled', e);
    return send(500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(
    `[sandboxd] listening on :${PORT} — dir=${SANDBOXES_DIR} network=${SANDBOX_NETWORK} max=${MAX_SANDBOXES}`,
  );
});
