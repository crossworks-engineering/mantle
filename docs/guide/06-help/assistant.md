---
title: Assistant
toolGroups: [memory-core]
---

## The assistant panel

The assistant is where you talk to your brain. It opens as a panel over any screen: click the chat bubble or press Cmd/Ctrl+I.

- Type and press Enter to send. Shift+Enter adds a new line. You can also dictate, or attach an image or a document.
- **New chat** starts a fresh conversation. **Previous chats** lets you reopen an older one and **Continue from this**.
- Use the menu to **Choose agent** or to change the panel to a side panel, a window or full screen.

It answers from your own content: notes, pages, files, mail and everything else you have added. The same conversation continues on Telegram.

## Assistant

- "What did we agree with the supplier about delivery?"
- "Log this expense: 45 for fuel today."
- "Save that as a page."
- "Remind me on Friday to call the electrician."

Follow-ups work, so "and the one before that?" keeps the thread. If it says it cannot do something, the agent is usually missing a tool group. Grant it on the Agents screen.

## Technical

- Each turn is built from recent messages, digests of older ones, facts that match your question, passages found by meaning and an "About the user" block from your Journal.
- One conversation store per agent covers the web, the app and Telegram.
- An agent's tools are exactly the tool groups it holds. Tools that need confirmation wait for you on the Pending screen.
- Each agent has a primary model and an optional backup route.
- Core tools: `search_nodes`, `search_chunks`, `read_section`, `node_read`, `entity_search`, `brain_capacity`.
- More: [The assistant](../03-using-jackdaw/02-assistant.md).
