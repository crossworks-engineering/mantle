# Troubleshooting

Start with the health check, then read the logs of the container that failed. Run every command in the stack directory (the folder with `docker-compose.yml` and `.env`).

## Run the health check

```bash
bash scripts/install.sh --check
```

It lists every container in both stacks, names any service that is missing or has no network, and checks that Mantle answers at the front door. It exits non-zero when something is wrong.

In Jackdaw, **Debug > Sanity check** tests the configuration and shows a fix for each failure.

## Read the logs

```bash
docker compose ps                         # state of every server container
docker compose logs --tail 200 web        # the main app
docker compose logs --tail 200 migrate    # database migrations
docker compose logs -f api                # follow live
docker logs --tail 200 mantle_client_web  # the Jackdaw interface
```

Other service names: `caddy`, `postgres`, `objectstore`, `worker_files`, `worker_email`, `worker_events`, `updater`.

## Common problems

**The address does not answer.** Run the health check. If `caddy` is down, read its logs. Check that ports 80 and 443 are open in your firewall and not held by another web server.

**No HTTPS certificate.** The domain's DNS must point at this box and ports 80 and 443 must be reachable from the internet. Fix DNS, then run `bash scripts/install.sh --domain <host> -y`. It checks DNS before it asks for a certificate.

**Sign-up asks for a setup code you lost.** Print it again:

```bash
bash scripts/install.sh --setup-code
```

**Settings > Updates says the updater is not configured.** Add `MANTLE_STACK_DIR=` with the stack directory's full path (`pwd -P` prints it) to `.env`, then run `docker compose up -d updater`.

**The interface is old after an update.** The Jackdaw interface is a second stack. Update it as shown in [Update Mantle](01-update.md).

**The web container runs but cannot reach the database.** Something else holds port 3000, so Docker could not set up its network. Set `MANTLE_WEB_DEBUG_PORT=3001` in `.env` and run `docker compose up -d`.

**Large files time out while indexing on the local embedder.** The embedder is too slow for the box. In **Settings > Embedding**, set **Hardware profile** to **Small CPU VPS** and save, or switch to an online embedder.

**An agent stops answering.** Check **Settings > API keys** with **Test**. A key with no credit or a refused key shows there. Add a backup route so the next outage fails over. See [Models and API keys](05-models-and-keys.md).

**An item is missing from search.** Open **Debug > Integrity** and check the item has a summary and an embedding. See [See what the brain did](09-observability.md).

## Next

- [Update Mantle](01-update.md)
- [Back up and restore](02-backups.md)
