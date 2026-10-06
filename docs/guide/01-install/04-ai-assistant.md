# Install with an AI assistant

Let an AI assistant connect to your server over SSH and run the install for you. You watch, approve each command and get the address at the end.

## Which assistants can do it

An assistant needs to run commands on your computer. Today these do it well from a terminal, and each shows a command before it runs it:

| Assistant | Made by |
|---|---|
| Claude Code | Anthropic |
| Codex CLI | OpenAI |
| Grok Build | xAI |

Some assistants can also control your screen. A chat-only assistant (Claude, ChatGPT or Grok in a browser) can still guide you: it gives you each command and you paste it yourself.

## Before you start

- A server you can reach with `ssh root@<ip>` from the computer the assistant runs on. See [Get a server](02-get-a-server.md).
- For HTTPS: a domain whose A record points at the server. See [Get a domain](05-domain-https.md#get-a-domain).

## Steps

1. Start the assistant on your own computer.
2. Paste this prompt. Change the IP address and the domain first, or delete the domain line to install without one.

   ```text
   Install Mantle on my server.
   Read https://mantle-ai.tech/ai-install.md first and follow it.

   - Server: ssh root@203.0.113.10
   - Domain: brain.example.com (check that it resolves to the server's IP first)
   - If Docker is missing, install it with: curl -fsSL https://get.docker.com | sh
   - Run the installer without prompts, with my domain.
   - Run the health check: cd mantle && bash scripts/install.sh --check
   - Show me each command before you run it.
   - Report back the address to open and the setup code.
   ```

3. Approve each command when it asks.
4. Open the address it reports and [create your account](../02-first-steps/01-create-account.md) with the setup code.

:::caution[You stay in control]
Read each command before you approve it. Never paste your OpenRouter key or a password into the chat. You add the key yourself in the setup wizard.
:::

## Check it worked

The assistant reports **Installation complete** and an address. That address opens the Jackdaw sign-up screen.

## If it fails

- **The setup code scrolled away**: ask the assistant to run `cd mantle && bash scripts/install.sh --setup-code`.
- **The site opens on plain HTTP**: the domain did not point at the server yet. Fix the A record, then ask the assistant to follow [Add it later](05-domain-https.md#add-it-later).

## Next

- [Create your account](../02-first-steps/01-create-account.md)
- [Install on a server](03-server.md): the same install, by hand.
