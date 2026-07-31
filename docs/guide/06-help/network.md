---
title: Local network
---

## Local network

Connects your Mantle to a machine you own that isn't on the public internet —
a GPU box at home, a server on the office LAN — so it can be used for
inference.

The problem this solves is ordinary and annoying: the useful hardware is behind
NAT with no fixed address, and the brain is on a VPS. Rather than opening ports
or renting a static IP, both ends join a private mesh network and reach each
other by name.

Once connected, that machine becomes selectable as a provider for agents and
workers, the same as any cloud provider.

## When to use this

The reason to bother is cost and privacy on the **high-volume** work. Chat is
occasional; extraction and summarisation run on every piece of content that
arrives, forever. Moving those onto hardware you already own is where the saving
is, and it means the bulk of your corpus is never sent anywhere.

Pair it with a cloud backup route rather than replacing cloud entirely. A home
machine will be offline sometimes — that's not a failure worth designing around
when a backup route covers it silently.

The auth key is a credential for your whole mesh. It's stored sealed here, but
generate one scoped to this purpose rather than reusing an admin key.

## Technical

Connectivity runs as a userspace sidecar rather than requiring kernel-level
networking privileges on the host, which is what lets it work inside a container
without special capabilities. Traffic to the remote machine goes through a local
proxy that the rest of the app treats as an ordinary HTTP endpoint.

Activation is deliberately a UI action rather than something that happens at
boot from an environment variable. The key is sealed with the brain's master key
and is loaded when you activate, so a stolen disk image doesn't come with a live
mesh membership attached.

Names resolve through the mesh's own DNS, so the remote box is addressed by a
stable name rather than an address that changes with its ISP.

Deactivating drops the connection without discarding the stored key; clearing
removes the key entirely. Use clear if the key may have leaked, since deactivate
alone leaves it ready to reuse.
