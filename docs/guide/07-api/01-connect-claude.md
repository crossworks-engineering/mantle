# Connect Claude over MCP

Add your Mantle to Claude (claude.ai, Claude Desktop or Claude Code) so Claude can search and write your brain with the same tools your agents use.

There are two ways in:

- **Remote connector**: a URL with sign-in. Works on the web, desktop and phone. Use this one.
- **Over SSH**: Claude starts the MCP server on your server through SSH. Nothing is opened on the network.

## Before you start

- Mantle runs on a domain with HTTPS ([Add a domain and HTTPS](../01-install/05-domain-https.md)).
- `MANTLE_PUBLIC_URL` is set to that address ([Environment variables](../05-admin/03-env-vars.md)).
- You sign in as an admin.

## Turn on the connector

1. In Jackdaw, open **Settings > MCP**.
2. Turn on **Remote MCP connector**.
3. Copy the **Connector URL**. It looks like `https://example.com/api/mcp`.
4. Press **Check endpoint** to test it.

The connector is off by default. Turned on, your tools are reachable from the internet, behind sign-in and consent.

## Add it to Claude

In claude.ai or Claude Desktop:

1. Open **Settings > Connectors > Add custom connector**.
2. Paste the connector URL.
3. Sign in to your Mantle and approve access.

In Claude Code:

```sh
claude mcp add --transport http --scope user mantle https://example.com/api/mcp
```

Then run `/mcp` inside Claude Code, pick `mantle` and sign in.

## Over SSH instead

You need key-based SSH to the server, and your user in the `docker` group there. Add a host alias to `~/.ssh/config`:

```
Host my-mantle
  HostName example.com
  User you
```

Claude Code:

```sh
claude mcp add mantle -- ssh my-mantle docker exec -i mantle_web pnpm -C server/mcp start
```

Claude Desktop: merge this into `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Claude Desktop.

```json
{
  "mcpServers": {
    "mantle": {
      "command": "ssh",
      "args": ["my-mantle", "docker", "exec", "-i", "mantle_web", "pnpm", "-C", "server/mcp", "start"]
    }
  }
}
```

## Check it worked

Ask Claude: "Search my Mantle for my last trip." It should call the `search` tool and answer from your brain. A remote client also shows under **Connected clients** in **Settings > MCP**.

Writes are real. A note or task Claude makes is the same item Jackdaw shows, and the brain indexes it.

## If it fails

- **The connector URL says localhost**: set `MANTLE_PUBLIC_URL` and restart Mantle.
- **The URL answers 404**: the connector is off. Turn it on in **Settings > MCP**.
- **SSH prints "No account yet"**: create your account in Jackdaw first.

To cut a client off, press **Disconnect** next to it under **Connected clients**.

## Next

- [MCP as a login](02-mcp-login.md): let members and clients connect with their own rights.
- [Toolsmith](05-toolsmith.md): build new tools from Claude Code.
