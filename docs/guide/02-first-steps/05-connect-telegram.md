# Connect Telegram

Give your assistant a Telegram bot, so you can message it from your phone by text or voice note.

## Before you start

- A brain on the full shape. The [small core shape](../01-install/06-small-server.md) does not run the Telegram worker.
- The setup wizard's **Set up** step is done, so the assistant exists.
- Telegram on your phone.

## Steps

1. In Telegram, message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name and a username for the bot, then copy the token BotFather sends you.
3. In Jackdaw, open **Settings > Agents**, select your assistant, and find the **Telegram bot** section on the **General** tab. The wizard's **Telegram** step shows the same section.
4. Paste the token and click **Connect bot**.
5. On your phone, send your new bot any message. It answers **Approval required** with a pairing code.
6. Back in the **Telegram bot** section, a pairing request appears. Click **Approve**.

The section checks for new requests every 10 seconds. A newly connected bot can take up to a minute to start listening, so if nothing shows, wait and send another message.

## Check it worked

The section shows your bot's `@username`, the word **polling**, and **1 paired chat**. Send the bot a message; the assistant replies there.

## Who a paired chat acts as

A paired chat is you. Whatever it sends, the agent answers as it answers you in Jackdaw: with your whole brain and every tool the agent holds, whatever the agent's level. This holds for every agent's bot, a team agent's too.

So approve only your own Telegram account. To give a teammate or a client an assistant, add a login for them on **Settings > Logins** and let them use Jackdaw or the phone app. Never pair their Telegram chat.

## If it fails

- **A stranger's request shows up**: click **Block** instead of **Approve**. Anyone can find a bot, but only chats you approve reach the assistant, and each one you approve acts as you.
- **An error shows next to the bot name**: the token is wrong or was revoked in BotFather. Paste a fresh token and click **Update token**.

## Next

- [The assistant](../03-using-jackdaw/02-assistant.md)
