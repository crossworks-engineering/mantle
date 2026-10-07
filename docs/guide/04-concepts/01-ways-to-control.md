# Ways to control Mantle

Every way to reach your brain, and what each one is for. They all reach the same brain, with the same access rules.

| Way in | What it is for |
|---|---|
| **Jackdaw on the web** | The full app in a browser, at your brain's address. Every screen and setting is here. |
| **Jackdaw desktop** | The same app for Linux, macOS and Windows, with desktop notifications and several brains in one window. See [Desktop app](../01-install/09-desktop-app.md). |
| **Phone app** | Chat with the assistant and get reminders on your phone. Scan the **Sign in on your phone** code on **Settings > Logins**. Members and clients sign in with their own login. |
| **Telegram** | Message the assistant from Telegram by text or voice note. Each agent can have its own bot. See [Connect Telegram](../02-first-steps/05-connect-telegram.md). |
| **Email** | Mail from your contacts comes into the brain and becomes knowledge. The assistant sends mail for you, after you approve it. See [Email and contacts](../03-using-jackdaw/03-email-and-contacts.md). |
| **MCP, remote** | Add your brain to Claude or another MCP client by its connector URL, with sign-in. The client gets the same tools your agents use. See [Connect Claude over MCP](../07-api/01-connect-claude.md). |
| **MCP, local** | An MCP client on a machine with SSH access starts the MCP server on the box. Nothing is opened on the network. Same page as above. |
| **HTTP API** | The versioned public API under `/api/v1`, with an API key. For scripts. See [The HTTP API](../07-api/03-http-api.md) and [API keys](../07-api/08-api-keys.md). |
| **On the server** | `scripts/install.sh` in the install directory changes the domain and the optional services, and runs a health check. See [Install options](../01-install/07-options.md). |

Both MCP and `/api/v1` are stable surfaces for scripts and AI clients. The other `/api/` routes are the ones Jackdaw itself calls, and they can change with any release.

An API key works on both. A member, a client or another Mantle can use them too, limited to that login's rights. See [API keys](../07-api/08-api-keys.md) and [MCP as a login](../07-api/02-mcp-login.md).

## What you can do from Jackdaw

You run the whole brain from the app. You do not need the terminal after the install.

- **Work**: chat with the assistant, read mail, and keep files, notes, pages, tables, tasks and drawings.
- **Build**: ask for a small app and use it in Jackdaw. See [Apps](../03-using-jackdaw/10-apps.md).
- **Shape the agents**: pick each agent's model, prompt, skills and tool groups, and give it a Telegram bot. See [Agents and AI workers](../03-using-jackdaw/13-agents.md).
- **Run the server**: switch optional services on or off, add API keys, add logins, schedule backups and update to a new version in one click. See [Update Mantle](../05-admin/01-update.md).
- **See what happened**: **Traces** shows each step of each assistant turn, with the model and the tools it used.

## Next

- [Who can use a brain](05-access-tiers.md)
- [Architecture](07-architecture.md)
