# Environment variables

These are the `.env` settings an operator sets or changes. The installer writes the required ones; everything else is configured in the app.

`.env` sits in the stack directory, next to `docker-compose.yml`. After you edit it, run `docker compose up -d` there so the changed containers restart. A change to `MANTLE_SERVER_ORIGIN` or `MANTLE_CLIENT_IMAGE_TAG` also needs the interface stack restarted, as in [Update MantleOS](01-update.md). Keep your own changes in `.env`: an edited `docker-compose.yml` stops receiving release changes.

## Secrets (written once by the installer)

| Variable                         | What it is                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MANTLE_MASTER_KEY`              | Encrypts stored API keys, passwords and secrets. Never change it on a running brain. Lose it and that data is gone. |
| `SESSION_SECRET`                 | Signs login sessions.                                                                                               |
| `POSTGRES_PASSWORD`              | Database password.                                                                                                  |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Object store credentials.                                                                                           |
| `MANTLE_SETUP_CODE`              | The code sign-up asks for until the first account exists. `scripts/install.sh --setup-code` prints it.              |

## Address and network

| Variable                                | What it does                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANTLE_SITE_ADDRESS`                   | The hostname the brain answers on, for example `brain.example.com`. A hostname gets HTTPS automatically.                                          |
| `MANTLE_PUBLIC_URL`                     | The full public address, for example `https://brain.example.com`. Used in share and email links.                                                  |
| `MANTLE_SERVER_ORIGIN`                  | The address the web app uses to reach the API. Usually the same as `MANTLE_PUBLIC_URL`.                                                           |
| `MANTLE_BIND_ADDR`                      | Network interface for ports 80 and 443. `127.0.0.1` keeps the brain off the network. Default `0.0.0.0`.                                           |
| `MANTLE_HTTP_PORT`, `MANTLE_HTTPS_PORT` | Host ports for the built-in web server. Default 80 and 443. HTTPS certificates need the real 80 and 443.                                          |
| `MANTLE_WEB_DEBUG_PORT`                 | Loopback-only debug port. Default 3000. Change it if something else holds 3000.                                                                   |
| `MANTLE_TRUSTED_PROXIES`                | Proxy hops in front of MantleOS, for correct client addresses. Default 1. Raise it if you add a proxy in front of Caddy, the built-in web server. |
| `MANTLE_API_CORS_ORIGINS`               | Extra origins allowed to call the API, comma separated. Empty means same origin only.                                                             |

To change the domain, run `scripts/install.sh --domain <host>` instead of editing these by hand. See [Add a domain and HTTPS](../01-install/05-domain-https.md).

## Company sign-in (optional)

Off unless set. Off, the sign-in screen and passwords stay exactly as they are. See [docs/oidc-sign-in.md](../../oidc-sign-in.md).

| Variable                                             | What it does                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANTLE_OIDC_MODE`                                   | `off` (default), `optional` (passwords keep working; people may link a company account) or `required` (a linked login uses company sign-in only). |
| `MANTLE_OIDC_ISSUER`                                 | The provider's issuer URL. Any OpenID Connect provider.                                                                                           |
| `MANTLE_OIDC_CLIENT_ID`, `MANTLE_OIDC_CLIENT_SECRET` | The client registered with the provider. Its redirect URI is `MANTLE_PUBLIC_URL` plus `/api/auth/oidc/callback`.                                  |
| `MANTLE_OIDC_LABEL`                                  | The button's word. Default `Single sign-on`.                                                                                                      |
| `MANTLE_OIDC_SESSION_HOURS`                          | How long a company sign-in session lasts. Default 12.                                                                                             |
| `MANTLE_OIDC_OUTSIDE`                                | An admin may mark outside people, who keep their passwords in required mode. Default on; `off` refuses the marks.                                 |

## Stack

| Variable                         | What it does                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MANTLE_STACK_DIR`               | Full path of the stack directory. The updater needs it.                                                      |
| `MANTLE_DATA_DIR`                | Where all state is stored. Default `./data`.                                                                 |
| `MANTLE_IMAGE_TAG`               | Server version. `latest`, or a release tag to stay on one version.                                           |
| `MANTLE_CLIENT_IMAGE_TAG`        | Web app version. The updater sets it.                                                                        |
| `MANTLE_CLIENT_ENABLED`          | `0` runs no web app on the box (headless). Missing means on.                                                 |
| `COMPOSE_PROFILES`               | Optional services: `sandboxes`, `local-embedder`, `helpers`. Prefer **Settings > Services**.                 |
| `COMPOSE_FILE`                   | Set by `--core` for the small core shape.                                                                    |
| `SANDBOXD_TOKEN`, `PARSER_TOKEN` | Tokens for the sandbox service and the parser. Written for you.                                              |
| `PARSER_MEM_LIMIT`               | Memory for the parser, which reads every uploaded file (default `2g`). Raise it for very large drawing sets. |

## Updater

| Variable                 | What it does                                                       |
| ------------------------ | ------------------------------------------------------------------ |
| `MANTLE_PRE_ROLL_BACKUP` | `0` skips the backup before each update. Take your own then.       |
| `MANTLE_PRE_ROLL_KEEP`   | How many pre-update backups to keep. Default 3.                    |
| `MANTLE_IMAGE_PRUNE`     | `0` keeps old images after an update. By default they are removed. |

## Box policy

Rules for a company box. Set them in `.env` and restart. Nobody can change them from the app; **Settings** shows them read only. Empty means no rule, and the box works as it does today. See [Security](10-security.md#box-policy).

| Variable | What it does |
|---|---|
| `MANTLE_POLICY_TELEGRAM` | `off` switches Telegram off for the box. The bots and chats are kept. |
| `MANTLE_POLICY_MODEL_DENY` | Models no agent or worker may use, for example `deepseek/*,qwen/*`. While set, auto routers are blocked too. |
| `MANTLE_POLICY_PROVIDER_ALLOW` | The only providers any agent or worker may use, for example `foundry,local`. |
| `MANTLE_POLICY_ENDPOINT_ALLOW` | With a provider list: the servers a model route may name, for example `llm.example.internal:1234`. Empty: routes use the box's own endpoints only. |
| `MANTLE_POLICY_PASSWORD_MIN` | The shortest password allowed (8 to 64), and common passwords are refused. Everyone signs in once after you turn it on; a person with a weaker password must change it then. |

## Next

- [Optional services](04-services.md)
- [Security](10-security.md)
