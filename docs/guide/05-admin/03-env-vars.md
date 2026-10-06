# Environment variables

These are the `.env` settings an operator sets or changes. The installer writes the required ones; everything else is configured in Jackdaw.

`.env` sits in the stack directory, next to `docker-compose.yml`. After you edit it, run `docker compose up -d` there so the changed containers restart. A change to `MANTLE_SERVER_ORIGIN` or `MANTLE_CLIENT_IMAGE_TAG` also needs the interface stack restarted, as in [Update Mantle](01-update.md). Keep your own changes in `.env`: an edited `docker-compose.yml` stops receiving release changes.

## Secrets (written once by the installer)

| Variable | What it is |
|---|---|
| `MANTLE_MASTER_KEY` | Encrypts stored API keys, passwords and secrets. Never change it on a running brain. Lose it and that data is gone. |
| `SESSION_SECRET` | Signs login sessions. |
| `POSTGRES_PASSWORD` | Database password. |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Object store credentials. |
| `MANTLE_SETUP_CODE` | The code sign-up asks for until the first account exists. `scripts/install.sh --setup-code` prints it. |

## Address and network

| Variable | What it does |
|---|---|
| `MANTLE_SITE_ADDRESS` | The hostname the front door serves, for example `brain.example.com`. A hostname gets HTTPS automatically. |
| `MANTLE_PUBLIC_URL` | The full public address, for example `https://brain.example.com`. Used in share and email links. |
| `MANTLE_SERVER_ORIGIN` | The address Jackdaw uses to reach the API. Usually the same as `MANTLE_PUBLIC_URL`. |
| `MANTLE_BIND_ADDR` | Network interface for ports 80 and 443. `127.0.0.1` keeps the brain off the network. Default `0.0.0.0`. |
| `MANTLE_HTTP_PORT`, `MANTLE_HTTPS_PORT` | Host ports for the front door. Default 80 and 443. HTTPS certificates need the real 80 and 443. |
| `MANTLE_WEB_DEBUG_PORT` | Loopback-only debug port. Default 3000. Change it if something else holds 3000. |
| `MANTLE_TRUSTED_PROXIES` | Proxy hops in front of Mantle, for correct client addresses. Default 1. Raise it if you add a proxy before Caddy. |
| `MANTLE_API_CORS_ORIGINS` | Extra origins allowed to call the API, comma separated. Empty means same origin only. |

To change the domain, run `scripts/install.sh --domain <host>` instead of editing these by hand. See [Add a domain and HTTPS](../01-install/03-domain-https.md).

## Stack

| Variable | What it does |
|---|---|
| `MANTLE_STACK_DIR` | Full path of the stack directory. The updater needs it. |
| `MANTLE_DATA_DIR` | Where all state is stored. Default `./data`. |
| `MANTLE_IMAGE_TAG` | Server version. `latest`, or a release tag to stay on one version. |
| `MANTLE_CLIENT_IMAGE_TAG` | Jackdaw interface version. The updater sets it. |
| `MANTLE_CLIENT_ENABLED` | `0` runs no Jackdaw interface on the box (headless). Missing means on. |
| `COMPOSE_PROFILES` | Optional services: `sandboxes`, `media`, `local-embedder`, `helpers`. Prefer **Settings > Services**. |
| `COMPOSE_FILE` | Set by `--core` for the small core shape. |
| `SANDBOXD_TOKEN`, `MEDIA_SIDECAR_TOKEN` | Tokens for the sandbox and media services. Written for you. |

## Updater

| Variable | What it does |
|---|---|
| `MANTLE_PRE_ROLL_BACKUP` | `0` skips the backup before each update. Take your own then. |
| `MANTLE_PRE_ROLL_KEEP` | How many pre-update backups to keep. Default 3. |
| `MANTLE_IMAGE_PRUNE` | `0` keeps old images after an update. By default they are removed. |

## Next

- [Optional services](04-services.md)
- [Security](10-security.md)
