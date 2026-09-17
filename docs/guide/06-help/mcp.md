---
title: MCP connector
---

## MCP connector

Lets an outside AI client, Claude Desktop, Claude Code, or anything else
speaking MCP, connect **to** your brain and use it as a tool.

This is the reverse of everything else in Settings. Elsewhere you're giving
Mantle access to your things; here you're giving something else access to
Mantle. The connector URL on this screen is the credential that does it, and the
list below shows every client currently holding one.

It's off by default. Turning it on is a deliberate act, and the disconnect
button next to a client revokes that client specifically.

## When to use this

Turn it on when you want to work in another AI tool but keep one brain. The
common shape is drafting or research in a desktop client while everything worth
keeping is written back here, so your memory doesn't fragment across
applications.

Treat the connector URL as a password. Anyone with it reaches your brain with
the tools you've granted, from anywhere, so paste it into a client's
configuration, not into a message, a document, or a shared repository.

Review the connected-clients list occasionally. A client you set up on a machine
you no longer use is still connected until you disconnect it here.

## Technical

The connector exposes the same tool surface the assistant uses, subject to the
same tool groups; an external client is not a privileged path around the
permission model. Tools requiring confirmation still queue for approval, and the
approval happens here rather than in the connecting client.

Every call arrives with the connecting client's identity, so the audit log
distinguishes "the assistant did this" from "a desktop client did this". That
distinction is the reason connections are individually revocable rather than
governed by a single on/off switch.

The health check makes a real round trip, which is worth using when a client
reports a connection it can't actually use; it separates "the connector is
down" from "the client is misconfigured".

Because the URL is the whole credential, rotating it invalidates every connected
client at once. That's the blunt instrument if you suspect it has leaked.
