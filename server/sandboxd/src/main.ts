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
 * Containers run as root (apt must work), so work in /files is root-written —
 * before stop and rm, sandboxd chowns /files to uid 1000 FROM INSIDE the
 * container (root in there regardless of who runs sandboxd), so preserved
 * work is always owner-accessible on the host and purge never needs host
 * root. Best-effort: a wedged container still gets removed.
 *
 * Compose runs this from the standard server image behind the `sandboxes`
 * profile: a box that hasn't opted in simply doesn't have the feature.
 */

import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { chown, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as docker from './docker';
import * as mcp from './mcp';
import { startEgressProxy } from './egress';
import { resolveImportPath } from './paths';

const execFileP = promisify(execFile);

const PORT = Number(process.env.SANDBOXD_PORT || 8090);
const TOKEN = process.env.SANDBOXD_TOKEN || '';
const SANDBOXES_DIR = process.env.SANDBOXES_DIR || '/data/sandboxes';
/**
 * HOST-absolute path of the brain's Files root, for the read-only inbox mount.
 * Host-absolute for the same reason SANDBOXES_DIR is: sandboxd hands bind
 * SOURCES to the host daemon, which resolves them on the host, not in here. The
 * same path is mounted read-only into sandboxd at the identical location so the
 * subpath can be validated before it is handed over. Unset (the default) turns
 * the feature off, and `sandbox_create` says so rather than guessing.
 */
const INBOX_ROOT = process.env.SANDBOX_INBOX_ROOT || '';
const SANDBOX_NETWORK = process.env.SANDBOX_NETWORK || 'mantle_sandbox';
/** INTERNAL network for balanced-tier sandboxes: no NAT, so their only way
 *  out is the allowlisting egress proxy below. */
const RESTRICTED_NETWORK = process.env.SANDBOX_NETWORK_RESTRICTED || 'mantle_sandbox_restricted';
const EGRESS_PROXY_PORT = Number(process.env.SANDBOX_EGRESS_PROXY_PORT || 8092);
/** How balanced sandboxes address the proxy: the sandboxd container name in
 *  prod (docker DNS on the shared network); an explicit IP on local rigs. */
const EGRESS_PROXY_HOST = process.env.SANDBOX_EGRESS_PROXY_HOST || 'mantle_sandboxd';
/** Batteries-included default (python3+libs, node22+pnpm, git, docker CLI,
 *  claude code — see infra/sandbox-image/Dockerfile). Pinned tag: updating
 *  the image is an explicit SANDBOX_DEFAULT_IMAGE change, never silent drift. */
const DEFAULT_IMAGE = process.env.SANDBOX_DEFAULT_IMAGE || 'titanwest/mantle-sandbox:24.04-v2';
const MAX_SANDBOXES = Number(process.env.SANDBOX_MAX_COUNT || 3);
const MEM_BYTES = Number(process.env.SANDBOX_MEM_BYTES || 1024 * 1024 * 1024);
const NANO_CPUS = Number(process.env.SANDBOX_NANO_CPUS || 1e9); // 1 CPU
const PIDS_LIMIT = Number(process.env.SANDBOX_PIDS_LIMIT || 512);
const MAX_TIMEOUT_S = 1800;
const RAW_CAPTURE_CAP = 16 * 1024 * 1024;
/** Stop a sandbox nobody has exec'd into for this long (0 disables). Hygiene,
 *  not policy: /files and installed packages survive; the next exec restarts. */
const IDLE_STOP_MINUTES = Number(process.env.SANDBOX_IDLE_STOP_MINUTES || 60);
/** Refuse new sandboxes when the sandboxes dir exceeds this (existing ones
 *  keep working — the budget guards the box, it never deletes work). */
const DISK_BUDGET_BYTES = Number(process.env.SANDBOX_DISK_BUDGET_BYTES || 10 * 1024 ** 3);
const EXPORT_MAX_BYTES = Number(process.env.SANDBOX_EXPORT_MAX_BYTES || 100 * 1024 * 1024);
const IMPORT_MAX_BYTES = Number(process.env.SANDBOX_IMPORT_MAX_BYTES || 100 * 1024 * 1024);

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

/**
 * Raw body for the ONE route whose payload is a file, not a document.
 * `readBody` caps at 1 MB and parses JSON; an import is megabytes of binary,
 * and base64 inside JSON would inflate it by a third and hold two copies. So
 * the bytes ride the body as-is and the metadata rides the query string.
 */
async function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) {
      throw new HttpError(
        413,
        `body is over the ${Math.round(maxBytes / 1024 ** 2)} MB import cap — split the file, or raise SANDBOX_IMPORT_MAX_BYTES on the box`,
      );
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function findContainer(id: string): Promise<docker.ContainerSummary> {
  const rows = await docker.listContainers([`${LABEL}=true`, label(id)]);
  if (!rows.length) throw new HttpError(404, `no container for sandbox ${id}`);
  return rows[0]!;
}

/** In-memory last-activity per sandbox id, feeding the idle-stop sweep.
 *  Deliberately not persisted: after a sandboxd restart every running sandbox
 *  is seeded "active now", so the worst case is one extra idle period — never
 *  a premature stop. */
const lastActivity = new Map<string, number>();
const markActive = (id: string) => lastActivity.set(id, Date.now());

async function usedBytes(): Promise<number> {
  const { stdout } = await execFileP('du', ['-sb', SANDBOXES_DIR]);
  return Number(stdout.split('\t')[0]) || 0;
}

/** Hand /files back to uid 1000 so the host-side owner can read/copy/delete
 *  it without root. Runs INSIDE the container (root there even when sandboxd
 *  isn't). Best-effort: callers proceed on failure — losing the chown must
 *  never block a stop or removal. */
async function chownFiles(containerId: string): Promise<void> {
  try {
    await docker.execInContainer(containerId, ['chown', '-R', '1000:1000', '/files'], {
      workingDir: '/',
      hardTimeoutMs: 120_000,
      maxBytes: 4096,
    });
  } catch (e) {
    console.warn('[sandboxd] chown /files failed (continuing):', (e as Error).message);
  }
}

/** Name of the wake script inside /files. One convention, no registry. */
const WAKE_SCRIPT = '.sandbox-wake';

/**
 * Start the container if it is down, then re-run the sandbox's wake script.
 *
 * The idle-stop keeps /files and the installed packages but not the RUNNING
 * PROCESSES, so a sandbox that serves something came back deaf: the next exec
 * woke the container and the service was simply gone, and a person had to know
 * to re-run the start script by hand. That is a poor deal for the specialists
 * this is built for, who do not think in terms of containers at all.
 *
 * The command lives IN the sandbox as `/files/.sandbox-wake`, not in a registry
 * here: sandboxd holds no database, and a convention file survives a sandboxd
 * restart, moves with an export, and is visible to anyone looking at /files.
 * It is expected to be idempotent (running it while the service is already up
 * should be a no-op that says so) because it runs on EVERY wake.
 *
 * Fire and forget: the script is backgrounded with its output appended to
 * `.sandbox-wake.log`, and a failure is logged, never raised. A wake hook that
 * can fail a caller's exec would be worse than no hook at all.
 */
async function ensureRunning(c: docker.ContainerSummary, id: string): Promise<void> {
  if (c.State === 'running') return;
  await docker.startContainer(c.Id);
  try {
    await stat(path.join(filesDir(id), WAKE_SCRIPT));
  } catch {
    return; // no hook for this sandbox
  }
  try {
    await docker.execInContainer(
      c.Id,
      [
        'sh',
        '-lc',
        `nohup sh /files/${WAKE_SCRIPT} >>/files/${WAKE_SCRIPT}.log 2>&1 & echo started`,
      ],
      { workingDir: '/files', hardTimeoutMs: 15_000, maxBytes: 4096 },
    );
  } catch (e) {
    console.warn(`[sandboxd] wake script failed for ${id} (continuing):`, (e as Error).message);
  }
}

/** Write (or clear) a sandbox's wake script. */
async function setWakeScript(id: string, command: string): Promise<{ wake: string | null }> {
  await findContainer(id);
  const dest = path.join(filesDir(id), WAKE_SCRIPT);
  if (!command.trim()) {
    await unlink(dest).catch(() => {});
    return { wake: null };
  }
  await mkdir(filesDir(id), { recursive: true });
  await writeFile(dest, `#!/bin/sh\n${command}\n`, { mode: 0o755 });
  await chown(dest, 1000, 1000).catch(() => {});
  return { wake: `/files/${WAKE_SCRIPT}` };
}

async function ensureImage(image: string): Promise<void> {
  // Create-then-pull-on-404 would need a throwaway create; probing the pull
  // path directly is simpler and a no-op when the image is already local.
  await docker.pullImage(image);
}

/* ── published services ───────────────────────────────────────────────── */

/** Ports explicitly published per sandbox, persisted beside (not inside) the
 *  /files workspace at `<SANDBOXES_DIR>/<id>/services.json` so they survive a
 *  sandboxd restart and die with a purge. The proxy serves ONLY these ports —
 *  publish is the declaration step, not a firewall (the sandbox network
 *  already isolates); it keeps "what the brain can call" an explicit, small,
 *  listable set instead of every port every container happens to open. */
const servicesPath = (id: string) => path.join(SANDBOXES_DIR, id, 'services.json');

async function loadServices(id: string): Promise<number[]> {
  try {
    const parsed = JSON.parse(await readFile(servicesPath(id), 'utf8')) as { ports?: unknown };
    return Array.isArray(parsed.ports) ? parsed.ports.filter((p) => Number.isInteger(p)) : [];
  } catch {
    return [];
  }
}

async function saveServices(id: string, ports: number[]): Promise<void> {
  await writeFile(servicesPath(id), JSON.stringify({ ports }), 'utf8');
}

async function publishService(id: string, body: Record<string, unknown>) {
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, 'port must be an integer 1–65535');
  }
  const c = await findContainer(id);
  await ensureRunning(c, id);
  markActive(id);
  const ip = await docker.containerIp(c.Id, SANDBOX_NETWORK);
  if (!ip) throw new HttpError(502, 'sandbox container has no network address');

  // The service must actually answer before we declare it callable.
  const reachable = await new Promise<boolean>((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.once('connect', () => (sock.destroy(), resolve(true)));
    sock.once('timeout', () => (sock.destroy(), resolve(false)));
    sock.once('error', () => resolve(false));
    sock.connect(port, ip);
  });
  if (!reachable) {
    throw new HttpError(
      409,
      `nothing is listening on port ${port} inside the sandbox — start the service first (bind 0.0.0.0, run it in the background with nohup … &), verify with sandbox_exec, then re-publish`,
    );
  }

  const ports = await loadServices(id);
  if (!ports.includes(port)) await saveServices(id, [...ports, port]);
  return { port, proxyPath: `/svc/${id}/${port}` };
}

/** Stream-proxy an authored-tool request to a published sandbox service.
 *  Data plane only: bearer-gated, published ports only, Authorization and
 *  Host are stripped so the sandboxd token never enters the sandbox. */
async function proxyToService(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  port: number,
  rest: string,
): Promise<void> {
  if (!(await loadServices(id)).includes(port)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `port ${port} is not published for this sandbox` }));
    return;
  }
  const c = await findContainer(id);
  await ensureRunning(c, id);
  markActive(id);
  const ip = await docker.containerIp(c.Id, SANDBOX_NETWORK);
  if (!ip) throw new HttpError(502, 'sandbox container has no network address');

  const headers = { ...req.headers };
  delete headers.authorization;
  delete headers.host;
  await new Promise<void>((resolve) => {
    const upstream = http.request(
      { host: ip, port, method: req.method, path: rest || '/', headers, timeout: 60_000 },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        up.on('end', resolve);
        up.on('error', () => (res.end(), resolve()));
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `sandbox service unreachable: ${e.message}` }));
      } else {
        res.end();
      }
      resolve();
    });
    req.pipe(upstream);
  });
}

/* ── verbs ────────────────────────────────────────────────────────────── */

type CreateInput = {
  id: string;
  ownerId: string;
  image?: string;
  network?: 'full' | 'balanced' | 'none';
  /** Folder under the Files root to expose read-only at /mnt/inbox. */
  inbox?: string;
};

async function createSandbox(input: CreateInput) {
  const { id, ownerId } = input;
  if (!ID_RE.test(id)) throw new HttpError(400, 'id must be a uuid');
  if (typeof ownerId !== 'string' || !ownerId) throw new HttpError(400, 'ownerId is required');
  const image = input.image ?? DEFAULT_IMAGE;
  if (!IMAGE_RE.test(image)) throw new HttpError(400, `image '${image}' is not a valid reference`);
  const network =
    input.network === 'none' ? 'none' : input.network === 'balanced' ? 'balanced' : 'full';

  const existing = await docker.listContainers([`${LABEL}=true`]);
  if (existing.length >= MAX_SANDBOXES) {
    throw new HttpError(
      409,
      `sandbox limit reached (${MAX_SANDBOXES}) — remove one with sandbox_rm (or stop+rm via the UI) before creating another`,
    );
  }
  const used = await usedBytes().catch(() => 0);
  if (used > DISK_BUDGET_BYTES) {
    throw new HttpError(
      409,
      `sandbox disk budget exceeded (${Math.round(used / 1024 ** 2)} MB used of ${Math.round(DISK_BUDGET_BYTES / 1024 ** 2)} MB) — export what matters with sandbox_export, then sandbox_rm with purge_files, before creating another`,
    );
  }

  const inboxBind = await resolveInboxBind(input.inbox);

  await mkdir(filesDir(id), { recursive: true });
  await ensureImage(image);

  const { Id: containerId } = await docker.createContainer(`mantle-sbx-${id.slice(0, 12)}`, {
    Image: image,
    Cmd: ['sleep', 'infinity'],
    WorkingDir: '/files',
    Env: [
      'DEBIAN_FRONTEND=noninteractive',
      'LANG=C.UTF-8',
      'HOME=/root',
      // Balanced tier: the internal network has no NAT — proxy env is the
      // only road out, and the proxy enforces the allowlist.
      ...(network === 'balanced'
        ? ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].map(
            (k) => `${k}=http://${EGRESS_PROXY_HOST}:${EGRESS_PROXY_PORT}`,
          )
        : []),
    ],
    Labels: { [LABEL]: 'true', [`${LABEL}.id`]: id, [`${LABEL}.owner`]: ownerId },
    HostConfig: {
      // The work outlives the container: /files is the sandbox's host dir.
      Binds: inboxBind ? [`${filesDir(id)}:/files:rw`, inboxBind] : [`${filesDir(id)}:/files:rw`],
      // Hardening + guardrails. Caps: minimal set apt/dpkg need as root.
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'KILL', 'SETPCAP'],
      SecurityOpt: ['no-new-privileges'],
      Memory: MEM_BYTES,
      NanoCpus: NANO_CPUS,
      PidsLimit: PIDS_LIMIT,
      Init: true, // reap zombies under the sleep-infinity PID 1
      NetworkMode:
        network === 'none' ? 'none' : network === 'balanced' ? RESTRICTED_NETWORK : SANDBOX_NETWORK,
      RestartPolicy: { Name: 'no' },
    },
  });
  await docker.startContainer(containerId);
  markActive(id);
  return { containerId, image, network, inbox: inboxBind ? '/mnt/inbox' : null };
}

/**
 * Tar a path under /files (inside the container, so no host perms involved),
 * read the archive back host-side, and return its bytes. The temp archive
 * lands in /files and is unlinked afterwards; sandboxd owns the dir, so the
 * unlink works even though tar wrote it as root.
 */
async function exportSandbox(id: string, body: Record<string, unknown>): Promise<Buffer> {
  const rel = typeof body.path === 'string' ? body.path.replace(/^\/?files\/?/, '').trim() : '';
  const relPath = rel || '.';
  if (relPath.split('/').some((s) => s === '..')) {
    throw new HttpError(400, 'path must stay under /files (no ..)');
  }
  const c = await findContainer(id);
  await ensureRunning(c, id);
  markActive(id);

  const tmpName = `.sbx-export-${Date.now()}.tgz`;
  const r = await docker.execInContainer(
    c.Id,
    ['tar', '-czf', `/files/${tmpName}`, '-C', '/files', '--exclude', tmpName, relPath],
    { workingDir: '/files', hardTimeoutMs: 300_000, maxBytes: 64 * 1024 },
  );
  const hostTmp = path.join(filesDir(id), tmpName);
  try {
    if (r.exitCode !== 0) {
      throw new HttpError(
        400,
        `tar failed (exit ${r.exitCode}): ${r.stderr.toString('utf8').trim().slice(0, 300) || 'path not found?'} — list contents with sandbox_exec (ls) and re-issue with an existing path`,
      );
    }
    const size = (await stat(hostTmp)).size;
    if (size > EXPORT_MAX_BYTES) {
      throw new HttpError(
        413,
        `export is ${Math.round(size / 1024 ** 2)} MB, over the ${Math.round(EXPORT_MAX_BYTES / 1024 ** 2)} MB cap — export a narrower path (a subdirectory or specific files)`,
      );
    }
    return await readFile(hostTmp);
  } finally {
    await unlink(hostTmp).catch(() => {});
  }
}

/**
 * Import: the mirror of `exportSandbox`, and the reason a sandbox stops being
 * write-only. Work could always come OUT (export tars a path into the Files
 * workspace) but nothing could go IN, so any job that STARTS from a file — a
 * database, a spreadsheet, a drawing set — needed someone with shell access on
 * the box. That is exactly the person a specialist using Mantle does not have.
 *
 * No container round-trip: sandboxd already bind-mounts the sandbox's host dir
 * at the same path it hands the daemon, so the write is an ordinary host write
 * into `filesDir(id)`. That keeps binaries byte-exact (a base64 hop through
 * `sandbox_exec` would be ~1.4x the bytes across dozens of calls, and would
 * corrupt a Jet/ACE database silently rather than loudly) and works whether or
 * not the container is running.
 *
 * The file is chowned to uid 1000 to match what stop/rm hand back, so the
 * sandbox user can read it without a root step of its own.
 */
/**
 * Resolve the read-only inbox bind for a create, or null when none was asked
 * for. Throws when one was asked for and cannot be honoured, because silently
 * creating a sandbox WITHOUT the folder it was supposed to read is the failure
 * mode that wastes an afternoon: every later step looks fine and /mnt/inbox is
 * simply empty.
 */
async function resolveInboxBind(sub: string | undefined): Promise<string | null> {
  const rel = (sub ?? '').trim().replace(/^\/+/, '');
  if (!rel) return null;
  if (!INBOX_ROOT) {
    throw new HttpError(
      400,
      'inbox mounts are not configured on this box — set MANTLE_FILES_HOST_DIR (host-absolute) in the .env and restart, see docs/sandboxes.md',
    );
  }
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new HttpError(400, 'inbox must be a folder under the Files root (no ..)');
  }
  const root = path.resolve(INBOX_ROOT);
  const dir = path.resolve(path.join(root, rel));
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new HttpError(400, 'inbox must be a folder under the Files root');
  }
  let st;
  try {
    st = await stat(dir);
  } catch {
    throw new HttpError(404, `inbox folder not found on the box: ${rel}`);
  }
  if (!st.isDirectory()) throw new HttpError(400, `inbox must be a folder, not a file: ${rel}`);
  // `ro` is the whole trust argument: the sandbox reads the owner's chosen
  // folder and can write nothing back into the brain's file store.
  return `${dir}:/mnt/inbox:ro`;
}

async function importSandbox(
  id: string,
  relPathRaw: string,
  bytes: Buffer,
): Promise<{ path: string; sizeBytes: number }> {
  // Containment lives in paths.ts so it can be tested without the daemon.
  let rel: string;
  let dest: string;
  try {
    ({ rel, dest } = resolveImportPath(filesDir(id), relPathRaw));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }

  const used = await usedBytes().catch(() => 0);
  if (used + bytes.length > DISK_BUDGET_BYTES) {
    throw new HttpError(
      409,
      `importing ${Math.round(bytes.length / 1024 ** 2)} MB would pass the sandbox disk budget (${Math.round(used / 1024 ** 2)} MB used of ${Math.round(DISK_BUDGET_BYTES / 1024 ** 2)} MB) — free space with sandbox_rm and purge_files, or raise SANDBOX_DISK_BUDGET_BYTES`,
    );
  }

  // The sandbox need not be running: /files is a host directory, so an import
  // into a stopped (idle-stopped) sandbox lands correctly and is there when the
  // next exec wakes it. Confirm the sandbox EXISTS, though — writing into the
  // dir of a removed sandbox would silently recreate it.
  await findContainer(id);

  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  await chown(dest, 1000, 1000).catch(() => {
    // Non-fatal: on a box where sandboxd is not root the file is still there
    // and readable; only the owner differs.
  });
  markActive(id);
  return { path: `/files/${rel}`, sizeBytes: bytes.length };
}

/**
 * Fetch ONE file out of a sandbox as itself, not as an archive.
 *
 * `exportSandbox` tars, which is right for a tree and wrong for the commonest
 * case: a specialist asks for the report and gets `report.tgz`, which on a
 * locked-down laptop they may not be able to open at all. Same host-side read
 * as the import, same containment check, so a single artifact comes back with
 * its own name and type. Directories still go through the tar path.
 */
async function fetchSandboxFile(id: string, relPathRaw: string): Promise<Buffer> {
  let dest: string;
  try {
    ({ dest } = resolveImportPath(filesDir(id), relPathRaw));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  await findContainer(id);
  let st;
  try {
    st = await stat(dest);
  } catch {
    throw new HttpError(
      404,
      `no such file: ${relPathRaw} — list what is there with sandbox_exec (ls) and re-issue`,
    );
  }
  if (st.isDirectory()) {
    throw new HttpError(400, `${relPathRaw} is a directory — omit raw to export it as a .tgz`);
  }
  if (st.size > EXPORT_MAX_BYTES) {
    throw new HttpError(
      413,
      `file is ${Math.round(st.size / 1024 ** 2)} MB, over the ${Math.round(EXPORT_MAX_BYTES / 1024 ** 2)} MB cap`,
    );
  }
  markActive(id);
  return await readFile(dest);
}

/**
 * Structured listing of a path under /files, read host-side.
 *
 * Without this the only way to see what is in a sandbox is `sandbox_exec ls`,
 * whose output a model then has to parse — and `ls` output varies with flags,
 * locale and terminal width, so the parse is a guess that usually works. This
 * is the call an agent makes constantly, so it should return data. It also
 * works while the sandbox is STOPPED, where an exec would first have to wake
 * the container just to answer "what is in here".
 */
async function listSandboxFiles(
  id: string,
  relRaw: string,
): Promise<{ path: string; entries: unknown[]; truncated: boolean }> {
  const rel = relRaw.replace(/^\/?files\/?/, '').trim();
  if (rel.startsWith('/') || rel.split('/').some((seg) => seg === '..')) {
    throw new HttpError(400, 'path must stay under /files (no leading / and no ..)');
  }
  const root = path.resolve(filesDir(id));
  const dir = rel ? path.resolve(path.join(root, rel)) : root;
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new HttpError(400, 'path must stay under /files');
  }
  await findContainer(id);

  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new HttpError(400, `${relRaw} is a file, not a directory`);
    }
    throw new HttpError(404, `no such directory: ${relRaw || '/files'}`);
  }

  const MAX = 500;
  const sorted = dirents.sort((a, b) => a.name.localeCompare(b.name));
  const entries = [];
  for (const d of sorted.slice(0, MAX)) {
    const full = path.join(dir, d.name);
    let size: number | null = null;
    let modified: string | null = null;
    try {
      const st = await stat(full);
      size = d.isDirectory() ? null : st.size;
      modified = st.mtime.toISOString();
    } catch {
      // A dangling symlink or a file removed mid-listing: report the name we
      // saw rather than failing the whole listing over one entry.
    }
    entries.push({
      name: d.name,
      type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
      sizeBytes: size,
      modified,
    });
  }
  return {
    path: `/files${rel ? `/${rel}` : ''}`,
    entries,
    truncated: sorted.length > MAX,
  };
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
  await ensureRunning(c, id);
  markActive(id);

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
  mcp.dropSession(id);
  try {
    const c = await findContainer(id);
    try {
      // Raw start, NOT ensureRunning: this wakes the container only to hand
      // /files back before removal. Running the wake script here would start a
      // service inside a sandbox that is being deleted.
      if (c.State !== 'running') await docker.startContainer(c.Id);
      await chownFiles(c.Id);
    } catch (e) {
      // A container too broken to start still gets removed; the files then
      // stay owned as-written (purge may need manual cleanup — reported).
      console.warn('[sandboxd] pre-rm chown skipped:', (e as Error).message);
    }
    await docker.removeContainer(c.Id);
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) throw e; // already gone: fine
  }
  if (purge) {
    try {
      await rm(path.join(SANDBOXES_DIR, id), { recursive: true, force: true });
    } catch (e) {
      throw new HttpError(
        500,
        `container removed but purging files failed (${(e as Error).message}) — delete ${path.join(SANDBOXES_DIR, id)} manually`,
      );
    }
  }
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

    // Data plane: /svc/:id/:port/* — stream-proxy to a published service.
    if (seg[0] === 'svc' && seg[1] && ID_RE.test(seg[1]) && seg[2] && /^\d+$/.test(seg[2])) {
      const rest = `/${seg.slice(3).join('/')}${url.search}`;
      return void (await proxyToService(req, res, seg[1], Number(seg[2]), rest));
    }

    if (req.method === 'GET' && url.pathname === '/sandboxes') {
      const [sandboxes, used] = await Promise.all([listSandboxes(), usedBytes().catch(() => null)]);
      return send(200, {
        sandboxes,
        disk: { usedBytes: used, budgetBytes: DISK_BUDGET_BYTES },
      });
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
        await ensureRunning(c, id);
        markActive(id);
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && seg[2] === 'publish') {
        return send(200, await publishService(id, await readBody(req)));
      }
      // MCP bridge: forward tools/list + tools/call to the sandbox's
      // persistent `claude mcp serve` session (spawned on first use).
      if (req.method === 'POST' && seg[2] === 'mcp') {
        const body = await readBody(req);
        const method = typeof body.method === 'string' ? body.method : '';
        if (!mcp.isAllowedMethod(method)) {
          return send(400, {
            error: `mcp method '${method}' is not bridged — only tools/list and tools/call are`,
          });
        }
        const c = await findContainer(id);
        await ensureRunning(c, id);
        markActive(id);
        const timeoutMs = Math.min(
          MAX_TIMEOUT_S * 1000,
          Math.max(1000, Number(body.timeoutSeconds || 120) * 1000),
        );
        const session = await mcp.ensureSession(id, c.Id);
        const result = await session
          .request(method, body.params ?? {}, timeoutMs)
          .catch((e: Error) => ({ __bridgeError: e.message }));
        if (
          result &&
          typeof result === 'object' &&
          '__bridgeError' in (result as Record<string, unknown>)
        ) {
          return send(502, { error: String((result as Record<string, unknown>).__bridgeError) });
        }
        return send(200, { result });
      }
      // Import takes the file as the RAW body (metadata rides the query
      // string), so it cannot go through `readBody`'s JSON + 1 MB path.
      if (req.method === 'GET' && seg[2] === 'ls') {
        return send(200, await listSandboxFiles(id, url.searchParams.get('path') ?? ''));
      }
      if (req.method === 'POST' && seg[2] === 'autostart') {
        const body = await readBody(req);
        return send(
          200,
          await setWakeScript(id, typeof body.command === 'string' ? body.command : ''),
        );
      }
      if (req.method === 'POST' && seg[2] === 'import') {
        const rel = url.searchParams.get('path') ?? '';
        const bytes = await readRawBody(req, IMPORT_MAX_BYTES);
        if (!bytes.length) throw new HttpError(400, 'body is empty — nothing to import');
        return send(200, await importSandbox(id, rel, bytes));
      }
      if (req.method === 'POST' && seg[2] === 'export') {
        const body = await readBody(req);
        // raw: one file, as itself. Anything else still tars.
        const bytes =
          body.raw === true
            ? await fetchSandboxFile(id, typeof body.path === 'string' ? body.path : '')
            : await exportSandbox(id, body);
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': bytes.length });
        return res.end(bytes);
      }
      if (req.method === 'POST' && seg[2] === 'stop') {
        const c = await findContainer(id);
        if (c.State === 'running') {
          mcp.dropSession(id);
          await chownFiles(c.Id); // hand /files back before the container sleeps
          await docker.stopContainer(c.Id);
        }
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

/* ── idle-stop sweep ──────────────────────────────────────────────────── */

if (IDLE_STOP_MINUTES > 0) {
  const tick = async () => {
    try {
      const running = (await docker.listContainers([`${LABEL}=true`])).filter(
        (c) => c.State === 'running',
      );
      const cutoff = Date.now() - IDLE_STOP_MINUTES * 60_000;
      for (const c of running) {
        const id = c.Labels[`${LABEL}.id`];
        if (!id) continue;
        const seen = lastActivity.get(id);
        if (seen === undefined) {
          markActive(id); // post-restart seed: grant one full idle period
        } else if (seen < cutoff) {
          console.log(`[sandboxd] idle-stopping ${id} (no activity for ${IDLE_STOP_MINUTES}m)`);
          mcp.dropSession(id);
          await chownFiles(c.Id);
          await docker.stopContainer(c.Id);
          lastActivity.delete(id);
        }
      }
    } catch (e) {
      console.warn('[sandboxd] idle sweep failed (continuing):', (e as Error).message);
    }
  };
  setInterval(tick, 5 * 60_000).unref();
}

// Ensure the sandboxes root exists from boot — `du` (disk budget/health)
// and first-create both assume it.
await mkdir(SANDBOXES_DIR, { recursive: true }).catch((e) =>
  console.warn('[sandboxd] could not create SANDBOXES_DIR:', (e as Error).message),
);

startEgressProxy(EGRESS_PROXY_PORT);
console.log(`[sandboxd] balanced-tier egress proxy on :${EGRESS_PROXY_PORT}`);

server.listen(PORT, () => {
  console.log(
    `[sandboxd] listening on :${PORT} — dir=${SANDBOXES_DIR} network=${SANDBOX_NETWORK} max=${MAX_SANDBOXES} idleStop=${IDLE_STOP_MINUTES}m budget=${Math.round(DISK_BUDGET_BYTES / 1024 ** 2)}MB`,
  );
});
