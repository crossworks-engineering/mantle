# Tailscale remote inference

> **Status: SHIPPED 2026-06-01.** Compose service, `local` chat adapter,
> per-route proxy dispatch, the `/settings/network` status page + peer dropdown,
> and the "Connect a device" guide are all built and on `main`. The one thing
> only an operator can confirm is the live NAT traversal against a real tailnet
> (the runtime is unit-tested for route *selection*; the actual proxy hop lights
> up the first time a tailnet is up — e.g. on a Contabo VPS reaching a home box).
> §0 below is the as-built reference; §1 onward is the original design narrative,
> kept for the rationale (a couple of decisions changed in the build — noted in §0).

How a self-hosted Mantle reaches a beefy inference box that lives on your own
network — so you can run capable chat / vision models locally and let Mantle
use them — without touching IP addresses or router settings.

It's the **networking layer** under the [chat primary/backup routes](./chat-failover.md)
(which decide *which* model a worker uses) and the [bundled local embedder](./embeddings.md)
(the first local model). Those answer "which model"; this answers "how does the
cloud box reach the model running in my house."

---

## 0. As built (what shipped)

| Piece | Where | Note |
|---|---|---|
| `tailscale` compose service | [`docker-compose.yml`](../docker-compose.yml) | userspace, **HTTP** forward-proxy on `:1055`, profile-gated `--profile tailnet` (off by default). Joins via `TS_AUTHKEY` from `.env`. |
| `local` chat adapter | [`local-chat.ts`](../packages/voice/src/adapters/local-chat.ts) | OpenAI-compat; honours per-route `baseUrl` + `viaTailnet`. `getChatAdapter('local')`. |
| Proxy dispatch | [`tailnet.ts`](../packages/voice/src/adapters/tailnet.ts) | `tailnetFetch` via undici `ProxyAgent`; **inert by default** (no proxy → direct fetch). `undici` is lazy-`require`d so the `@mantle/voice` barrel stays browser-safe. |
| Per-route host columns | migration `0063` | `base_url` + `via_tailnet` (+ backup pair) on `agents` + `ai_workers`, threaded through `resolveChatRoutes` → `ChatOptions`. |
| Operator UI | [`/settings/network`](../apps/web/app/\(app\)/settings/network/page.tsx) | connection tile + reachable-devices list + setup guide; a `RouteHostFields` base-URL input (with a peer `<datalist>`) + "Reach via Tailscale" switch on the agents/ai-workers route forms. |
| Status reader | [`lib/tailscale.ts`](../apps/web/lib/tailscale.ts) | reads the tailscaled **LocalAPI** (`/localapi/v0/status`) over a shared unix socket; never throws (degrades to "tailnet not running"). |
| Onboarding | [`/settings/network/connect`](../apps/web/app/\(app\)/settings/network/connect/page.tsx) | platform-tabbed (Linux/macOS/Windows) "Connect a device" guide. |

**Two decisions changed from the design below:**
1. **HTTP forward-proxy, not SOCKS5** (§8 left this open) — `TS_OUTBOUND_HTTP_PROXY_LISTEN`; the Node `undici` fetch path uses the HTTP proxy. SOCKS5 is still available via `TS_SOCKS5_SERVER` if ever needed.
2. **Env-based auth key, not a UI secret field** (§3/§5 imagined a paste-in field) — the sidecar reads `TS_AUTHKEY` from its environment at container-start; Mantle (a separate container) can't inject it into a running container, so a UI field would look like it works but wouldn't. The page shows the `.env` snippet + console link instead, and reads the *resulting* connection over the LocalAPI socket. Honest over pretty.

**Bring it up:** put `TS_AUTHKEY` (+ optional `TS_HOSTNAME`) in `.env`, then `docker compose --profile tailnet up -d`. The full walkthrough is the in-app **Connect a device** guide.

---

## 1. The problem

Capable chat and vision models don't fit Mantle's base 8GB/6-core VPS — they
want a bigger box, usually with a GPU. The natural setup is: run them on a
machine you own (a home server, a workstation, the AMD box running LM Studio)
and point Mantle's routes at it.

The catch is **networking**. Your inference box sits behind a home router (NAT)
with no public IP. A cloud VPS can't just open `http://192.168.x.x:11434` —
that address only means anything inside your house. The usual fixes (port
forwarding, dynamic DNS, a hand-rolled VPN) are fiddly, fragile, and a security
footgun.

---

## 2. Why Tailscale

Tailscale builds a private encrypted mesh ("tailnet") across your devices.
Every machine you add gets:

- a **stable address** that doesn't change when your home IP does, and
- a **MagicDNS name** — a friendly hostname like `gpu-box` — so you never type
  an IP at all.

Put the Mantle VPS and your inference box on the same tailnet and the VPS can
reach `http://gpu-box:11434/v1` directly, as if they were on the same LAN. No
port forwarding, no public exposure, encrypted end to end.

The thing Jason liked most: **it's name-based, not IP-based.** That property
drives the whole UI design below — you pick a machine by name, never a number.

---

## 3. The user experience (the whole point is "simple")

**One-time, on your inference box** — the only steps outside Mantle:

1. Install Tailscale (one command / one app) and sign in with a free account.
   Your box joins your tailnet as, say, `gpu-box`.
2. Run your model server (Ollama / LM Studio) as usual.
3. In the Tailscale admin console, click **Generate auth key** and copy it.

**In Mantle** — this is the entire UI:

1. A small **"Local network"** settings section: paste the auth key. Status
   flips to **"Connected as mantle-vps."** (Mantle's bundled Tailscale container
   has now joined your tailnet.)
2. On a chat / vision route, instead of typing anything, **pick `gpu-box` from a
   dropdown** of your tailnet machines and set the port (e.g. `11434`). Save.

Done. You never touch a `100.x` address or a router setting. That dropdown — a
list of your tailnet machines by MagicDNS name — is what delivers the "no IPs"
feel; Mantle reads the peer list from Tailscale and shows you names.

**The one unavoidable cost** (being honest): Tailscale has to be installed on
the inference box, and you need a free Tailscale account. That's inherent to
reaching a machine behind your router — there's no zero-setup version. But it's
a ~2-minute install plus a free login, and after that Mantle's UI hides all of
it.

---

## 4. Architecture — userspace Tailscale + a proxy

Running Tailscale *in Docker* has one real decision, and it matters:

- **Shared network namespace** (`network_mode: service:tailscale`): the app
  container joins Tailscale's network directly. Simple in theory, but the app
  then **loses Docker's service DNS** — it can no longer reach `postgres`,
  `minio`, or `ollama` by name, because it's living in Tailscale's network
  stack instead of the compose bridge. That breaks the rest of the stack.

- **Userspace Tailscale + a proxy** (chosen): the Tailscale container runs in
  userspace mode and exposes a **SOCKS5 proxy** on the compose network. The app
  keeps normal service DNS for everything internal, and **only the outbound
  model calls** to tailnet hosts get routed through the proxy. Contained,
  surgical, doesn't disturb anything else.

```
   ┌─────────────── compose network (service DNS intact) ──────────────┐
   │  web / agent ──▶ postgres, minio, ollama   (direct, by name)      │
   │       │                                                            │
   │       │  routes flagged "via tailnet" only                        │
   │       ▼                                                            │
   │  tailscale (userspace) ──SOCKS5 :1055──▶  gpu-box:11434  ─────────────▶ your box
   │       ▲  joins tailnet via TS_AUTHKEY (a Mantle secret)            │   (over the
   └───────┼────────────────────────────────────────────────────────────┘    tailnet)
           │
   reads `tailscale status --json` → peer list + connection state
           │
           ▼
   "Local network" status tile + the machine dropdown
```

The only real code is the **per-route proxy dispatch**: a chat/vision/embedding
route marked "reach via tailnet" sends *its* fetch through the SOCKS proxy
(undici `ProxyAgent`, per request); every other call stays direct. A handful of
lines in the adapter layer — the same place the embedding adapter already
threads a per-route `baseUrl`.

---

## 5. What Mantle builds — and what it deliberately doesn't

**Builds (small, because Tailscale's own console does the hard parts):**

1. **One compose service** — `tailscale` (image `tailscale/tailscale`),
   userspace networking, exposes a SOCKS5 proxy (`tailscale:1055`), joins via
   `TS_AUTHKEY` fed from a Mantle secret, state in a small named volume.
2. **`lib/tailscale.ts`** — reads `tailscale status --json` from the container:
   connection state + peer list (name, online). Powers the status tile and the
   machine dropdown.
3. **A "Local network" settings section** — the auth-key secret field (with a
   help link to generate one) + a read-only "Connected · gpu-box online"
   status. Plus a tailnet tile in the dashboard `system-vitals`, reusing the
   existing service-health probe pattern.
4. **A per-route "reach via tailnet" toggle** — when set, the adapter proxies
   that route's fetch. This is the only behavioural change to the runtime.

**Deliberately does NOT build — a custom "add IPs" / network-management UI.**
You don't "add IPs" in Tailscale; machines join the tailnet and get addresses
automatically, and device approval, ACLs, and key rotation already live in
Tailscale's admin console (which is genuinely good and would take months to
half-replicate). The only thing Mantle needs from the operator is **one
secret** (the auth key); the only thing it needs to *configure* is which
tailnet host:port a route points at — and that's just the route's existing base
URL / the machine dropdown. So: lean on the Tailscale console + MagicDNS, build
a secret field and a status panel, and stop.

---

## 6. Locked decisions

- **Userspace Tailscale + SOCKS proxy** — not shared-namespace (which would
  break compose service DNS).
- **Self-host only** — the operator's VPS joins the operator's own tailnet.
  This sidesteps the managed-hosting complexity (see §7).
- **Auth key**, not interactive login — the headless VPS joins unattended from
  one pasted secret.
- **Peer dropdown** (machines by MagicDNS name) — the feature that keeps IPs out
  of the operator's life. Worth the small extra over a free-text host field.
- **No custom IP/network-management UI** — Tailscale's console owns that.

---

## 7. Self-host vs managed (why self-host first)

- **Self-host** (this design): clean and uncontroversial — your VPS, your
  tailnet, your inference box. An optional compose add-on.
- **Managed** (you run the VPS for a customer): now *your* infrastructure is
  joining the *customer's* private network (or vice versa). That's a real
  trust/security boundary that needs ACL tagging (restrict the VPS node to only
  `gpu-box:11434`, nothing else on their tailnet), an auth-key handling story,
  and per-tenant isolation. Doable, but a separate effort with real support
  surface — explicitly out of scope for v1.

---

## 8. Open questions (decide at build time)

- **SOCKS5 vs HTTP proxy** — SOCKS5 is simplest for arbitrary host:port; an HTTP
  proxy is an alternative. Lean SOCKS5.
- **Auth-key type** — a reusable, non-ephemeral key is simplest; an ephemeral
  key makes the VPS node drop off the tailnet on teardown (cleaner lifecycle,
  slightly more setup). Probably reusable for v1.
- **"Via tailnet" explicit vs inferred** — an explicit per-route toggle is
  clearest; auto-inferring it when a route's host matches a known peer name is
  cuter but more magic. Lean explicit.

---

## 9. Prerequisite / synergy

This is the *reach*; it needs a *thing to reach*. To run a local **chat** model
(the main use case), there also needs to be a **`local` chat adapter** —
OpenAI-compatible, reusing the `openai-compat` helpers + a per-route base URL,
the way [`local-embedding`](../packages/voice/src/adapters/local-embedding.ts)
already works. **(Shipped — see §0; [`local-chat.ts`](../packages/voice/src/adapters/local-chat.ts).)**
That adapter + this networking layer + the [chat primary/backup routes](./chat-failover.md)
together are the full "run your own models, hosted Mantle just uses them" story:

- **chat-failover** decides *which* model (local primary, cloud backup).
- **a local chat adapter** speaks to a self-hosted OpenAI-compatible server.
- **Tailscale** makes that server *reachable* from the cloud VPS.

A shared `lib/ollama.ts` (list / pull / health) could even manage models on the
*remote* tailnet box once it's reachable — one "local models" surface for the
embedder and the chat primaries alike.
