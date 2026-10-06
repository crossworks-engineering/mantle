# Uninstall Mantle

Remove the stack and keep your data, or erase everything. Run the commands in the stack directory (the folder with `docker-compose.yml` and `.env`).

## Remove the stack, keep the brain

```bash
bash scripts/uninstall.sh
```

This removes the containers of both stacks, any sandbox containers, and their networks. Your data directory and `.env` stay. Running `bash scripts/install.sh` later brings the same brain back, with the same keys.

## See what would be removed

```bash
bash scripts/uninstall.sh --dry-run
```

It lists the paths, sizes and containers it would touch, and changes nothing.

## Erase everything

Take a backup first if there is any chance you want the brain back. See [Back up and restore](02-backups.md).

```bash
bash scripts/uninstall.sh --purge
```

This also deletes the data directory and `.env`. That is the brain itself and `MANTLE_MASTER_KEY`. Without that key, the API keys and passwords in any later restore cannot be read. There is no undo. Type `PURGE` when asked to confirm.

## Options

| Option | What it does |
|---|---|
| `--images` | Also removes the downloaded Mantle images (about 4 GB). |
| `--data-dir <path>` | Use this data directory instead of the one in `.env`. |
| `--stack-dir <path>` | Where `docker-compose.yml` lives, when you run the script from elsewhere. |
| `-y` | Skip the confirmation. With `--purge` this deletes everything without asking. |

## Check it worked

```bash
docker ps -a --filter name=mantle_
```

No Mantle containers are listed.

## Next

- [Install on a server](../01-install/02-server.md)
