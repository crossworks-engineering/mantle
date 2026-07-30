# Mantle Desktop — Electron plan

Status: **Phase 1 built and verified** (branch `feat/mantle-electron`,
`client/desktop`). The shell now embeds the standalone `next build` of
`client/web` (staged by `build:ui`, run as a `utilityProcess` on a sticky
loopback port — sticky because localStorage is origin-scoped) and needs no
dev server. Verified 2026-07-30 against the hermetic e2e stack: login, SSE,
dashboard, and relaunch-after-abrupt-kill all pass on the embedded build.
Phase 0 (dev-server renderer) verified the same day: probe → bearer login →
SSE → preflighted `Idempotency-Key` POST → multipart upload + `?at=` image →
partition persistence. Side find: the login bounce could deadlock when an
abrupt shutdown dropped the presence cookie but kept the token — fixed in
`client/web` (bounce re-asserts presence), plus the shell flushes the cookie
store on window close. Real model turns aren't testable on the e2e stack
(dummy LLM key by design). Nothing ships yet.

## Goal

A desktop app that carries the owner UI (`client/web`) out of the browser. First
run asks for a **server URL**, then the normal **login** — the same
split-frontend flow `pnpm dev:fe` uses today, wrapped in a window that can grow
desktop-only powers (deep links, notifications, tray, auto-update).

## Why this is easier than it sounds

`client/web` was carved as a zero-secret client on purpose, and the audit
(2026-07-30) confirms the hard part is already done:

- **No server-side data path.** Zero server actions, zero `/api` proxy routes.
  Every screen is client-fetched through `packages/web-ui/src/api-fetch.ts`,
  which resolves the API base and bearer token *at call time*.
- **Auth already has the desktop branch.** `login-form.tsx` branches on
  `isCrossOrigin()`: cross-origin → `POST /api/auth/token` → bearer in
  `localStorage`, refresh via `token-refresh.ts`. An Electron renderer is always
  cross-origin, so this is exactly the path we ride.
- **Streaming is Electron-safe.** No WebSockets, no `EventSource` — SSE is a
  fetch-based reader with bearer auth, resume and backoff. No service workers.
- **Runtime origin injection already exists.** The UI reads
  `window.__MANTLE_ENV__` (today emitted by the `/env.js` route). The shell just
  injects that object itself with the user-chosen server URL.

The Next *server* is used for exactly four small things. Phase 1's
embedded-standalone shape resolved them more cheaply than replacing them:

| Today | Desktop resolution (as built) |
| --- | --- |
| `app/env.js/route.ts` emits `window.__MANTLE_ENV__` | preload injects it (read-only); the served `/env.js` is neutralized by the shell |
| root layout SSRs brain appearance (`headers()`, `force-dynamic`) | works — the embedded server gets `MANTLE_SERVER_ORIGIN` at spawn (multi-brain: later windows SSR the first brain's branding, cosmetic only) |
| `(app)/layout.tsx` reads two nav-collapse `cookies()` | works — real server, real cookies |
| `middleware.ts` login redirect (UX-only, spoofable by design) | works unchanged |

These become real work only if Phase 3's static-export shape ever happens.

## Architecture decision

**Bundle the built `client/web` inside Electron; talk straight to the brain.**
No wrapper-around-the-website (that would keep the UI tied to each box) and no
API proxy in the main process (bearer + CORS direct fetch is the design).

How the renderer is served — two candidates, phased:

1. **Phase 1: embedded Next standalone.** `next build` (standalone output) run
   inside the app via `utilityProcess` on `127.0.0.1:<port>`. Near-zero changes
   to `client/web`; all 16 dynamic `[id]` segments keep working. Cost: ships a
   Node server in the app, and the renderer origin is a localhost port.
2. **Later, optional: static export + `app://` scheme.** `output: 'export'`
   served by a custom protocol handler. Cleaner and lighter, but requires
   reshaping all 16 dynamic segments to query-param screens (several, like
   `/n/[id]`, already redirect that way). Only worth it once the desktop app
   has proven itself.

### CORS: do what the mobile companion does — be a native client

The worry was `gate.ts` refusing `*` on `/api/auth*`. But the gate never
*rejects* a request by Origin — it only decides whether to emit
`Access-Control-Allow-Origin` headers, and `corsOrigin()` short-circuits when
no `Origin` header is present (`gate.ts:61`, "same-origin / non-browser — no
CORS needed"). CORS is *browser*-enforced; the credential is the bearer token.
That's why the Flutter companion needs zero CORS setup: native HTTP sends no
`Origin`, so the question never arises.

Electron is a native client too — it just embeds Chromium, which self-enforces
CORS inside the renderer. So the desktop app fences **its own** network layer,
scoped strictly to the user-configured brain origin:

- `webRequest.onBeforeSendHeaders`: drop `Origin` on requests to the brain
  (the app declares itself native, which it is);
- `webRequest.onHeadersReceived`: add the ACAO headers to the brain's
  responses so the embedded renderer accepts them.

**Zero server changes; works against every existing box in the fleet today**,
including boxes that will never set `MANTLE_API_CORS_ORIGINS`. Nothing about
the server's browser-facing gate is weakened — a real browser tab still can't
do any of this; the fencing exists only inside the app the user installed and
pointed at their own brain. This is the same trust stance as the companion.

The honest-CORS alternative (allowlist a canonical `app://` origin by default,
server-side) stays on the table for Phase 3's static-export shape, but it only
helps boxes running a new-enough server — fleet skew makes it a worse default
than native parity.

## Shell design

New workspace package **`client/desktop`**:

```
client/desktop/
  src/main/       # app lifecycle, window, server profiles, embedded renderer serving
  src/preload/    # contextBridge: __MANTLE_ENV__ injection + desktop API surface
  src/connect/    # the entry screen: pick/add a brain (tiny static page, no Next)
  electron.vite.config.ts
  package.json
```

- **Stack (latest, checked 2026-07-30):** Electron 43, electron-vite 5,
  electron-builder 26 + electron-updater 6 (auto-update from GitHub releases,
  which tag-pushes already produce). TypeScript throughout.
- **Entry flow:** connect screen lists saved brains + "add brain" (URL field →
  probe `/api/auth/bootstrap-state`, show name/appearance) → window loads the
  bundled UI with `__MANTLE_ENV__.apiBase` set → existing login page →
  bearer in that profile's storage.
- **Multi-brain from day one, cheaply:** one Electron `session` partition per
  server profile (`persist:<origin-hash>`) — token, cookies and caches isolated
  per brain for free.
- **Security posture:** `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`; navigation locked to the app origin; every external
  link through `shell.openExternal`; keep the token in `localStorage` (same
  threat model as the web) with an eye on `safeStorage` later.
- **Version skew:** bundled UI no longer matches the box by construction. On
  connect, read the server version and gate on a minimum; surface "brain is
  newer/older" in the connect screen.

## What the mobile companion already proved (audit 2026-07-30)

`~/Projects/mantle-companion` is the existence proof that a detached native
client works against the fleet, and it hands us the patterns:

- **Connect flow**: single URL field → probe `GET /api/version` (10s timeout,
  require `200` + a `version` key) → persist only on success, with one
  plain-language error otherwise. Copy verbatim.
- **Three-state session gate**: `needsServer | loggedOut | loggedIn` is the
  *only* input to routing; screens mutate state, the router follows. Maps
  cleanly onto the desktop shell's window/route guard.
- **Config vs secret split**: server URL in plain local config; token in the
  OS keychain (desktop: `safeStorage`), attached per-request by one
  interceptor with a `skipAuthHandler` opt-out for the login call itself.
- **Auth-failure contract**: treat **401 OR a 3xx redirecting to `/login`** as
  session-invalid (revoked-but-unexpired tokens surface as the latter). Fetch
  must use `redirect: 'manual'` or the login HTML arrives as a 200.
- **Authed assets**: mobile fetches bytes through the authed client and renders
  from memory — no token-in-URL. Desktop can do better with a header-attaching
  protocol/webRequest hook, or keep the web client's `?at=` flow; either way
  the pattern is proven.
- **Skew posture**: degrade, don't die — schema-version guard on the turn
  stream, 404 = feature-dark fallback, unknown enums default safe.

Deltas we deliberately do *not* inherit: no multi-server profiles (mobile's
"change server" wipes the URL but leaks the old token to the new brain — key
tokens by profile instead); no scheme auto-prefix on the URL input; no expiry
tracking (mobile holds a 1-year token; desktop rides the web path —
`POST /api/auth/token`, 30-day TTL, refresh <7 days out — which `web-ui`
already implements); no version comparison despite fetching `/api/version`.

## Known port gotchas (from the audit)

- **`assetUrl()` `?at=` tokens** — images/iframes/downloads can't carry the
  bearer header cross-origin; the short-lived query token flow must be verified
  in Electron early (it's the first thing that 401s in detached dev).
- **`/app-runtime/*` needs `ACAO: *`** for the mini-app sandbox iframes — today
  emitted by Next `headers()` config; the embedded-standalone path keeps it,
  the static path needs the protocol handler to add it.
- **Microsoft OAuth** — `settings/microsoft/microsoft-client.tsx` uses a
  *relative* `/api/microsoft/oauth/start` href (broken in any split client, not
  just Electron) and the redirect round-trip lands on the server origin. Needs
  `serverUrl()` + an external-browser flow. Deferred past Phase 1.
- **Deep links** — register `mantle://` and map `mantle://n/<id>` to the
  in-app permalink route.
- **Dockerfile COPY drift** — adding the `client/desktop` workspace package
  means updating the manifest COPY list in `Dockerfile` or CI fails at tag
  time.

## Phases

**Phase 0 — spike (this branch).** Scaffold `client/desktop`; connect screen;
preload-injected env; in dev, point the window at `next dev` on :3001 against
the test box. Exit criteria: enter URL → log in → chat with a streaming
response → an inline image renders (`?at=` proven) → relaunch keeps the
session.

**Phase 1 — bundled renderer.** Embedded Next standalone via `utilityProcess`;
the four Next-server replacements above; CORS decision (A/B) implemented
server-side; version-skew gate.

**Phase 2 — being a desktop app.** Built 2026-07-30: `mantle://` deep links
(cold start + running, all three OS activation paths), OS notifications via
the `DesktopBridge` component in `client/web` (assistant outbound pings →
notification while hidden; badge API exposed, not yet wired), tray,
auto-update (electron-updater on GitHub releases — background download,
notify, install on quit), and electron-builder packaging (Linux
AppImage/deb, mac dmg/zip, win nsis) with `desktop.yml` publishing to a
draft release on the same `v*` tags as the images. Known gaps: macOS builds
unsigned (no notarisation creds in CI yet → no mac self-update), and the
mac/win CI legs are untested until the first tag build.

**Phase 3 — optional slimming.** Static export + `app://` scheme (drop the
embedded Node server); Microsoft OAuth desktop flow; `safeStorage` token
encryption.

## Open questions for Jason

1. CORS: native-parity fencing (strip `Origin`/inject ACAO inside the app,
   scoped to the configured brain) is the recommendation — zero server changes,
   whole fleet works day one. Sign off, or prefer the server-side canonical
   origin allowlist despite the version-skew cost?
2. Is multi-brain a v1 feature or a nice-to-have? (Partitions make it cheap
   either way.)
3. Auto-update from public GitHub releases — comfortable with the desktop app
   updating on tag-push cadence, or should it trail manually?
4. Appetite for the Phase 3 route reshaping, or is the embedded server an
   acceptable permanent shape?
