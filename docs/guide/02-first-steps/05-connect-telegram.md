# Connect Telegram

Give your assistant a Telegram bot, so you can message it from your phone by text or voice note.

## Before you start

- A brain on the full shape. The [small core shape](../01-install/06-small-server.md) does not run the Telegram worker.
- The setup wizard's **Set up** step is done, so the assistant exists.
- Telegram on your phone.

## Steps

1. In Telegram, message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name and a username for the bot, then copy the token BotFather sends you.
3. In MantleOS, open **Settings > Agents**, select your assistant, and find the **Telegram bot** section on the **General** tab. The wizard's **Telegram** step shows the same section.
4. Paste the token and click **Connect bot**.
5. On your phone, send your new bot any message. It answers that the chat is not paired yet, with a pairing code.
6. Signed in to the app as yourself, enter that code where it asks for a Telegram pairing code. The app first shows which Telegram chat and bot the code is for; check it is your own chat, then confirm. From your own MCP client, the `telegram_pair` tool does the same in two calls.

A newly connected bot can take up to a minute to start listening, so if no code comes back, wait and send another message.

## Check it worked

The section shows your bot's `@username`, the word **polling**, and your chat as paired to you. Send the bot a message; the assistant replies there.

## Who a paired chat acts as

A paired chat belongs to the user who paired it. Whatever it sends, the bot's assistant answers that user the way it answers them in the app: in their own chat with it, with what they may see in its workspace, and nothing more.

- **Only you pair your own chat.** The code the bot sends goes to the person on Telegram; entering it while signed in pairs the chat to the login that entered it, never to anyone else.
- **Any workspace's assistant can have a bot.** A user pairs a chat to it only when they are a user of that assistant's workspace.
- **A user taken out of the workspace loses the bot at once.** Their chat gets one short reply that it is not paired, and no turn runs, until they pair it again.
- **Moderators and Admin users block or unpair, never pair.** A Moderator of the bot's workspace, or an Admin user with the users area, can block or unpair any chat of that bot. Unpairing sends the chat back to pending, so its person can pair again with a new code.
- **Approvals come to your own chat only.** A tool call waiting for approval sends its card to a chat of the user it waits for, and only when that user may decide approvals.

As in the app, an assistant of a workspace other than Admin accepts only typed messages on Telegram, and a user who is not an Admin user has the same daily message limit there as in the app.

## If it fails

- **A stranger messages the bot**: nothing reaches the assistant until someone signed in enters the code, and then the chat is theirs. To stop a chat for good, a Moderator blocks it.
- **"Not a user of this bot's assistant's workspace"**: ask a Moderator of that workspace to add you, then enter a fresh code.
- **An error shows next to the bot name**: the token is wrong or was revoked in BotFather. Paste a fresh token and click **Update token**.

## Next

- [The assistant](../03-using-jackdaw/02-assistant.md)
