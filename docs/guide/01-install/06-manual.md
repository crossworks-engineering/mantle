# Install without the script

Fill in `.env` yourself and start Mantle with Docker Compose.

## Before you start

- Everything in [Install on a server](02-server.md#before-you-start).
- The deploy bundle: download `mantle-deploy-<version>.tar.gz` from the [releases page](https://github.com/crossworks-engineering/mantle/releases) and unpack it on the server.

The bundle also contains the configurator. `bash scripts/install.sh` in the unpacked directory does all of the steps below for you, without the download.

## Steps

1. Copy the template:

   ```bash
   cp .env.prod.example .env
   ```

2. Fill in these values in `.env`:

   | Variable | Value |
   |---|---|
   | `SESSION_SECRET` | `openssl rand -base64 48` |
   | `MANTLE_MASTER_KEY` | `openssl rand -base64 32`. Back it up and never change it: it decrypts your stored keys and mail passwords. |
   | `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Strong random values, for example `openssl rand -hex 16` |
   | `MANTLE_SETUP_CODE` | Any hard-to-guess string. Sign-up asks for it until the first account exists. |
   | `MANTLE_SITE_ADDRESS` | Your domain, for HTTPS. Or `:80` for plain HTTP. |
   | `MANTLE_PUBLIC_URL` | `https://` plus your domain. Leave it out without a domain. |
   | `MANTLE_SERVER_ORIGIN` | The address people open in the browser, with the port if it is not 80 or 443 |
   | `MANTLE_STACK_DIR` | This directory's full path (the output of `pwd -P`). The in-app updater needs it. |
   | `MANTLE_DATA_DIR` | Where all data is stored (default `./data`) |

   Leave `ALLOWED_USER_ID` blank. For a this-machine-only install, also set `MANTLE_BIND_ADDR=127.0.0.1`.

3. Start the brain:

   ```bash
   docker compose pull && docker compose up -d --wait
   ```

4. Start the owner UI, which is a separate stack. Without it there is no sign-up screen.

   ```bash
   docker compose -f docker-compose.client.yml --project-directory . pull
   docker compose -f docker-compose.client.yml --project-directory . up -d --wait
   ```

5. Restart the front door so it routes to the UI:

   ```bash
   docker compose up -d --force-recreate caddy
   ```

## Check it worked

```bash
bash scripts/install.sh --check
```

Then open the address you set in `MANTLE_SERVER_ORIGIN`.

## Next

- [Create your account](../02-first-steps/01-create-account.md)
- [Environment variables](../05-admin/03-env-vars.md)
