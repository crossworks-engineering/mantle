/**
 * Minimal Docker Engine API client over the unix socket — the only Docker
 * surface sandboxd uses. Deliberately no dockerode / docker CLI: node:http
 * speaks to `/var/run/docker.sock` directly, so the service adds zero
 * dependencies and the full set of calls it can make is visible on this page.
 *
 * Everything here is mechanism; POLICY (labels, caps, which containers may be
 * touched) lives in main.ts. Keep it that way — this file should never grow
 * an opinion about what a sandbox is.
 */

import http from 'node:http';

const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const API = '/v1.43';

export class DockerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function request(
  method: string,
  path: string,
  body?: unknown,
  opts?: { timeoutMs?: number },
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: SOCK,
        method,
        path: `${API}${path}`,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
        },
        timeout: opts?.timeoutMs ?? 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body);
  if (res.status >= 400) {
    let msg = res.body.toString('utf8').trim();
    try {
      msg = (JSON.parse(msg) as { message?: string }).message ?? msg;
    } catch {
      /* keep raw */
    }
    throw new DockerError(res.status, msg || `docker ${method} ${path} → ${res.status}`);
  }
  const text = res.body.toString('utf8');
  return (text ? JSON.parse(text) : undefined) as T;
}

export const ping = async (): Promise<boolean> => (await request('GET', '/_ping')).status === 200;

/** Pull an image, consuming the progress stream to completion. */
export function pullImage(image: string): Promise<void> {
  const [name, tag = 'latest'] = image.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCK,
        method: 'POST',
        path: `${API}/images/create?fromImage=${encodeURIComponent(name!)}&tag=${encodeURIComponent(tag)}`,
        // Image pulls are big; no read timeout — the stream itself is progress.
        timeout: 0,
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            reject(new DockerError(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'))),
          );
          return;
        }
        res.on('data', () => {}); // drain progress events
        res.on('end', () => resolve());
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export type ContainerSummary = {
  Id: string;
  Names: string[];
  State: string; // 'running' | 'exited' | ...
  Status: string;
  Labels: Record<string, string>;
};

export const listContainers = (labelFilters: string[]): Promise<ContainerSummary[]> =>
  json(
    'GET',
    `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: labelFilters }))}`,
  );

export const createContainer = (name: string, spec: unknown): Promise<{ Id: string }> =>
  json('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec);

export const startContainer = (id: string): Promise<void> =>
  json('POST', `/containers/${id}/start`);

export const stopContainer = (id: string): Promise<void> =>
  json('POST', `/containers/${id}/stop?t=5`);

export const removeContainer = (id: string): Promise<void> =>
  json('DELETE', `/containers/${id}?force=true`);

/** The container's IP on `preferredNetwork`, falling back to its first
 *  network with an address (local test rigs run plain `bridge`). */
export async function containerIp(id: string, preferredNetwork: string): Promise<string | null> {
  const info = await json<{
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  }>('GET', `/containers/${id}/json`);
  const nets = info.NetworkSettings?.Networks ?? {};
  const preferred = nets[preferredNetwork]?.IPAddress;
  if (preferred) return preferred;
  for (const n of Object.values(nets)) if (n.IPAddress) return n.IPAddress;
  return null;
}

/* ── interactive exec (hijacked stream) ───────────────────────────────── */

export type HijackedExec = {
  /** Raw bidirectional socket. Write = the process's stdin. Reads are
   *  multiplexed frames (same 8-byte headers as execInContainer). */
  socket: import('node:net').Socket;
  execId: string;
};

/**
 * Start a long-lived process in a container with stdin attached, returning
 * the hijacked duplex socket. Docker answers the exec/start with HTTP 101
 * and hands the TCP stream over; the caller owns framing (stdout/stderr
 * demux) and lifecycle (destroy the socket to end the session — the process
 * then sees EOF on stdin).
 */
export async function execInteractive(containerId: string, cmd: string[]): Promise<HijackedExec> {
  const { Id: execId } = await json<{ Id: string }>('POST', `/containers/${containerId}/exec`, {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: '/files',
    Cmd: cmd,
  });
  const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
    const req = http.request({
      socketPath: SOCK,
      method: 'POST',
      path: `${API}/exec/${execId}/start`,
      headers: {
        'Content-Type': 'application/json',
        Connection: 'Upgrade',
        Upgrade: 'tcp',
      },
      timeout: 0,
    });
    req.on('upgrade', (_res, sock) => resolve(sock));
    req.on('response', (res) => {
      // No upgrade means docker refused (bad exec state) — surface it.
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        reject(new DockerError(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8').trim())),
      );
    });
    req.on('error', reject);
    req.end(JSON.stringify({ Detach: false, Tty: false }));
  });
  return { socket, execId };
}

/* ── exec ─────────────────────────────────────────────────────────────── */

export type ExecResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
};

/**
 * Run a command in a container and capture demuxed stdout/stderr.
 *
 * With Tty=false the attach stream is multiplexed in 8-byte-header frames
 * ([type, 0,0,0, size:be32] + payload, type 1=stdout 2=stderr) — demuxed
 * here. `maxBytes` caps the RAW capture per stream (backpressure against
 * `cat huge.log`); display truncation is the caller's concern.
 *
 * In-container timeout is the caller's job (wrap with coreutils `timeout`);
 * `hardTimeoutMs` is the transport backstop that severs a wedged stream.
 */
export async function execInContainer(
  containerId: string,
  cmd: string[],
  opts: { workingDir: string; hardTimeoutMs: number; maxBytes: number },
): Promise<ExecResult> {
  const { Id: execId } = await json<{ Id: string }>(`POST`, `/containers/${containerId}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: opts.workingDir,
    Cmd: cmd,
  });

  const captured = await new Promise<{ stdout: Buffer[]; stderr: Buffer[] }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCK,
        method: 'POST',
        path: `${API}/exec/${execId}/start`,
        headers: { 'Content-Type': 'application/json' },
        timeout: 0,
      },
      (res) => {
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let pending: Buffer = Buffer.alloc(0);
        const timer = setTimeout(() => {
          res.destroy();
          finish();
        }, opts.hardTimeoutMs);
        const finish = () => {
          clearTimeout(timer);
          resolve({ stdout: out, stderr: err });
        };
        res.on('data', (chunk: Buffer) => {
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          // Demux complete frames; keep the partial tail for the next chunk.
          while (pending.length >= 8) {
            const size = pending.readUInt32BE(4);
            if (pending.length < 8 + size) break;
            const payload = pending.subarray(8, 8 + size);
            const type = pending[0];
            if (type === 2) {
              if (errBytes < opts.maxBytes) {
                err.push(payload);
                errBytes += payload.length;
              }
            } else if (outBytes < opts.maxBytes) {
              out.push(payload);
              outBytes += payload.length;
            }
            pending = pending.subarray(8 + size);
          }
        });
        res.on('end', finish);
        res.on('error', finish); // severed stream: return what we captured
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify({ Detach: false, Tty: false }));
    req.end();
  });

  const inspect = await json<{ ExitCode: number | null; Running: boolean }>(
    'GET',
    `/exec/${execId}/json`,
  );
  return {
    exitCode: inspect.Running ? null : inspect.ExitCode,
    stdout: Buffer.concat(captured.stdout),
    stderr: Buffer.concat(captured.stderr),
  };
}
