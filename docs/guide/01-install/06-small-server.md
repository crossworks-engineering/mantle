# Install on a small server

The core shape runs Mantle on a 2 vCPU / 4 GB server by leaving out the parts a small box cannot carry.

| Keeps | Leaves out |
|---|---|
| The owner UI, the HTTP API, MCP and share pages | The email, Telegram, Microsoft, calendar and push workers |
| File and documentation ingest, search and memory | The doc helpers: Tika (rare formats such as .odt, .pptx, .doc, .rtf) and the PDF-export browser |
| Reminders, scheduled backups, nightly maintenance | CLI sandboxes (off by default, can be turned on) |

PDF, Word, text and Markdown files still read without the doc helpers. A core box uses online embeddings: the local embedder does not fit in 4 GB.

## Before you start

- 2 vCPU, 4 GB of RAM, 40 GB of disk. Add 2 GB of swap as a safety margin.
- Everything in [Install on a server](03-server.md#before-you-start) except the RAM.

## Install

1. Run the [server install](03-server.md) one-liner.
2. When it asks **Install the SMALL core shape instead of the full stack?**, answer yes. On a box with less than 6 GB of RAM, yes is the default.
3. Answer **Add the doc helpers to the core?** with no, unless you need rare file formats or PDF export.

For a silent install:

```bash
MANTLE_YES=1 MANTLE_CORE=1 MANTLE_DOMAIN=brain.example.com \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh)"
```

To switch a box that is already installed, run `bash scripts/install.sh --core` in its install directory. The installer keeps how the brain is reached.

## Lower the memory caps

The two largest services are capped at 3 GB each, which is too much for a 4 GB box. Add these lines to `mantle/.env`:

```bash
WEB_MEM_LIMIT=1.5g
API_MEM_LIMIT=1.5g
```

Then apply them:

```bash
cd mantle && docker compose up -d
```

## Check it worked

```bash
cd mantle && bash scripts/install.sh --check
```

The review table at install time also shows **Shape: core**.

## Change it later

- Doc helpers: switch **Helpers** in **Settings > Services**, or run `bash scripts/install.sh --helpers` with your access flag as above.
- Back to the full stack: `bash scripts/install.sh --no-core`, with your access flag.

## Next

- [Create your account](../02-first-steps/01-create-account.md)
- [Optional services](../05-admin/04-services.md)
