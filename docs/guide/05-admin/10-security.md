# Keep a box secure

A Mantle box exposes one front door, and its secrets live in `.env`. This page lists what is exposed, what leaves the box and what to keep safe.

## What is exposed

- Only the front door (Caddy) listens on the network, on ports 80 and 443.
- The debug port (3000) listens on `127.0.0.1` only.
- Docker's published ports bypass the host firewall. To keep a brain off the network, install with `--localhost`, which sets `MANTLE_BIND_ADDR=127.0.0.1`. A firewall rule alone does not do it.
- Use a domain with HTTPS for any box reachable from the internet. See [Add a domain and HTTPS](../01-install/05-domain-https.md).

## What leaves the box

- Prompts and retrieved context, to the model providers you configure. Nothing, if you use only local models.
- Email you send, and sign-in codes mailed to client logins.
- Telegram messages on a paired bot.
- Calls to MCP or OpenAPI connectors you connect.
- Update checks (version numbers only).

## The secrets in `.env`

| Secret | Why it matters |
|---|---|
| `MANTLE_MASTER_KEY` | Decrypts stored API keys, mail passwords and secrets. Lose it and they are gone for good, backups included. Never change it on a running brain. |
| `SESSION_SECRET` | Signs every login session. |
| `MANTLE_SETUP_CODE` | Claims a fresh box. It stops working once the first account exists. |
| Database and object store passwords | Access to all data. |

The installer generates these, and re-running it never replaces an existing key.

## What to keep safe

1. Keep a copy of `.env` off the box, apart from your backups. A backup and the key it needs, stored together, is one theft away from fully readable.
2. Keep `.env` readable by its owner only. The installer sets mode 600.
3. Copy backups off the box. See [Back up and restore](02-backups.md).

## Logins and access

- Every item has a level: admin, team, client or public. The database itself enforces it: a member reads items at team level or below, a client only client-level items. Admins read everything.
- Use a separate brain for groups that must not share admins.
- End a login's access in **Settings > Logins** with **Disabled** or **Sign out everywhere**. It takes effect on the next request. See [Add member and client logins](07-logins.md).
- Check **Settings > Audit log** when something appears that nobody remembers creating.

## The updater

The updater container controls Docker on the host. It opens no ports and accepts only two requests from Jackdaw: update to a version, or switch an optional service. If you do not want that, stop the `updater` service and update from the command line. See [Update Mantle](01-update.md).

## Next

- [Environment variables](03-env-vars.md)
- [Deep security reference](../../security.md)
