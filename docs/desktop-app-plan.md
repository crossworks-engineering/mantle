# Mantle Desktop — Electron plan

Status: **planning** (branch `feat/mantle-electron`). Nothing here ships yet.

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

The Next *server* is used for exactly four small things, each with a contained
replacement:

| Today | Desktop replacement |
| --- | --- |
| `app/env.js/route.ts` emits `window.__MANTLE_ENV__` | preload injects it from the chosen server profile |
| root layout SSRs brain appearance (`headers()`, `force-dynamic`) | client-side fetch (accept one paint flash) |
| `(app)/layout.tsx` reads two nav-collapse `cookies()` | `localStorage` |
| `middleware.ts` login redirect (UX-only, spoofable by design) | client-side route guard |

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

### The one real constraint: CORS on auth paths

`server/web/server/middleware/gate.ts` **refuses `*` on `/api/auth*`** — a
deliberate gate we keep. A shipped desktop app can't ask every owner to
hand-edit `MANTLE_API_CORS_ORIGINS`, so the brain must recognise the desktop
app by default. Options, safest first (Jason decides):

- **A. Ship a canonical desktop origin in the default allowlist** (e.g.
  `app://mantle-desktop`), the way mobile apps are recognised today. The shell
  normalises its outgoing `Origin` to that value for requests to the configured
  brain only. Opt-out env stays available. CORS still does its real job:
  browsers can't fake this origin.
- B. Per-box opt-in (`MANTLE_DESKTOP=1`) that enables the origin — safer-sounding
  but adds an install step to every box, which is an onboarding edge (a
  first-class bug by our own rules).
- C. Leave it manual (dev-only posture) for the spike; decide A/B before any
  release.

Phase 0 runs with C against the test box (its allowlist already carries the
localhost origins).

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

**Phase 2 — being a desktop app.** `mantle://` deep links, native
notifications (realtime SSE → OS notifications), tray + badge, auto-update,
packaging matrix (Linux AppImage/deb, macOS dmg + notarisation, Windows nsis)
in CI beside the image builds.

**Phase 3 — optional slimming.** Static export + `app://` scheme (drop the
embedded Node server); Microsoft OAuth desktop flow; `safeStorage` token
encryption.

## Open questions for Jason

1. CORS recognition: option **A** (default-allow the canonical desktop origin)
   is my recommendation — same trust stance as the mobile token flow — but it
   widens the default surface, so it's your call.
2. Is multi-brain a v1 feature or a nice-to-have? (Partitions make it cheap
   either way.)
3. Auto-update from public GitHub releases — comfortable with the desktop app
   updating on tag-push cadence, or should it trail manually?
4. Appetite for the Phase 3 route reshaping, or is the embedded server an
   acceptable permanent shape?
