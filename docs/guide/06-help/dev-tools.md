---
title: API Console
---

## API Console

A built-in client for Mantle's own interfaces. Explore and run every REST route,
every MCP tool as the MCP server actually exposes it, and every tool your agents
hold — then send a real request and read the real response.

It answers a question nothing else does: *what does this actually return?* A
tool's description tells you what it's for; running it tells you the shape of
what comes back, which is what you need when something downstream is
misbehaving.

An HTTP request you've got working can be saved directly as a new agent tool,
which is the fastest path from "this endpoint works" to "the assistant can use
it".

## When to use this

Reach for it when a tool is failing and you need to know whether the fault is
the tool or the caller. Running the same call by hand settles that in one step.

It's also the honest way to check what an agent can see. A tool's output is what
the model reads, and output that looks fine to a person can be unusable to a
model — a wall of unlabelled ids, or an error buried in a success response.

Requests here are **real**. This isn't a simulation: a run that sends mail sends
mail, and a run that deletes something deletes it. Read the arguments before
running anything with a verb in its name.

## Technical

Calls execute with your owner identity and the same dispatcher the agents use,
so behaviour matches production exactly rather than approximating it. That's the
point — a console with its own code path would be a second implementation to
keep honest.

The MCP tool list is pulled live from the MCP server rather than from a stored
copy, so it reflects what an external client would genuinely be offered right
now, including anything you've just changed.

Saving a request as a tool captures the URL, method and templates, with
credentials left as a placeholder that resolves against the sealed key vault at
call time. The saved tool never contains the secret you tested with.

A tool created this way starts ungranted. It exists in the registry and reaches
no agent until you put it in a tool group.
