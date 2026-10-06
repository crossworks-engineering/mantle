# Install options

Each optional part can be chosen at install time or changed later with the configurator, `scripts/install.sh`.

| Option | Default | Change later | One-liner variable |
|---|---|---|---|
| Small core shape | Off (offered under 6 GB RAM) | `--core`, `--no-core` | `MANTLE_CORE=1` |
| Doc helpers (core only) | Off | `--helpers`, `--no-helpers` | `MANTLE_HELPERS=1` |
| CLI sandboxes | On (off on core) | `--sandboxes`, `--no-sandboxes` | `MANTLE_SANDBOXES=0` or `1` |
| Local embedder | Off | `--local-embedder`, `--no-local-embedder` | `MANTLE_LOCAL_EMBEDDER=1` |
| Owner web UI | On | `--client`, `--no-client` | `MANTLE_CLIENT=0` |
| Media (video and CAD) | Off | see below | none |

Run the flags from the install directory. For example: `cd mantle && bash scripts/install.sh --no-sandboxes`. The installer keeps how the brain is reached (domain, this machine only, or the network) and every component you do not name. On a running brain, **Settings > Services** switches sandboxes, media, the local embedder and the doc helpers without the terminal. See [Optional services](../05-admin/04-services.md).

## Silent install

`MANTLE_YES=1` skips every question and takes the defaults: plain HTTP on port 80 across the network, full shape, sandboxes on, online embeddings, UI on. Pass variables with the `bash -c` form, because `curl ... | bash` does not hand them to the installer:

```bash
MANTLE_YES=1 MANTLE_SANDBOXES=0 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh)"
```

Other variables the one-liner reads:

| Variable | Effect |
|---|---|
| `MANTLE_DOMAIN` | Serve this domain with HTTPS ([details](05-domain-https.md)) |
| `MANTLE_HOME` | Install directory (default `./mantle`) |
| `MANTLE_CHANNEL` | Release tag to install (default: the latest release) |
| `MANTLE_SKIP_START=1` | Write the files and `.env`, but do not start anything |

## CLI sandboxes

Isolated containers where the coder agent runs code and builds apps. Nothing is installed on the host. See [sandboxes.md](../../sandboxes.md).

## Local embedder

Indexes your text on the server instead of through an online model. It needs a large server: it slows a 16 GB, 8-core box under heavy ingest. After you turn it on, choose the `local` provider in **Settings > Embedding**. See [Local models](../05-admin/06-local-models.md).

## Media

Turns on transcripts from video and audio links, and CAD drawings (DWF, DWG, DXF). Switch it on in **Settings > Services**, or by hand:

1. In `mantle/.env`, add `media` to `COMPOSE_PROFILES`, keeping what is already there (for example `COMPOSE_PROFILES=sandboxes,media`).
2. If `.env` has no `MEDIA_SIDECAR_TOKEN`, add one made with `openssl rand -hex 32`.
3. Start it:

   ```bash
   cd mantle && docker compose --profile media up -d --wait
   ```

## No owner UI (headless)

`--no-client` runs the API, MCP and share pages only. There is no sign-up screen on the server, so finish setup in one of two ways:

- In the [desktop app](09-desktop-app.md): connect it to the brain's address and sign up with the setup code.
- On the server: run `bash scripts/onboard.sh` in the install directory and answer its prompts.

## Other flags

| Flag | Effect |
|---|---|
| `--data-dir <path>` | Where all data is stored (default `./data`) |
| `--image-tag <tag>` | Pin the server version |
| `--skip-up` | Write `.env` only |
| `--setup-code` | Print the setup code again |
| `--check` | Run the health check only |

`bash scripts/install.sh --help` lists every flag.

## Next

- [Install without the script](08-manual.md)
- [Environment variables](../05-admin/03-env-vars.md)
