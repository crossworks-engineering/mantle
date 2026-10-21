# Overview

MantleOS is a self-hosted AI brain. It keeps your email, files, notes, pages, tables and chats on your own server, and an assistant answers from them with sources.

## What makes it different

- **Your server, your data.** One Postgres database on a machine you control holds everything. Nothing leaves it unless you send it out on purpose.
- **It remembers by itself.** Each item that arrives is summarised, indexed by meaning and turned into facts as it lands. There is no index button. See [How MantleOS remembers](04-concepts/02-memory.md).
- **Answers show where they came from.** The assistant cites the email, file or page it read.
- **Agents you can shape.** The assistant hands work to specialist agents (pages, tables, research, code). You decide each agent's model and tools.
- **Every door has the same rules.** The MantleOS app on the web, MantleOS Desktop, the phone app, Telegram, Claude over MCP and the HTTP API reach the same brain, and each login sees only what its workspaces hold. See [Ways to control MantleOS](04-concepts/01-ways-to-control.md).
- **Built for a team.** Everyone gets their own login and reads what their workspaces hold, limited by the database itself. See [Who can use a brain](04-concepts/05-access-tiers.md).

## The server and the app

| | The server | The app |
|---|---|---|
| What it is | The engine: it stores, remembers and runs the agents | The window you open your brain in |
| Where it runs | Your server | A browser, MantleOS Desktop or the phone app |
| You install it | Once, on the server | Nothing for the web. MantleOS Desktop and the phone app connect to a brain you already run |

One MantleOS server is one brain. The app talks to it only over `/api`.

## Start here

1. [Get a server](01-install/02-get-a-server.md).
2. [Install on a server](01-install/03-server.md), or [with an AI assistant](01-install/04-ai-assistant.md).
3. [Create your account](02-first-steps/01-create-account.md).
4. [Talk to the assistant](02-first-steps/02-first-chat.md).

## The sections

| Section | What it covers |
|---|---|
| [Install](01-install/01-choose.md) | Every way to run MantleOS, from one command on a server to a developer checkout. |
| [First steps](02-first-steps/01-create-account.md) | Your account, the first chat, your first knowledge, email and Telegram. |
| [Using MantleOS](03-using-jackdaw/01-menu.md) | Each part of the app: assistant, email, files, pages, tables, apps, workspaces and more. |
| [Concepts](04-concepts/01-ways-to-control.md) | The ways in, how MantleOS remembers, agents, workspaces, sharing and how the parts fit. |
| [Admin and self-hosting](05-admin/01-update.md) | Updates, backups, settings, models, logins, security and troubleshooting. |
| [API reference](07-api/01-connect-claude.md) | Connect Claude and other MCP clients, the HTTP API and the tool list. |

Each screen in the app also has its own help page, under **Using MantleOS > Screen help**. The **?** button in the app opens the same text.

## Get the source

The MantleOS server is open source on [GitHub](https://github.com/crossworks-engineering/mantle). The web app and MantleOS Desktop are in their own [repository](https://github.com/crossworks-engineering/mantle-client).
