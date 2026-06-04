# The assistant — web & Telegram

The assistant is how you actually use your brain day to day. She reads your memory,
takes actions on your behalf, and learns your preferences over time. You reach the
*same* assistant — same memory, same ongoing relationship — two ways.

## On the web (`/assistant`)

Open **Assistant** in the sidebar. It's a document-style canvas, not a cramped chat
box:

- **Type** a message and send.
- **Dictate** with the microphone — your speech is transcribed into the input box;
  you review, then send.
- **Attach** an image or a document (PDF, Word, Excel, CSV, text). The assistant
  reads it for the reply *and* files it into your memory so you can ask about it
  later.
- **Rich replies** — she can answer with proper formatting: headings, callouts,
  tables, columns, checklists, even diagrams she generates. A reply can be turned
  into a saved [Page](04-pages-tables-notes-docs.md).
- **Voice & images out** — she can reply with a spoken audio clip, or generate an
  image, inline in the conversation.

Switch between agents (if you have more than one) from the dropdown; each keeps its
own conversation.

## On Telegram

Talk to the assistant from your phone like any contact — including **voice notes**.
She transcribes what you say, answers, and (if you sent voice) can reply out loud.

**Pairing your phone** (one-time):

1. In **Settings → Agents**, open your responder agent and find the **Telegram bot**
   section. Paste the bot token there.
2. Message the bot from your phone. The first time, it issues a short pairing code
   and asks you to approve.
3. Approve the request (one click in that same Telegram section). You're connected.

After that, just message her. Reminders from your **Events** also arrive here.

> The web and Telegram are doorways to one assistant. There's nothing to sync — a
> conversation you start on your phone continues on the web and vice versa, because
> they share the same brain.

## What she can do for you

Because she has memory **and** tools, you can ask her to *act*, not just answer:

- **Recall** — "what did the plumber quote?", "find my note about the gate code."
- **Capture** — "make a note…", "add a todo to…", "save this as a contact."
- **Schedule** — "remind me to call Don Friday at 3pm" → creates an event and pings you.
- **Write** — "turn this into a polished page", "summarise this thread."
- **Email** — "draft a reply and send it" (from your own mailbox; see
  [Email & inbox](02-email-inbox-and-contacts.md)).
- **Look things up** — she can search the live web and come back with cited sources.
- **Work with images & docs** — read a photo, extract a scanned invoice, generate an image.

For anything you've marked as needing approval, she'll queue it under **Pending**
for your sign-off rather than doing it silently.

## Voice in, voice out

- Send a voice note on Telegram → she transcribes it and replies (by voice if you
  spoke).
- On the web, dictate with the mic and have her speak answers back.
- Which voice she uses is configurable per agent under
  [Agents & workers](../04-configuring/01-agents-and-workers.md).

## She learns you

As you talk, the assistant quietly notes durable preferences — how terse you like
replies, recurring people and projects, corrections you make — into her persona.
Over time she fits you better without you configuring anything. You can always see
and edit what she's learned under **Settings → Agents**.

## Tips

- **Be vague on purpose.** You don't need exact titles — describe what you remember
  and let recall do the work.
- **Feed it freely.** The more you put in (email, files, notes), the more useful she
  becomes.
- **Check Traces** if you're ever curious *how* she arrived at an answer or what a
  turn cost — every step is logged.
