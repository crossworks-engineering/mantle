---
title: Assistant
toolGroups: [memory-core]
---

## The assistant panel

The assistant is where you talk to your brain. It opens as a panel over any screen: click **Assistant** at the foot of the menu, or press Cmd/Ctrl+I.

- Type and press Enter to send. Shift+Enter adds a new line. You can also dictate with **Record voice note**, or attach an image or a document.
- If you sent too soon, type a correction while it works and press Enter. It stops and sends both.
- The icons in the panel's header: **Previous chats** reopens an older chat, and **Continue from this** picks it up again. **New chat** starts a fresh one. **Show as a side column**, **Show as a movable window** and **Show as full display** change its shape, on a wide screen. **Minimise** (or Esc) puts it away.
- The picker at the end of the header chooses the agent.
- A reply keeps coming while you move to another screen.

It answers from your own content: notes, pages, files, mail and everything else you have added. The same conversation continues on Telegram, and it is listed in **Chats**.

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
