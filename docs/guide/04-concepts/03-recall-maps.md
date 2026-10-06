# Recall maps

A Recall map is a small set of cards you write for agents, so they follow your way of doing a job instead of guessing it from search results.

## How a map works

- A **card** holds one piece of know-how, up to 6,000 characters.
- Each card has **options**: signposts to other cards, each with a "use when" line. An option can also lead to another map.
- Every map starts at its **entry card**. An agent opens the map there and follows the options that fit its task, one card at a time.
- A card can be a **prompt**: a reusable procedure agents find by meaning. An agent describes its task in a line, and the closest prompts come back.

Agents read maps with four tools: `recall_index` (list the maps), `recall_open` (open a map), `recall_go` (go to a card) and `recall_match` (find a prompt). Claude and other MCP clients get the same tools.

## What stays yours

An agent may add and edit cards, and every change is logged under **Revisions**, where you can restore it. Three things only you do:

- **Publish** a map. Agents see only published maps.
- **Confirm a prompt.** An agent can ask for a card to be a prompt, but it never matches until you confirm it.
- **Delete** a map.

If an agent changes the words of a confirmed prompt, it waits for your confirm again.

## Example

You write a map called "Release a new version":

- The entry card says: "Releases go from main only. Pick the step you need."
- Option "use when the tests have not run yet" leads to a card with the test command.
- Option "use when tests pass" leads to a card with the release steps.

The release card is a confirmed prompt. Weeks later you tell Claude Code, "ship this fix". It runs `recall_match` with "release a new version", gets your card, and follows your steps instead of inventing its own.

## Where to edit them

Open **Recall** in the menu. **New map** makes a map with its entry card written. The **Graph** view draws the cards and their options ([Screen help: Recall](../06-help/recall.md)).

## Next

- [Connect Claude over MCP](../07-api/01-connect-claude.md): let Claude read your maps.
- Deep developer reference: [recall.md](../../recall.md)
