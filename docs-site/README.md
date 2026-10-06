# Docs site

This folder builds docs.mantle-ai.tech from the pages in `docs/guide/` and the release notes in `CHANGELOG.md`. It holds no pages of its own.

## Run it

```bash
cd docs-site
pnpm install
pnpm dev
```

Open the address it prints. Edits to `docs/guide/` show at once.

## Write a page

1. Add a file to a section folder in `docs/guide/`, for example `docs/guide/05-admin/14-proxy.md`. The number sets the order.
2. Make the first line the title: `# Use a proxy`.
3. Link to other pages with relative paths to the `.md` file. The site turns them into site links. Links to files outside `docs/guide/` become GitHub links.
4. Follow the documentation style map (short, answer first, no em dashes).
5. Run the checks:

```bash
pnpm check
node ../scripts/docs-check.mjs
```

A new page in a section folder shows in the sidebar on the next start. A new section needs a line in `SECTIONS` in `src/lib/guide.mjs`.

## What the build adds

| Page | Made from |
|---|---|
| Changelog | `CHANGELOG.md`, one page per minor version |
| MCP tools | the real MCP server surface, by `scripts/mcp-tools.ts`. Needs `pnpm install` at the repo root. Without it, the page is left out. |

The logo comes from `brand/` at build. Change it there.

## Deploy

```bash
DOCS_DEPLOY_HOST=<ssh login> ./scripts/deploy.sh
```

It builds and copies `dist/` to `~/mantle-docs/site` on the box that serves mantle-ai.tech. The Caddy vhost for docs.mantle-ai.tech lives in the mantle-site repo (`deploy/Caddyfile`), and its DEPLOY.md has the ssh login.
