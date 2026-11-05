# Environment variables

This page maps the `.env` settings an operator most often sets or changes. The installer writes the required ones, and most other things are set in the app.

`.env` sits in the stack directory, next to `docker-compose.yml`. After you edit it, run `docker compose up -d` there so the changed containers restart. A change to `MANTLE_SERVER_ORIGIN` or `MANTLE_CLIENT_IMAGE_TAG` also needs the interface stack restarted, as in [Update MantleOS](01-update.md). Keep your changes in `.env`: an edited `docker-compose.yml` stops receiving release changes.

The full list, with a note on each setting, is the template [`.env.prod.example`](../../../.env.prod.example). Every variable the server reads is named in [Configuration](../../configuration.md), and the installer's flags are in [Install options](../01-install/07-options.md).

## Secrets (written once by the installer)

| Variable                         | What it is                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MANTLE_MASTER_KEY`              | Encrypts stored API keys, passwords and secrets. Never change it on a running brain. Lose it and that data is gone. |
| `SESSION_SECRET`                 | Signs login sessions.                                                                                               |
| `POSTGRES_PASSWORD`              | Database password.                                                                                                  |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Object store credentials.                                                                                           |
| `MANTLE_SETUP_CODE`              | The code sign-up asks for until the first account exists. `scripts/install.sh --setup-code` prints it.              |

## Address and network

| Variable                                | What it does                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `MANTLE_SITE_ADDRESS`                   | The hostname the brain answers on. A hostname gets HTTPS automatically.                                     |
| `MANTLE_PUBLIC_URL`                     | The full public address, used in share and email links.                                                     |
| `MANTLE_SERVER_ORIGIN`                  | The address the web app uses to reach the API. Usually the same as `MANTLE_PUBLIC_URL`.                     |
| `MANTLE_BIND_ADDR`                      | `127.0.0.1` keeps the brain off the network. Default `0.0.0.0`.                                             |
| `MANTLE_HTTP_PORT`, `MANTLE_HTTPS_PORT` | Host ports for the front door. Default 80 and 443, which HTTPS certificates need.                           |
| `MANTLE_WEB_DEBUG_PORT`                 | Loopback-only debug port, default 3000. Change it if something else holds 3000.                             |
| `MANTLE_TRUSTED_PROXIES`                | Proxy hops in front of MantleOS, default 1. Raise it if you add a proxy in front of Caddy (the front door). |

To change the domain, run `scripts/install.sh --domain <host>` instead of editing these by hand. See [Add a domain and HTTPS](../01-install/05-domain-https.md).

## Stack

| Variable                  | What it does                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANTLE_STACK_DIR`        | Full path of the stack directory. The updater needs it.                                                                                                                                         |
| `MANTLE_DATA_DIR`         | Where all state is stored. Default `./data`.                                                                                                                                                    |
| `MANTLE_IMAGE_TAG`        | Server version: `latest`, or a release tag to stay on one version.                                                                                                                              |
| `MANTLE_CLIENT_IMAGE_TAG` | Web app version. The updater sets it.                                                                                                                                                           |
| `MANTLE_CLIENT_ENABLED`   | `0` runs no web app on the box. Missing means on.                                                                                                                                               |
| `COMPOSE_PROFILES`        | Optional services. Prefer **Settings > Services** ([Optional services](04-services.md)).                                                                                                        |
| `MANTLE_RUNTIME`          | What runs web, api and the workers. `bun` runs them on Bun; `node`, or no value, on Node, the fallback. Any other word stops them at start, and the updater refuses to update until you fix it. |
| `PARSER_MEM_LIMIT`        | Memory for the parser, which reads every uploaded file (default `2g`). Raise it for very large drawing sets.                                                                                    |

To move a box to Bun, set `MANTLE_RUNTIME=bun` and run `docker compose up -d`. `scripts/install.sh --check` then shows `runtime: bun`. Detail: [Running a box on Bun](../../update-prod.md#running-a-box-on-bun).

## Company sign-in (optional)

Off unless set. `MANTLE_OIDC_MODE` is `off` (default), `optional` or `required`. `MANTLE_OIDC_ISSUER`, `MANTLE_OIDC_CLIENT_ID` and `MANTLE_OIDC_CLIENT_SECRET` name the provider. The other settings and the set-up are in [docs/oidc-sign-in.md](../../oidc-sign-in.md). What people see: [Add users](07-logins.md#let-people-sign-in-with-their-company-account).

## SCIM (optional)

Off unless set. `MANTLE_SCIM_TOKEN_HASH` is the sha256 of the token the company's directory sends; make both with `pnpm -C server/web scim-token`, and give the token to the directory, never to `.env`. Empty: the SCIM routes answer 404. `MANTLE_SCIM_AUTO_LINK=on` (off by default; needs SCIM and company sign-in on) lets a person whose login the directory made sign in with the company account at once. Set-up: [docs/scim.md](../../scim.md). What it does: [Add users](07-logins.md#let-the-companys-directory-add-and-remove-people).

## MCP connector

`MANTLE_MCP_TOOL_MAP=1` gives every MCP connection the short tool list, the tool map. `MANTLE_MCP_TERMINAL=1` offers the shell tool over the network connector, to Admin users only. See [Connect Claude over MCP](../07-api/01-connect-claude.md#list-fewer-tools-the-tool-map).

## Updater

| Variable                 | What it does                                                       |
| ------------------------ | ------------------------------------------------------------------ |
| `MANTLE_PRE_ROLL_BACKUP` | `0` skips the backup before each update. Take your own then.       |
| `MANTLE_PRE_ROLL_KEEP`   | How many pre-update backups to keep. Default 3.                    |
| `MANTLE_IMAGE_PRUNE`     | `0` keeps old images after an update. By default they are removed. |

## Box policy

Rules for a company box. Nobody can change them from the app; **Settings** shows them read only. Empty means no rule. See [Security](10-security.md#box-policy).

| Variable                       | What it does                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `MANTLE_POLICY_TELEGRAM`       | `off` switches Telegram off. The bots and chats are kept.                                           |
| `MANTLE_POLICY_EMAIL_SEND`     | `off` stops sending from the box's mail accounts. Reading and syncing still work.                   |
| `MANTLE_POLICY_MODEL_DENY`     | Models nothing may use, for example `deepseek/*,qwen/*`. Auto routers are blocked too.              |
| `MANTLE_POLICY_PROVIDER_ALLOW` | The only providers anything may use, for example `foundry,local`.                                   |
| `MANTLE_POLICY_ENDPOINT_ALLOW` | With a provider list: the servers a model route may name. Empty: the box's own endpoints only.      |
| `MANTLE_POLICY_PASSWORD_MIN`   | The shortest password allowed (8 to 64). A person whose password is too weak changes it at sign-in. |

## Next

- [Optional services](04-services.md)
- [Security](10-security.md)
