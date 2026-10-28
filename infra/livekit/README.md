# infra/livekit: the calls media server

LiveKit (Apache 2.0, `livekit/livekit-server:v1.13.11`) runs as one more
compose service behind the `calls` profile and the Settings > Services
switch. Off by default: no container, no ports, no Call button. The brain
side of calls is `docs/messenger.md` "Calls"; the plan is the dev-brain page
"PLAN: Calls and agent voice over LiveKit (2026-10-28)", sections 4, 11, 12,
19 and 20.

| piece                                  | what                                                                  | who owns it                                                       |
| -------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `livekit.yaml`                         | the server config: ports, TURN, room defaults, the webhook            | the release (embedded in the image, refreshed by the updater)     |
| `docker-compose.yml` service `livekit` | the container: ports, the config fill at start, the certificate mount | the release                                                       |
| the Caddy route and log filter         | `handle_path /livekit/*` in both shapes, `access_token=` redacted     | the release (`infra/caddy/README.md`)                             |
| `MANTLE_LIVEKIT_API_KEY` and `_SECRET` | the key pair the brain signs tokens and verifies webhooks with        | the box's `.env` (`install.sh` writes them; the updater fills in) |
| `MANTLE_CALLS_HOST`                    | the ONE hostname TURN serves, with Caddy's certificate                | the box's `.env` (`install.sh`; the updater fills it on a switch) |
| the four media ports at the cloud edge | UDP 7882, TCP 7881, TCP 5349, UDP 3478 inbound                        | the box's owner (a per-box ask, like port 80)                     |

## How the pieces fit

- **Signalling** on 7880 is internal only. Caddy proxies `wss://<site>/livekit`
  to it (the LiveKit client appends `/rtc`); no new DNS, no new certificate,
  same origin, port 443.
- **Media** goes over WebRTC straight between the browser and the box: UDP
  7882 (one port for every stream), ICE over TCP 7881 when UDP is blocked,
  TURN/TLS on 5349 and TURN/UDP on 3478 as the relay for the rest. These
  four are published by the service and must be open at the cloud edge of
  the box. Until they are, calls connect only on the local network, so leave
  the switch off on a box that does not have them.
- **Tokens.** The brain mints every token (`packages/content/src/livekit.ts`)
  with the key pair from `.env`: one login, one room, join, publish the
  microphone, subscribe, data, one hour, never an admin grant. The key pair
  reaches LiveKit as `LIVEKIT_KEYS` in the container's environment. Nothing
  secret is in `livekit.yaml`.
- **Webhooks.** `webhook.urls` points at `http://web:3000/api/livekit/webhook`,
  signed by the key pair; the brain verifies on the raw body and keeps every
  event id a day. The reconciler in the events worker is the truth when a
  webhook is lost.
- **The config is filled at start.** LiveKit does not expand environment
  variables inside its yaml, so the compose command copies the release file
  with `__MANTLE_CALLS_HOST__` and `__MANTLE_LIVEKIT_API_KEY__` (the key's
  public name) replaced, and runs the server on the copy. Compose refuses to
  start the service when either is unset.
- **TURN/TLS serves Caddy's certificate.** The calls host's own pair from
  Caddy's ACME store
  (`<data dir>/caddy/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<host>/`)
  is mounted read-only at `/caddy-cert`, never the whole store, and
  `turn.cert_file`/`key_file` point at `/caddy-cert/<host>.{crt,key}`. The
  image runs as root, so the root-only files are readable. The host must be
  a name Caddy holds a certificate for: the first of `MANTLE_SITE_ADDRESS`
  (which may carry several; TURN needs one). A box with no hostname (`:80`,
  a bare IP) cannot run calls. Two things to know: LiveKit reads the pair at
  start, so after Caddy renews (about every 60 days) restart the container
  (a roll does); and a certificate Caddy issued from its ZeroSSL fallback
  lives under another directory, so the service does not start until the
  Let's Encrypt one exists.
- **The public IP** is found by STUN through LiveKit's default STUN servers
  at start (`rtc.use_external_ip`). That lookup is the one outbound call to
  a third party; the sound itself never leaves the box and the callers.

## The ICE override (plan section 20)

`turn.tls_port` only picks where LiveKit listens. The ICE server list it
hands every browser is a fixed string in the binary: `turns:<domain>:443`.
443 is Caddy's, so a browser whose UDP is blocked would be sent to the wrong
port and fail (the P0 spike reproduced it). So the brain hands the client,
with every token, the same credential pair LiveKit minted for the room and
the port LiveKit really listens on:

```
ice: {
  urls: ['turns:<MANTLE_CALLS_HOST>:5349?transport=tcp', 'turn:<MANTLE_CALLS_HOST>:3478?transport=udp'],
  username: <the room's name>,
  credential: <the room's TURN password>
}
```

The brain reads the room's TURN password through the room API: LiveKit's
`CreateRoom` is idempotent (an existing room comes back with the same sid
and password) and `ListRooms` returns it too (checked against v1.13.11,
2026-10-28). The client passes the block as `rtcConfig.iceServers` and
nothing else. `ice` is null when the box has no `MANTLE_CALLS_HOST` or TURN
is off; the client then connects with LiveKit's own list. No fork of
LiveKit; a dedicated 443 for TURN (`turn.<domain>` through a Caddy layer4
build or a second IP) is revisited only if a real "443 only" network shows
up.

## Switching it on

Settings > Services > Calls, or by hand: `COMPOSE_PROFILES=calls` plus the
key pair and `MANTLE_CALLS_HOST` in `.env`, then `docker compose --profile
calls up -d livekit`. The updater does the same on a switch
(`infra/updater/updater.sh`: `calls` in `SERVICE_PROFILES`, container
`mantle_livekit`, token `MANTLE_LIVEKIT_API_SECRET`; `ensure_livekit_key` and
`ensure_calls_host` fill the rest, and `refresh_livekit` adopts the config
from the image where missing). A roll refreshes `livekit.yaml` beside the
Caddyfile. Switching off stops and removes the container; the reconciler
closes any open call as `service_off` within a minute and the chat gets one
line saying so. Nothing is stored by the service, so nothing is lost.

## Limits and cost (plan section 12)

A start or join 5 a minute per login; one open call per conversation; one
call at a time per login (a new device swaps); `MANTLE_CALLS_MAX_PARTICIPANTS`
(25) per call; `MANTLE_CALLS_MAX_MINUTES` (240) per call, after which the
reconciler deletes the room. No cron, trigger or state change starts a call
or a voice job: only a person's tap on the route does. `MANTLE_CALLS_AGENT`
registers the agent worker on a box (P2; no worker ships yet) and turns on
the assistant-call routes; its caps (`MANTLE_CALLS_AGENT_*`) are read by
nothing until then.

## Sizing and ops notes (from the P0 spike, dev box, 2026-10-28)

- At rest 14 MB and under 1 percent of a core. A four-way call with a
  continuous test tone and DTX off took 66 MB and 50 to 100 percent of one
  core (one outlier at 208 percent); the box stayed 70 to 84 percent idle on
  four cores. Measure again with real speech and DTX on before turning Calls
  on for a 2-cpu box. `mem_limit: 512m` is generous for audio.
- Connect 1.2 to 2.3 s from another continent; TURN/UDP relay 1.7 s; TURN/TLS
  relay on 5349 2.3 s, RTT about 200 ms (same as the direct path).
- Rooms close `empty_timeout` (30 s) after the last leave.
- LiveKit warns the UDP receive buffer is small (`net.core.rmem_max`,
  425984 vs 5000000 suggested). A sysctl on the box is a per-box ask like
  the ports; not needed for audio-only calls.
- The stack's `data/` is root-owned on a box and the owner has no sudo:
  everything calls need to edit lives in `.env`, never under `data/`.
- Not proven yet: ICE/TCP 7881 under real UDP blocking, a corporate laptop,
  and the browser microphone permission path (the spike published a
  generated track through the same publish call).
