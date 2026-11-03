---
title: Telegram
---

## Telegram

Telegram pairs your own Telegram chat to you, so you can talk to your assistant from your phone. It also lists the chats paired to you.

1. On Telegram, send the assistant's bot any message. It answers with a pairing code.
2. Under **Pair Telegram**, enter the code and click **Pair Telegram**.
3. The screen shows which **Chat**, **Bot** and **Assistant** the code is for. Check it is your own chat, then click **Confirm**. **Cancel** pairs nothing.

**My chats** lists every chat paired to you, with its bot and its last message. **Unpair** asks first, then the chat stops reaching your assistant. Pair it again any time with a new code from the bot.

**Chats you moderate** shows only when you moderate a bot: you are a Moderator of its assistant's workspace, or an Admin user with the users area. There you can **Block** a chat, **Unpair** it, or **Unblock** a blocked one. You never pair someone else's chat. Only its own user does, with their code.

The bot itself is set up on the assistant, under **Settings > Agents**. See [Connect Telegram](../02-first-steps/05-connect-telegram.md).

## Assistant

The assistant in the app cannot pair a chat. Pair it on this screen. From your own MCP client, `telegram_pair` does the same in two calls: the first shows whose chat the code is for, the second (with `confirm`) pairs it.

## Technical

- A pairing code is six hex characters. The confirm must follow the preview within ten minutes, and it pairs only the chat the preview showed. Too many tries are refused for a while.
- A chat is paired to the login that entered the code, never to anyone else, and only for a bot whose assistant's workspace that login is a user of.
- A paired chat acts as you: the bot's assistant answers it the way it answers you in the app, with what you may see in its workspace.
- Unpairing a chat from **Chats you moderate** sends it back to waiting, so its person can pair it again with a new code. A blocked chat stays blocked until it is unblocked.
- A box policy can switch Telegram off for the whole box. Pairing is then refused.
