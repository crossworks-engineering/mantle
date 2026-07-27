/**
 * MCP bridge — one persistent `claude mcp serve` per sandbox.
 *
 * The eval finding this builds on: `claude mcp serve` needs NO API key — the
 * LLM sits on the MCP client side, so the in-sandbox Claude Code is purely a
 * sandboxed toolbelt (Read/Grep/Edit/Bash/…) and Mantle's own agent stays the
 * brain. This module keeps the stdio session alive across calls (a fresh
 * spawn per call would lose nothing semantically but pays ~seconds of
 * startup every time), speaking newline-delimited JSON-RPC over a hijacked
 * docker-exec stream.
 *
 * Deliberately narrow, like every sandboxd surface: the bridge forwards ONLY
 * `tools/list` and `tools/call`. No sampling, no prompts, no resources — if
 * a future need appears, widening this list is a decision, not a default.
 *
 * Lifecycle: sessions are created lazily, reused while the socket lives, and
 * dropped on any socket end/error (next call re-creates). Stopping the
 * sandbox kills the process → socket → session, so idle-stop composes for
 * free. All pending requests are rejected on drop — callers see a clear
 * retryable error, never a hang.
 */

import * as docker from './docker';

const ALLOWED_METHODS = new Set(['tools/list', 'tools/call']);
const PROTOCOL_VERSION = '2025-06-18';
const HANDSHAKE_TIMEOUT_MS = 30_000;
const STDERR_RING = 4 * 1024;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

class McpSession {
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuf = '';
  private stderrTail = '';
  private frame: Buffer = Buffer.alloc(0);
  closed = false;

  constructor(
    private socket: import('node:net').Socket,
    private onClose: () => void,
  ) {
    socket.on('data', (c: Buffer) => this.feed(c));
    const drop = () => this.drop(new Error('mcp session ended'));
    socket.on('end', drop);
    socket.on('error', drop);
    socket.on('close', drop);
  }

  /** Demux docker frames → stdout JSON lines → resolve by id. */
  private feed(chunk: Buffer): void {
    this.frame = this.frame.length ? Buffer.concat([this.frame, chunk]) : chunk;
    while (this.frame.length >= 8) {
      const size = this.frame.readUInt32BE(4);
      if (this.frame.length < 8 + size) break;
      const payload = this.frame.subarray(8, 8 + size);
      const type = this.frame[0];
      if (type === 2) {
        this.stderrTail = (this.stderrTail + payload.toString('utf8')).slice(-STDERR_RING);
      } else {
        this.stdoutBuf += payload.toString('utf8');
        let nl: number;
        while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
          const line = this.stdoutBuf.slice(0, nl).trim();
          this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
          if (line) this.dispatch(line);
        }
      }
      this.frame = this.frame.subarray(8 + size);
    }
  }

  private dispatch(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout — ignore
    }
    if (typeof msg.id !== 'number') return; // notification — none we act on
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'mcp error'));
    else p.resolve(msg.result);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('mcp session closed'));
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `mcp ${method} timed out after ${Math.round(timeoutMs / 1000)}s` +
              (this.stderrTail ? ` — serve stderr tail: ${this.stderrTail.slice(-300)}` : ''),
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(line);
    });
  }

  notify(method: string, params?: unknown): void {
    this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private drop(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${err.message} — the serve process died; retry re-spawns it`));
    }
    this.pending.clear();
    this.onClose();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

const sessions = new Map<string, McpSession>();
const opening = new Map<string, Promise<McpSession>>();

async function open(sandboxId: string, containerId: string): Promise<McpSession> {
  const { socket } = await docker.execInteractive(containerId, ['claude', 'mcp', 'serve']);
  const session = new McpSession(socket, () => {
    if (sessions.get(sandboxId) === session) sessions.delete(sandboxId);
  });
  await session.request(
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mantle-sandboxd', version: '1.0.0' },
    },
    HANDSHAKE_TIMEOUT_MS,
  );
  session.notify('notifications/initialized');
  return session;
}

/** Get the live session for a sandbox, creating it if needed. Concurrent
 *  callers during spawn share one in-flight open (no double-serve). */
export async function ensureSession(sandboxId: string, containerId: string): Promise<McpSession> {
  const existing = sessions.get(sandboxId);
  if (existing && !existing.closed) return existing;
  const inFlight = opening.get(sandboxId);
  if (inFlight) return inFlight;
  const p = open(sandboxId, containerId)
    .then((s) => {
      sessions.set(sandboxId, s);
      return s;
    })
    .finally(() => opening.delete(sandboxId));
  opening.set(sandboxId, p);
  return p;
}

export function isAllowedMethod(method: string): boolean {
  return ALLOWED_METHODS.has(method);
}

/** Drop a sandbox's session (called before stop/rm so the process exits
 *  cleanly rather than being SIGKILLed with the container). */
export function dropSession(sandboxId: string): void {
  sessions.get(sandboxId)?.destroy();
  sessions.delete(sandboxId);
}
