# Install on a server

One command installs Mantle on a Linux server and starts it.

## Before you start

- A Linux server with Docker Engine and the Compose plugin (`docker compose version` works), plus `openssl` and `curl`.
- 8 GB of RAM or more for the full stack. With less than 6 GB, use the [small server](04-small-server.md) shape.
- 20 GB of free disk or more. The installer stops below 5 GB.
- An [OpenRouter](https://openrouter.ai/keys) key. You paste it into the setup wizard after the install, not into a file.
- For HTTPS: a domain that points at the server. See [Add a domain and HTTPS](03-domain-https.md).

## Install

1. On the server, run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash
   ```

2. Answer the questions. Press Enter to take the default.

   | Question | Default |
   |---|---|
   | How should people reach this brain? | 1, a domain with HTTPS. 2 is this machine only, 3 is this machine's network. |
   | Install the small core shape? | No (yes when the server has less than 6 GB of RAM) |
   | Enable CLI sandboxes? | Yes |
   | Bundle the local embedder? | No |
   | Run the owner web UI? | Yes |

3. Read the review and answer **Go ahead?** with Enter. The first install downloads about 2 GB.
4. Note the address and the **setup code** printed at the end. You need both to [create your account](../02-first-steps/01-create-account.md).

Mantle installs into `./mantle`. Running the command again is safe: it keeps your data and secrets.

Back up `mantle/.env`. It holds the master key that decrypts your stored API keys and mail passwords. See [Backups and restore](../05-admin/02-backups.md).

## Check it worked

The installer ends with **Installation complete** and the address to open. Check again at any time:

```bash
cd mantle && bash scripts/install.sh --check
```

## If it fails

- **Installation incomplete**: run the check above and `docker compose logs --tail 50 web caddy` in `mantle`, fix what is flagged, then run the installer again.
- **Image pull failed**: usually a network blip. Run the installer again.
- **Port 80 already in use**: without a domain the installer moves to port 8080 and prints that address. With a domain, see [Add a domain and HTTPS](03-domain-https.md).

## Next

- [Create your account](../02-first-steps/01-create-account.md)
- [Install options](05-options.md): silent installs, sandboxes, the local embedder, media, no UI.
