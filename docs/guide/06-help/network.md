---
title: Local network
---

## Local network

Local network joins this Mantle to your Tailscale network, so it can use a machine you own that is not on the public internet, such as a GPU box at home running a local model.

1. Under **Activate Tailscale**, paste an **Auth key** from your Tailscale admin console and set a **Device name**.
2. Click **Save key**, then **Activate**.
3. The **Connection** card shows the state. **Reachable devices** lists machines it can see.
4. On an agent or worker, set the route's base URL to the device name and port (for example port 11434 for Ollama or 1234 for LM Studio), and turn on **Reach via Tailscale**.

**Connect a device** walks you through setting up the other machine.

Use it for high-volume work such as extraction, which runs on everything that arrives. Keep a cloud backup route, because a home machine is sometimes offline.

## Assistant

The assistant cannot change network settings. Set them here.

## Technical

- Tailscale runs in userspace inside the stack, so it needs no special host privileges. Traffic goes through a local proxy.
- The auth key is encrypted with `MANTLE_MASTER_KEY`. You switch Tailscale on here with **Activate**, not with a setting at boot.
- Devices are reached by name through Tailscale's DNS.
- **Deactivate** disconnects and keeps the key. **Remove** forgets the key but does not disconnect.
- If the key leaks: **Deactivate**, then **Remove**, then revoke it in the Tailscale admin console.
- See [Local models](../05-admin/06-local-models.md).
