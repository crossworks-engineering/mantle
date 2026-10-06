# Choose how to install

Mantle is self-hosted: it runs on a machine you own. Pick the line that fits you, then follow its page.

## A server with a domain

The usual choice. One command installs Mantle on a Linux server, and your domain gets HTTPS by itself. Reachable from anywhere, always on.

[Install on a server](02-server.md), then [Add a domain and HTTPS](03-domain-https.md).

## A server on your home network

The same one command, without a domain. Mantle answers on plain HTTP at the server's network address, for use at home or over a VPN.

[Install on a server](02-server.md) and choose "This machine's network".

## A small server

The core shape fits a 2 vCPU / 4 GB server. It keeps memory, file ingest, the API and MCP, and drops the email and Telegram workers.

[Install on a small server](04-small-server.md).

## Headless, with no UI

A brain driven only by MCP or the API, with no web screens on the server. You finish setup from the desktop app or the terminal.

[Install options](05-options.md).

## The desktop app

Jackdaw for Linux, macOS and Windows. It opens a brain that is already installed somewhere; it does not install one.

[Desktop app](07-desktop-app.md).

## From source, for developers

Run the brain from a git checkout on your own machine, with the UI from the jackdaw repo. For working on Mantle itself.

[Run from source](08-from-source.md).
