---
title: Recall
toolGroups: [recall-read]
---

## Recall

Memory maps for agents. A map is a small set of pages an agent walks node by
node: each node carries a piece of knowledge plus **options**; signposts that
say where to go next and when. One map's root is its index, the entry point.
Pages tagged `prompt` are reusable procedures agents find by meaning.

This screen is the map workshop. The catalog lists every map with its compile
state; open one to see its lint report, its nodes, and the **routing graph**;
the whole map drawn as nodes and edges, with the entry marked and orphaned
nodes flagged. The **Routing** button on a node edits its options without
hand-writing the markdown convention: pick a target, write the label and the
"use when" line, and the section is written for you. On the graph, each option
carries a chip; hover or focus it for the full label and its "use when" line,
and the **Labels / Dots / Off** toggle sets how much a dense map shows at once.

Maps are authored as ordinary pages, and **New** on this screen writes one for
you: a map, or a standalone prompt. Inside a map, **Add node** creates the page
AND the option that leads an agent to it, in one step. An index that has
children but no options fails its lint, so the two are never separated. Each
dialog runs the real lint as you type and tells you, before you save, whether
the page will compile.

You can also turn a page you are already writing into a prompt: open it and use
**Make a prompt** in its header. It adds the `Use when` line and the tags in the
order that keeps the compile clean.

Tagging a page tree's root `recall` by hand still works and does the same thing.
Only you can set that tag, or `prompt`. Every commit recompiles the map; if the
new version fails its lint, agents keep reading the last good version and the
report here says why.

## Assistant

- "Which Recall maps do we have?"
- "Open the registry map and summarise the fleet node."
- "Draft a new node for the deploy procedure under the ops map."

Agents read maps through the `recall_index` / `recall_open` / `recall_go` /
`recall_match` tools. They can draft map pages, but they cannot activate them;
the `recall` and `prompt` tags are yours alone, which is what keeps injected
content from ever becoming a served map.

## Technical

Pages are the authoring layer; commits compile them into small serving rows
(`recall_maps` / `recall_nodes`) so an agent read is one indexed row; no
document parsing on the hot path. Bodies are budgeted at 6,000 characters per
node and 100 nodes per map. Prompts are embedded (768-dim) for `recall_match`.
Lint errors block the compile, never the commit. The routing editor writes the
`## Options` section through the same code path the agent authoring tools use,
so both produce byte-identical markdown.
