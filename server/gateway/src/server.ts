/**
 * The gateway's HTTP server (docs/gateway.md): `/svc/<slug>/<path>` from the
 * brain, sent on to the registered service, streamed both ways. The I/O
 * the decision needs (the registry, the call log, the address check) comes
 * in as options, so the tests drive the real server with stubs.
 *
 * Per request, in order: `GET /healthz` answers with no token; every other
 * request must carry GATEWAY_TOKEN in `x-mantle-gateway-token` (Authorization
 * stays the service's own: the brain puts the service's vault key there),
 * and one without it leaves no row;
 * the target is parsed and refused when it is not a plain `/svc/<slug>/...`
 * path; the slug must name an enabled service that allows the method and
 * the path; the upstream name must resolve only into a services subnet.
 * Then the request goes to that address with the gateway's own headers
 * removed, and the answer comes back as it is (a redirect too: the brain
 * refuses one that leaves the service). Every request past the token leaves
 * one call row, a refusal too.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { GatewayCallEntry } from '@mantle/db';
import { pathPrefixRefusal, upstreamRefusal } from '@mantle/db/service-gateway-rules';
import { RegistryUnavailable } from './brain';
import { decide, isRefusal, parseTarget, REFUSALS, type Refusal, type RouteService } from './route';

/** The headers the brain sends the gateway, never the service. */
export const GATEWAY_TOKEN_HEADER = 'x-mantle-gateway-token';
export const GATEWAY_CALLER_HEADER = 'x-mantle-caller';
export const GATEWAY_LOGIN_HEADER = 'x-mantle-login';

/** Hop-by-hop headers (RFC 9110 7.6.1) and the ones the gateway sets. */
const DROP_IN = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-prefix',
  'x-real-ip',
  GATEWAY_TOKEN_HEADER,
  GATEWAY_CALLER_HEADER,
  GATEWAY_LOGIN_HEADER,
]);
const DROP_OUT = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type GatewayOptions = Readonly<{
  /** GATEWAY_TOKEN; empty: every service call answers 503. */
  token: string;
  /** The service with this slug, or null. */
  lookup: (slug: string) => Promise<RouteService | null>;
  /** The address to connect to for an upstream host, or null (refused). */
  address: (host: string) => Promise<string | null>;
  /** One call row (fire and forget: the shipper batches it to the brain). */
  record: (entry: GatewayCallEntry) => void;
  /** The most request body bytes one call may send. */
  maxBodyBytes: number;
  /** An upstream socket idle this long is cut (ms). */
  idleTimeoutMs: number;
}>;

const digest = (s: string) => createHash('sha256').update(s).digest();

function tokenOk(got: string | string[] | undefined, token: string): boolean {
  if (typeof got !== 'string' || !token) return false;
  return timingSafeEqual(digest(got), digest(token));
}

function oneHeader(v: string | string[] | undefined, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/** The service row with what the gateway may use of it: a malformed prefix
 *  (a row written past the API) is dropped, a malformed upstream refuses
 *  the row. Fail closed. */
function usable(row: RouteService | null): RouteService | null {
  if (!row || upstreamRefusal(row.upstream)) return row && { ...row, enabled: false };
  return { ...row, pathPrefixes: row.pathPrefixes.filter((p) => !pathPrefixRefusal(p)) };
}

/** Calls refused for the token since the last word on it. */
let unauthenticated = 0;
let lastUnauthWarn = 0;
function noteUnauthenticated(what: string): void {
  unauthenticated += 1;
  const now = Date.now();
  if (now - lastUnauthWarn < 10 * 60_000) return;
  lastUnauthWarn = now;
  console.warn(`[gateway] refused ${unauthenticated} call(s): ${what}`);
  unauthenticated = 0;
}

/** The most connections open at once, and how long one request may take
 *  to arrive whole (its headers and body). */
const MAX_CONNECTIONS = 256;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export function createGateway(opts: GatewayOptions): http.Server {
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  // No WebSocket or other upgrade: the gateway carries plain HTTP only.
  server.on('upgrade', (_req, socket) => socket.destroy());

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = req.url ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' && raw === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const started = Date.now();
    // A call without the token is refused before anything else and leaves
    // no row (a row per refusal would let anyone who reaches the gateway
    // grow the log); it is counted and said at most every ten minutes.
    if (!opts.token || !tokenOk(req.headers[GATEWAY_TOKEN_HEADER], opts.token)) {
      noteUnauthenticated(opts.token ? 'a call without the gateway token' : 'no GATEWAY_TOKEN');
      req.resume();
      send(res, opts.token ? REFUSALS.auth : REFUSALS.noToken);
      return;
    }
    // Who calls, as the brain named it: trusted only past the token.
    const caller = oneHeader(req.headers[GATEWAY_CALLER_HEADER], 200);
    const loginId = oneHeader(req.headers[GATEWAY_LOGIN_HEADER], 64);
    const target = parseTarget(raw);
    const slug = isRefusal(target) ? slugGuess(raw) : target.slug;
    const path = isRefusal(target) ? pathGuess(raw) : target.path;
    let requestBytes = 0;
    let responseBytes = 0;
    let refusal: string | null = null;
    res.on('close', () => {
      opts.record({
        serviceSlug: slug,
        method,
        path: path.slice(0, 512),
        status: res.statusCode,
        requestBytes,
        responseBytes,
        durationMs: Date.now() - started,
        caller,
        loginId,
        refusal,
      });
    });
    const refuse = (r: Refusal) => {
      refusal = r.code;
      req.resume();
      send(res, r);
    };

    try {
      await route(req, res, target, method, refuse, {
        addRequest: (n) => (requestBytes += n),
        addResponse: (n) => (responseBytes += n),
        setRefusal: (code) => (refusal = code),
      });
    } catch (err) {
      // The brain did not hand over the registry: refused, fail closed.
      // Any other fault of the gateway's own is logged. The call row says
      // which.
      const r = err instanceof RegistryUnavailable ? REFUSALS.noRegistry : REFUSALS.failed;
      if (r === REFUSALS.failed) console.error('[gateway] request failed', err);
      refusal = r.code;
      if (!res.headersSent) send(res, r);
      else res.destroy();
    }
  }

  async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: ReturnType<typeof parseTarget>,
    method: string,
    refuse: (r: Refusal) => void,
    count: Readonly<{
      addRequest: (n: number) => void;
      addResponse: (n: number) => void;
      setRefusal: (code: string) => void;
    }>,
  ): Promise<void> {
    if (isRefusal(target)) return refuse(target);
    const service = usable(await opts.lookup(target.slug));
    const verdict = decide(service, method, target.path);
    if (isRefusal(verdict)) return refuse(verdict);
    const i = service!.upstream.lastIndexOf(':');
    const host = service!.upstream.slice(0, i);
    const port = Number(service!.upstream.slice(i + 1));
    const address = await opts.address(host);
    if (!address) return refuse(REFUSALS.upstream);

    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > opts.maxBodyBytes) return refuse(REFUSALS.tooLarge);

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !DROP_IN.has(k)) headers[k] = v;
    }
    headers.host = service!.upstream;
    headers['x-forwarded-prefix'] = `/svc/${target.slug}`;

    await new Promise<void>((resolve) => {
      const upstream = http.request(
        {
          host: address,
          port,
          method,
          path: `${target.path}${target.query}`,
          headers,
          timeout: opts.idleTimeoutMs,
        },
        (up) => {
          const out: http.OutgoingHttpHeaders = {};
          for (const [k, v] of Object.entries(up.headers)) {
            if (v !== undefined && !DROP_OUT.has(k)) out[k] = v;
          }
          res.writeHead(up.statusCode ?? 502, out);
          up.on('data', (c: Buffer) => count.addResponse(c.length));
          up.pipe(res);
          up.on('end', resolve);
          up.on('error', () => {
            res.destroy();
            resolve();
          });
        },
      );
      let timedOut = false;
      upstream.on('timeout', () => {
        timedOut = true;
        upstream.destroy(new Error('upstream idle timeout'));
      });
      let cut = false;
      upstream.on('error', () => {
        if (cut) return resolve();
        if (!res.headersSent) {
          count.setRefusal(timedOut ? REFUSALS.timeout.code : REFUSALS.unreachable.code);
          send(res, timedOut ? REFUSALS.timeout : REFUSALS.unreachable);
        } else {
          res.destroy();
        }
        resolve();
      });
      // The caller went away: stop the upstream call too.
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });
      let sent = 0;
      req.on('data', (c: Buffer) => {
        sent += c.length;
        count.addRequest(c.length);
        if (sent > opts.maxBodyBytes && !cut) {
          cut = true;
          count.setRefusal(REFUSALS.tooLarge.code);
          if (!res.headersSent) send(res, REFUSALS.tooLarge);
          upstream.destroy(new Error('request body too large'));
          req.unpipe(upstream);
          req.resume();
        }
      });
      req.pipe(upstream);
    });
  }

  return server;
}

/**
 * Where the health check reaches the gateway: the container's own
 * `127.0.0.1` (docker-compose.yml's healthcheck). When the gateway listens
 * on one address of the default network, a second listener on loopback
 * answers `GET /healthz` and nothing else; when it listens everywhere or
 * on loopback already, none is needed (null).
 */
export function healthListenerHost(mainHost: string): string | null {
  return mainHost === '0.0.0.0' || mainHost === '127.0.0.1' || mainHost === '::'
    ? null
    : '127.0.0.1';
}

/** The loopback health listener: `GET /healthz` only, every other request
 *  404, no token, no registry, no upstream. */
export function createHealthServer(): http.Server {
  return http.createServer((req, res) => {
    const ok = (req.method === 'GET' || req.method === 'HEAD') && req.url === '/healthz';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(ok ? JSON.stringify({ ok: true }) : JSON.stringify(REFUSALS.notGateway));
  });
}

function send(res: http.ServerResponse, r: Refusal): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: r.error, code: r.code }));
}

/** For the call row of a refused target: what it seemed to ask for. */
function slugGuess(raw: string): string {
  const m = /^\/svc\/([^/?#]{1,64})/.exec(raw);
  return m ? m[1]! : '';
}

function pathGuess(raw: string): string {
  const q = raw.indexOf('?');
  const p = q === -1 ? raw : raw.slice(0, q);
  const m = /^\/svc\/[^/]*(\/.*)?$/.exec(p);
  return (m ? (m[1] ?? '/') : p).slice(0, 512);
}
