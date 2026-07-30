# Mantle Desktop

Electron shell around the owner UI. Design + phasing: [docs/desktop-app-plan.md](../../docs/desktop-app-plan.md).

The shell ships the connect screen, per-brain session partitions, the
native-parity CORS fencing, and an **embedded copy of the built owner UI** —
the standalone `next build` of `client/web`, run as a `utilityProcess` on a
sticky loopback port (sticky because localStorage — and the bearer in it — is
origin-scoped; a changing port would log everyone out).

## Run it

```sh
pnpm -C client/desktop build:ui   # build client/web standalone → client/desktop/ui/
pnpm -C client/desktop dev        # the Electron shell
```

The connect screen asks for your brain's URL (probes `GET /api/version` before
saving), then the window loads the UI pointed at that brain — log in as usual;
the bearer lands in the profile's own persisted session partition, so each
brain keeps its own login and a relaunch goes straight back in.

For UI iteration without rebuilding, `MANTLE_DESKTOP_RENDERER_URL` points the
shell at a `client/web` dev server instead of the embedded copy
(e.g. `pnpm dev:fe -- --port 3001`, then set it to `http://localhost:3001`).

## Packaging

```sh
pnpm -C client/desktop build:ui   # always first — the package embeds ui/
pnpm -C client/desktop dist       # AppImage + deb on Linux; dmg/zip on mac; nsis on Windows
```

CI (`.github/workflows/desktop.yml`) builds all three OSes on the same `v*`
tags as the image release and uploads installers to a **draft** GitHub
release — publishing stays a human act. Auto-update (electron-updater) checks
the published releases, downloads in the background, notifies once, and
installs on quit — never a surprise restart. macOS artifacts are unsigned
until Apple credentials land in CI; electron-updater won't self-update an
unsigned mac build.

## Desktop integration

- **Deep links**: `mantle://n/<id>` (or any `mantle://<path>`) opens the
  in-app route in the current/last-used brain window.
- **Notifications**: the UI's `DesktopBridge`
  (`client/web/components/desktop/desktop-bridge.tsx`) feature-detects
  `window.mantleDesktop` and forwards assistant outbound pings
  (`/api/assistant/stream`) to OS notifications while the window is hidden.
  Clicking one focuses the app.
- **Tray**: open / switch brain / quit. A badge API (`setBadge`) is exposed
  for later wiring.

## What the shell does (and doesn't)

- **Native-parity CORS fencing**, scoped to the configured brain origin only:
  outgoing `Origin` dropped (a native client sends none — same stance as the
  mobile companion), ACAO injected on responses so the embedded renderer
  accepts them. No server-side CORS setup needed on any box.
- **`window.__MANTLE_ENV__` injection** via preload (read-only), with the dev
  server's `/env.js` neutralized so the user's chosen brain always wins.
- **No secrets in the shell.** The server URL list (`profiles.json` in
  userData) is config; tokens live only in the per-profile partition.
- External links (share links, docs) open in the system browser.
