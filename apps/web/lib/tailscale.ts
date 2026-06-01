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
