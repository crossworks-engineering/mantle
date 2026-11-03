---
title: Chats
toolGroups: []
---

## Chats

Chats is where you message the people of your brain, one to one or in a group, and where your threads with the assistants live too. One list holds them all.

- Click **+** (**New chat**) or **Start new chat**. Search for a person or an agent; the filter shows **All**, **People**, **Agents** or **Groups**. Under each name is who they are to the team, such as a job title.
- Pick a person, type the first message and send. This opens your direct chat with them.
- Pick an agent to open your own thread with that assistant.
- For a group, pick **New group**. Give it a **Group name**, an icon and colour, its **Info** (what it is for and its rules) and its members. You are its first admin. A group of just you is allowed.

In a chat:

- Enter sends, Shift+Enter starts a new line. Type **@** to mention someone. Use the emoji button for an emoji.
- Each message has a react button. Its menu has **Edit** and **Delete** on your own messages. A group admin can delete any message.
- Ticks show sent (one) and read (two). A green dot means the person is online.
- **Details** opens the chat's panel: the people, **Mute** (counts unread, never pops up) and **Pin** (keeps the chat at the top). **Clear for me** hides the messages so far for you only. In a group, **Leave group** stops new messages; an admin also renames the group, edits its **Info**, adds and removes people, and has **Delete history**, which deletes every message for everyone.
- **Call** starts a voice call, when calls are switched on for the brain. The others get a ring with Answer and Decline. A call bar stays open while you move around the app.

The **Chats** entry in the menu shows how many messages you have not read. A new message in another chat shows a short notice with **Open**.

## Assistant

The in-app assistant does not read or send your chats with people. An outside agent connected over MCP on your login can, when you ask it to. Its messages show your name, then "via" and the agent's name, so everyone can see an agent sent them.

## Technical

- A chat is between logins of one brain. You can start a chat with anyone who shares a workspace with you; an Admin user can reach every login.
- Nobody reads a chat they are not in. There is no admin view, and the brain owner reads no one else's chats either.
- Someone added to a group later reads from the moment they were added, not the history before.
- Unread counts what you have not read since your last read or your last clear. A muted chat still counts.
- A message is at most 8000 characters. Each login may send 60 messages a minute.
- A group's info is plain text, at most 2000 characters. It is shown, never run.
- Faces are the avatars people and agents chose in Appearance; a photo comes first.
- Calls use the brain's own LiveKit service, switched on in Settings > Services. By default a call holds at most 25 people and lasts at most 4 hours.
- MCP tools: `messenger_list`, `messenger_open`, `messenger_send`, `messenger_create`, `messenger_wait`, `messenger_mark_read`, `messenger_directory`. Detail: [docs/messenger.md](../../messenger.md).
