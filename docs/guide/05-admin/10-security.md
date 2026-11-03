# Keep a box secure

A MantleOS box has one way in from the network, and its secrets live in `.env`. Here is what is exposed, what leaves the box and what to keep safe.

## What is exposed

- Only the front door (Caddy, the built-in web server) listens on the network, on ports 80 and 443.
- The debug port (3000) listens on `127.0.0.1` only.
- Docker's published ports bypass the host firewall. To keep a brain off the network, install with `--localhost`, which sets `MANTLE_BIND_ADDR=127.0.0.1`. A firewall rule alone does not do it.
- Give any box on the internet a domain with HTTPS. See [Add a domain and HTTPS](../01-install/05-domain-https.md).

## What leaves the box

- Prompts and retrieved context, to the model providers you set up (none, with local models only).
- Email you send.
- Telegram messages on a paired bot.
- Calls to MCP or OpenAPI connectors you connect.
- Update checks (version numbers only).

## The secrets in `.env`

| Secret                              | Why it matters                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANTLE_MASTER_KEY`                 | Decrypts stored API keys, mail passwords and secrets. Lose it and they are gone for good, backups included. Never change it on a running brain. |
| `SESSION_SECRET`                    | Signs every login session.                                                                                                                      |
| `MANTLE_SETUP_CODE`                 | Claims a fresh box. It stops working once the first account exists.                                                                             |
| Database and object store passwords | Access to all data.                                                                                                                             |

The installer generates these, and re-running it never replaces an existing key.

## What to keep safe

1. Keep a copy of `.env` off the box, apart from your backups. A backup stored with its key is readable by anyone who takes both.
2. Keep `.env` readable by its owner only. The installer sets mode 600.
3. Copy backups off the box. See [Back up and restore](02-backups.md).

## Logins and access

- A login gives no rights by itself. Each user reads what the workspaces they are in hold, and the database enforces it. Admins manage the brain but read only their workspaces. See [Who can use a brain](../04-concepts/05-access-tiers.md).
- Groups that must not share admins need separate brains.
- End a login's access in **Settings > Users** with **Disabled** or **Sign out everywhere**. It takes effect on the next request. See [Add users](07-logins.md).
- Check **Settings > Audit log** when something appears that nobody remembers making.

## Box policy

A company can lock a few things for every site with a few lines in `.env` ([Environment variables](03-env-vars.md#box-policy)). The app cannot turn them off.

- **Telegram off.** No bot polls or sends. The bots and chats are kept.
- **Email sending off.** The box's own mail accounts send nothing: no agent, person or app can send through them. The send tools leave every agent, and an email waiting for approval stays waiting. Reading and syncing mail still work. Mail sent another way (an MCP connector, an HTTP tool with its own mail key, a sandbox, the Admin terminal, a linked brain) is not covered: control who may add those, and block outgoing mail at your network edge.
- **Models.** Block model families or allow only some providers. A blocked model fails with a clear message and an alert, and the model lists show only allowed models.
- **Passwords.** A longer minimum than the usual 8 characters. Common passwords are refused on every box anyway. After you turn it on, every login signs in once more, and a person whose password is too weak changes it then. That also ends their API keys and connectors, as any password change does.

At start-up the log names every agent and worker on a blocked model. Fix those first.

## The updater

The updater container controls Docker on the host. It opens no ports and takes only two requests from the app: update to a version, or switch an optional service. If you do not want that, stop the `updater` service and update from the command line. See [Update MantleOS](01-update.md).

## Next

- [Environment variables](03-env-vars.md)
- [Deep security reference](../../security.md)
