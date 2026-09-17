# Mantle Desktop

The owner UI as a native app. It carries the full web client (`jackdaw`)
inside an Electron shell, points it at whichever brain you choose, and adds
the things a browser tab can't: OS notifications, `mantle://` deep links, a
tray, and auto-update. Design history and decisions:
[desktop-app-plan.md](_archive/desktop-app-plan.md). The desktop shell's
source and developer docs live in the
[jackdaw repo](https://github.com/crossworks-engineering/jackdaw) (its
`client/desktop` package), not in this repo.

## Install

Installers are attached to each
[jackdaw GitHub release](https://github.com/crossworks-engineering/jackdaw/releases):
a Debian package and AppImage for Linux, an arm64 dmg and zip for macOS, and a
Windows installer, built by CI on the jackdaw tag (its own version stream; the
server release that pairs with it is recorded in the mantle repo's
`client-pair.tag`). macOS builds are currently unsigned (Gatekeeper will ask
for a right-click → Open on first launch, and self-update is disabled there
until signing lands).

## First run

1. Enter your brain's URL, the same address you open in the browser. The
   app probes it (`GET /api/version`) before saving, so a typo fails with a
   message rather than a broken profile.
2. Log in with your normal owner credentials. The app mints its own device
   token (it shows up under Settings → devices like any other login and can
   be revoked there).

That's it, **no server configuration**. The desktop app is a native client
like the mobile companion: it authenticates with a bearer token, and no
`MANTLE_API_CORS_ORIGINS` entry is needed on any box.

Each saved brain keeps its own isolated login; switch with **Brain → Switch
Brain…** (Ctrl/Cmd+Shift+B). Relaunching returns to the last brain you used,
still signed in.

## Security model

- **The token never sits on disk in plaintext.** It's encrypted with the OS
  keychain (macOS Keychain, Windows DPAPI, Linux libsecret) via Electron's
  `safeStorage`; on Linux systems with no keychain it falls back to a
  user-only file, the same posture a browser's localStorage had, never
  worse.
- **The shell holds no secrets of its own**: the saved-brain list is plain
  config; enforcement lives entirely in the server's 401s, exactly as in the
  browser.
- Renderer windows are sandboxed with context isolation; external links open
  in your system browser, never inside the app.
- A 30-day token with automatic rotation (the web client's refresh path),
  an actively used app never expires; a revoked device bounces to login.

## Notifications and deep links

While the window is hidden, assistant replies surface as OS notifications;
clicking one focuses the app. `mantle://` links (for example `mantle://n/<id>`,
the permalink form responders embed) open the app directly to that item in
your current brain.

## Updates

The app checks the project's GitHub releases, downloads updates in the
background, and tells you once, the update installs when you quit. It never
restarts itself. The connect screen shows each brain's server version next
to the app's own, so version skew is visible at a glance; mismatched pairs
degrade per-feature rather than failing (older brains simply don't offer the
newer endpoints).

## Troubleshooting

- **"Couldn't reach a Mantle server at …"**: the probe hits
  `<url>/api/version`; check the URL works in a browser and that the box is
  up. A bare hostname gets `https://` prefixed automatically.
- **Stuck at login after a crash**: shouldn't happen (the login page
  self-heals a lost presence cookie since 0.215.0); if it does, sign in
  again; the session was local, nothing server-side changed.
- **The app UI fails to load at all**: the embedded UI server may have been
  built for another platform or be missing; reinstall, or for a jackdaw source
  checkout run `pnpm -C client/desktop build:ui` there first.
