/**
 * Balanced-tier egress proxy — the sbx-style middle network policy.
 *
 * A 'balanced' sandbox sits on an INTERNAL docker network (no NAT, no direct
 * route anywhere) and gets HTTP(S)_PROXY env pointing here. This proxy is the
 * sandbox's only road out, and it only leads to the allowlist: package
 * registries, GitHub, apt mirrors (plus SANDBOX_EGRESS_ALLOW extensions).
 * apt/curl/pip/npm/git-over-https all honor proxy env; anything that ignores
 * it simply has no route — fail closed by topology, not by inspection.
 *
 * No auth on this listener BY DESIGN: apt and friends can't attach bearer
 * tokens. The exposure is bounded — it forwards only to allowlisted hosts,
 * and only stack-internal networks can reach it at all. TLS passes through
 * untouched (CONNECT tunnel): we filter by hostname, never inspect content.
 */

import http from 'node:http';
import net from 'node:net';

const DEFAULT_ALLOW = [
  // package managers
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  // OS packages
  'archive.ubuntu.com',
  'security.ubuntu.com',
  'ports.ubuntu.com',
  'deb.debian.org',
  'deb.nodesource.com',
  'download.docker.com',
  // code hosting
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
];

const extra = (process.env.SANDBOX_EGRESS_ALLOW ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOW = new Set([...DEFAULT_ALLOW, ...extra]);

/** Exact host or subdomain of an allowlisted host. */
export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (ALLOW.has(h)) return true;
  for (const a of ALLOW) if (h.endsWith(`.${a}`)) return true;
  return false;
}

const refusal = (host: string) =>
  `egress to '${host}' is not on the balanced-tier allowlist (registries, GitHub, apt mirrors; extend via SANDBOX_EGRESS_ALLOW, or use a network:'full' sandbox)`;

/** Start the proxy listener. Returns the server (caller logs/owns it). */
export function startEgressProxy(port: number): http.Server {
  const server = http.createServer((req, res) => {
    // Absolute-form plain-HTTP proxying (apt uses this).
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('proxy requires absolute-form URLs');
    }
    if (!isAllowedHost(target.hostname)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end(refusal(target.hostname));
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: 60_000,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS: CONNECT tunnel, hostname-filtered, content untouched.
  server.on('connect', (req, clientSocket, head) => {
    // A client that RSTs after our refusal (curl does) must not take the
    // process down — every socket needs a listener BEFORE the first write.
    clientSocket.on('error', () => clientSocket.destroy());
    const [host, portStr] = (req.url ?? '').split(':');
    const port = Number(portStr) || 443;
    if (!host || !isAllowedHost(host)) {
      clientSocket.write(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${refusal(host ?? '?')}\n`,
      );
      return clientSocket.end();
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', drop);
    clientSocket.on('error', drop);
    upstream.setTimeout(120_000, drop);
  });

  // Belt and braces: malformed requests and abruptly-closed keep-alive
  // sockets surface here instead of as uncaught exceptions.
  server.on('clientError', (_err, socket) => socket.destroy());

  server.listen(port);
  return server;
}
