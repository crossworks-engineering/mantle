# infra/livekit: the calls media server

LiveKit (Apache 2.0) runs as one more compose service behind the `calls`
profile and the Settings > Services switch. Off by default: no container, no
ports, no Call button. Plan: dev-brain page "PLAN: Calls and agent voice over
LiveKit (2026-10-28)", sections 3, 4 and 19.

| piece                      | what                                                 | status (2026-10-28)                 |
| -------------------------- | ---------------------------------------------------- | ----------------------------------- |
| `livekit.yaml`             | release-owned server config, host filled in at start | P1 draft, not wired                 |
| `docker-compose.calls.yml` | the `livekit` service sketch (repo root)             | P1 draft, not merged into the stack |
| Caddy route and log filter | `handle_path /livekit/*` + `access_token=` redaction | see infra/caddy/README.md, P1       |
| `scripts/spike/`           | the P0 test page, token script and box drop-in       | kept for reference                  |

## What the P0 spike proved (dev box, 2026-10-28)

The spike ran LiveKit v1.13.11 as an extra container beside the release stack,
reachable through a Caddy conf.d drop-in, with four browser clients on one Mac
(three tabs of the app's browser pane, one Chrome tab). Every client published
a pulsed test tone through the normal microphone publish path and measured
what it received with an AnalyserNode. Numbers are in section 19 of the plan.

- **Signalling behind the path prefix works.** `wss://<site>/livekit` through
  `handle_path /livekit/* { reverse_proxy livekit:7880 }` connects, publishes
  and subscribes. The JS client appends `/rtc` itself, so the public URL is the
  bare prefix. Connect took 1.2 to 2.3 s from South Africa to the EU box. No
  separate vhost is needed.
- **Four participants hear each other.** Each page saw every other page's
  server-side audio level reach 0.375 and its received RMS switch between
  silence and tone about once a second for the whole call.
- **Media goes over UDP 7882 by default** (candidate pair srflx/prflx to the
  server's host candidate on 7882). ICE/TCP 7881 was not exercised: a browser
  cannot be told to drop UDP, and no laptop with UDP blocked was available
  (decision D6).
- **TURN works, and the TLS listener on 5349 works**, but see the trap below.
  A relay-only client (`iceTransportPolicy: 'relay'`) connected over TURN/UDP
  3478 in 1.7 s. Forced onto `turns:<site>:5349?transport=tcp` it connected in
  2.3 s, reported `relayProtocol: tls`, and carried audio both ways for over
  100 s (RTT about 200 ms, same as the direct path).
- **CPU and RAM.** At rest 14 MB and under 1 percent of a core. During the
  4-participant call 66 MB and 50 to 100 percent of ONE core (`docker stats`,
  eleven samples, one outlier at 208 percent), with the box at 70 to 84
  percent idle on 4 cores. Free memory on the box moved from 1243 MB before to
  1147 MB during the call. A 512 MB `mem_limit` is generous for audio.
- **`access_token` leaks into Caddy's access log.** The release logger prints
  the full JWT in the `uri` of every signalling request. A drop-in cannot
  change the release logger's filter; a second named `log` directive in a
  drop-in produced a redacted copy but also doubled every access-log line.
  P1 M2 adds the regexp to the release Caddyfile (infra/caddy/README.md).
- **Rooms close on `empty_timeout`.** 30 s after the last leave the room was
  gone and the container was back at rest.
- **Box-side setup took about 6 minutes** (config, container, drop-in,
  validate, reload) once the layout was known.

## The trap: LiveKit advertises TURN/TLS on port 443

`turn.tls_port` only chooses where the server LISTENS. The ICE server list the
server hands every client is hard-coded in the binary:

    turn:<node ip>:3478?transport=udp
    turns:<turn.domain>:443?transport=tcp

So a client whose UDP is blocked is told to open TLS to `<site>:443`, which
Caddy holds. The spike reproduced it: with only the advertised `turns:` server
the client failed after 15 s with `could not establish pc connection`. With
the port rewritten to 5349 on the client side it connected at once.

What this means for decision D2 (open TCP 5349 at the edge):

1. Opening 5349 alone does nothing for browsers: they never try it.
2. Options, cheapest first:
   - **Client-side ICE override.** The brain already mints the token; it can
     also hand the client the ICE server list with the right port. The TURN
     credential is per room (username = room name, password = the room's TURN
     password), and the only place the client learns it is LiveKit's join
     response. The spike page therefore joined once to read the credential,
     disconnected, and joined again with the rewritten URL: a double join. A
     production client would need LiveKit's `rtcConfig.iceServers` filled from
     the first join, or a server-side way to read the room's TURN password
     (none in the public API as of v1.13.11).
   - **TURN/TLS on a port 443 of its own.** A second public IP, or a DNS name
     `turn.<domain>` pointing at a host or sidecar that owns 443 (coturn, or a
     Caddy built with the layer4 plugin routing by SNI). That is the "layer4
     build" of section 14, now needed for the UDP-blocked case, not only for
     the "443 only" corporate case.
   - **Patch the advertised port.** One line in the LiveKit source
     (`turns:%s:443`). A fork is a maintenance cost for a one-line change;
     an upstream config option is worth asking for.

P1 must pick one before the first client box turns Calls on. Until then a
caller whose UDP is blocked still has ICE/TCP 7881 (not exercised here) and
TURN/UDP 3478; only a network that blocks UDP entirely and every TCP port but
443 is stuck, and that network needs 443 either way.

## Other things P1 must do differently from the plan

- `canPublishSources` takes the `TrackSource` enum from `livekit-server-sdk`,
  not the string `'microphone'`: the string throws `Cannot convert
TrackSource microphone to string` at `toJwt()`.
- `MANTLE_SITE_ADDRESS` can carry several hostnames (the dev box does). TURN
  needs one; add `MANTLE_CALLS_HOST` (default: the first address) rather than
  parsing the list in three places.
- The stack's `data/` is root-owned and the box user has no sudo, so anything
  the box owner must edit for calls lives in `infra/` or `.env`, never under
  `data/`. The caddy ACME store is read-only to LiveKit and that is enough.
- The config file cannot read env vars; the compose command fills the host
  in at start and the keys ride `LIVEKIT_KEYS`. Do not put the secret in the
  yaml.
- LiveKit warns `UDP receive buffer is too small for a production set-up`
  (current 425984, suggested 5000000). A sysctl `net.core.rmem_max` on the
  box is a per-box ask like the ports; not needed for audio-only calls.
- The signalling URL carries the token as a query parameter, so the Caddy
  filter must land in the same release as the route.
- `docker stats` CPU for audio was higher than LiveKit's own guidance for an
  SFU; the test tone was continuous with DTX off. Measure again with real
  speech and DTX on before sizing the small boxes.

## Verdict

Go, with one change: TURN/TLS reachability for UDP-blocked callers is not
solved by opening 5349, so P1 M2 carries the ICE-override or the turn.<domain>
443 decision (above) as its first item, and the dev roll of P1 keeps Calls on
dev only.
