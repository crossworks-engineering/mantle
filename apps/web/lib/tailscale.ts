import http from 'node:http';

/**
 * Read-only view of the local tailscaled node, for the /settings/network status
 * tile + the route forms' peer dropdown. Server-only.
 *
 * The bundled `tailscale` sidecar (optional `tailnet` compose profile) exposes
 * its LocalAPI on a unix socket, shared into the app container at
 * MANTLE_TAILSCALE_SOCK (default /var/run/tailscale/tailscaled.sock). We GET
 * `/localapi/v0/status` over it — the same data `tailscale status --json`
 * prints.
 *
 * NEVER throws: a missing socket (tailnet profile off), a down daemon, or a
 * timeout all resolve to `{ available: false, reason }`. The status tile renders
 * "tailnet not running" and the peer dropdown is simply empty — every route's
 * base URL stays free-text, so the whole feature degrades to exactly the
 * pre-tailnet behaviour. This is the "build now, verify against a live tailnet
 * later" contract — the socket read can only be exercised end-to-end once a
 * tailnet is actually up (e.g. on the Contabo VPS).
 */

/** One peer on the tailnet (another device sharing your tailnet). */
export interface TailnetPeer {
  /** MagicDNS name, trailing dot stripped — e.g. "gemma-box.tail1234.ts.net".
   *  This is what you'd put in a route base URL: http://<dnsName>:<port>/v1 */
  dnsName: string;
  /** Short hostname — e.g. "gemma-box". */
  hostName: string;
  /** Tailscale IPs (100.x.y.z / fd7a:…). Surfaced for reference; prefer names. */
  ips: string[];
  online: boolean;
  /** OS string tailscaled reports (linux / windows / macOS …), best-effort. */
  os: string | null;
}

export interface TailnetStatus {
  available: true;
  /** tailscaled backend state: "Running" when connected; "NeedsLogin",
   *  "Stopped", "Starting" otherwise. */
  backendState: string;
  /** This node's MagicDNS name + hostname (how peers reach US). */
  self: { dnsName: string; hostName: string; online: boolean } | null;
  /** The tailnet domain, e.g. "tail1234.ts.net". */
  magicDNSSuffix: string | null;
  peers: TailnetPeer[];
}

export interface TailnetUnavailable {
  available: false;
  /** Human-readable why — shown in the status tile. */
  reason: string;
}

export type TailnetResult = TailnetStatus | TailnetUnavailable;

function sockPath(): string {
  return process.env.MANTLE_TAILSCALE_SOCK?.trim() || '/var/run/tailscale/tailscaled.sock';
}

/** Raw shape of the bits of `/localapi/v0/status` we consume. */
interface RawStatus {
  BackendState?: string;
  MagicDNSSuffix?: string;
  Self?: RawNode;
  Peer?: Record<string, RawNode>;
}
interface RawNode {
  DNSName?: string;
  HostName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  OS?: string;
}

const stripDot = (s: string | undefined): string => (s ?? '').replace(/\.$/, '');

function toPeer(n: RawNode): TailnetPeer {
  return {
    dnsName: stripDot(n.DNSName),
    hostName: n.HostName ?? '',
    ips: n.TailscaleIPs ?? [],
    online: n.Online ?? false,
    os: n.OS || null,
  };
}

/**
 * GET the tailscaled LocalAPI `status` over the unix socket. Resolves to the
 * parsed status or an unavailable result; never rejects.
 */
export async function getTailnetStatus(timeoutMs = 1500): Promise<TailnetResult> {
  const socketPath = sockPath();
  return new Promise<TailnetResult>((resolve) => {
    let settled = false;
    const done = (r: TailnetResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const req = http.request(
      {
        socketPath,
        path: '/localapi/v0/status',
        method: 'GET',
        // tailscaled's LocalAPI rejects requests whose Host isn't the sentinel
        // it expects (a CSRF guard for the loopback API).
        headers: { Host: 'local-tailscaled.sock' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            done({ available: false, reason: `tailscaled LocalAPI HTTP ${res.statusCode}` });
            return;
          }
          try {
            const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RawStatus;
            const self = raw.Self
              ? {
                  dnsName: stripDot(raw.Self.DNSName),
                  hostName: raw.Self.HostName ?? '',
                  online: raw.Self.Online ?? false,
                }
              : null;
            const peers = Object.values(raw.Peer ?? {})
              .map(toPeer)
              // Sort online-first, then by hostname, so the dropdown is useful.
              .sort((a, b) =>
                a.online === b.online ? a.hostName.localeCompare(b.hostName) : a.online ? -1 : 1,
              );
            done({
              available: true,
              backendState: raw.BackendState ?? 'Unknown',
              self,
              magicDNSSuffix: raw.MagicDNSSuffix ? stripDot(raw.MagicDNSSuffix) : null,
              peers,
            });
          } catch (e) {
            done({ available: false, reason: `parse error: ${(e as Error).message}` });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      done({ available: false, reason: 'tailscaled did not respond (timeout)' });
    });
    req.on('error', (e: NodeJS.ErrnoException) => {
      // ENOENT = socket absent (tailnet profile off) — the common, benign case.
      const reason =
        e.code === 'ENOENT'
          ? 'tailnet not running (no tailscaled socket)'
          : e.code === 'ECONNREFUSED'
            ? 'tailscaled socket present but not accepting connections'
            : `socket error: ${e.message}`;
      done({ available: false, reason });
    });
    req.end();
  });
}

/** Convenience for the route forms: just the online-capable peer names (the
 *  values you'd drop into a base URL). Empty when no tailnet. Never throws. */
export async function getTailnetPeerNames(): Promise<string[]> {
  const s = await getTailnetStatus();
  if (!s.available) return [];
  return s.peers.map((p) => p.dnsName).filter(Boolean);
}

// ─── write path: drive tailscaled login/logout (PermitWrite endpoints) ───────
//
// UI activation. These POST to tailscaled's LocalAPI over the SAME shared
// socket the status read uses, but to its mutating endpoints — so the socket
// must be mounted read-WRITE into the app (docker-compose.yml). On a single-user
// box, letting the app drive its own tailnet membership is an acceptable trade.
//
// CAVEAT (verified on the VPS): tailscaled may gate these PermitWrite endpoints
// by socket peer-credentials. If `/start` is rejected from the web process, the
// fallback is the `file:` authkey trick — see docs / the plan.

export type TailnetActionResult = { ok: true } | { ok: false; reason: string };

/** Raw POST to a tailscaled LocalAPI path over the unix socket. Resolves to the
 *  status code + body text, or an error reason; never rejects. */
function localApiPost(
  path: string,
  body: string | null,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { statusCode: number; body: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = http.request(
      {
        socketPath: sockPath(),
        path,
        method: 'POST',
        headers: {
          // Same CSRF sentinel host the status GET uses.
          Host: 'local-tailscaled.sock',
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          done({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done({ error: 'tailscaled did not respond (timeout)' });
    });
    req.on('error', (e: NodeJS.ErrnoException) => {
      done({
        error:
          e.code === 'ENOENT'
            ? 'tailnet sidecar not running (no tailscaled socket)'
            : `socket error: ${e.message}`,
      });
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Bring the tailnet up by logging in with an auth key. This is the LocalAPI
 *  equivalent of `tailscale up --authkey=…`: POST `/start` with the AuthKey +
 *  prefs to STORE the key, then POST `/login-interactive` to TRIGGER the login
 *  (with a key stored, it's non-interactive — no browser URL). Doing only the
 *  first half leaves tailscaled at NeedsLogin and the key unused. ASYNC on
 *  tailscaled's side — a 2xx means "login started", so the caller polls
 *  getTailnetStatus for backendState 'Running'. Never throws. */
export async function tailnetUp(authKey: string, hostname: string): Promise<TailnetActionResult> {
  const options = {
    AuthKey: authKey,
    UpdatePrefs: { WantRunning: true, Hostname: hostname },
  };
  const start = await localApiPost('/localapi/v0/start', JSON.stringify(options), 8000);
  if ('error' in start) return { ok: false, reason: start.error };
  if (start.statusCode >= 400) {
    return { ok: false, reason: `tailscaled /start HTTP ${start.statusCode}${start.body ? ` — ${start.body.slice(0, 300)}` : ''}` };
  }
  // Fire the login now that the auth key is stored. Without this, /start just
  // sits at NeedsLogin and the key is never applied.
  const login = await localApiPost('/localapi/v0/login-interactive', null, 8000);
  if ('error' in login) return { ok: false, reason: login.error };
  if (login.statusCode >= 400) {
    return { ok: false, reason: `tailscaled /login-interactive HTTP ${login.statusCode}` };
  }
  return { ok: true };
}

/** Take the tailnet down (log out). POSTs to `/localapi/v0/logout`. Never throws. */
export async function tailnetDown(): Promise<TailnetActionResult> {
  const r = await localApiPost('/localapi/v0/logout', null, 8000);
  if ('error' in r) return { ok: false, reason: r.error };
  if (r.statusCode >= 400) {
    return { ok: false, reason: `tailscaled /logout HTTP ${r.statusCode}` };
  }
  return { ok: true };
}
