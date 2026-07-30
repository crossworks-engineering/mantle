# Mantle Desktop (Phase 0)

Electron shell around the owner UI. Design + phasing: [docs/desktop-app-plan.md](../../docs/desktop-app-plan.md).

Phase 0 loads the UI from the `client/web` **dev server** — the shell itself
only ships the connect screen, the per-brain session partitions, and the
native-parity CORS fencing. Phase 1 embeds the built UI.

## Run it

Two terminals from the repo root:

```sh
pnpm dev:fe -- --port 3001     # the owner UI, detached (see docs/db-less-dev.md)
pnpm -C client/desktop dev     # the Electron shell
```

The connect screen asks for your brain's URL (probes `GET /api/version` before
saving), then the window loads the UI pointed at that brain — log in as usual;
the bearer lands in the profile's own persisted session partition, so each
brain keeps its own login and a relaunch goes straight back in.

`MANTLE_DESKTOP_RENDERER_URL` overrides where the shell looks for the UI
(default `http://localhost:3001`).

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
