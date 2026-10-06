# Use local models

Run chat models on your own machine and point agents or workers at them, even when Mantle runs on a cloud server. A bundled Tailscale connection reaches the machine without opening ports on your router.

## Before you start

- A machine that runs a model server with an OpenAI-compatible API, such as Ollama (port 11434) or LM Studio (port 1234).
- A free Tailscale account.
- An admin login.

## Put the model machine on your tailnet

A tailnet is your private Tailscale network.

1. Install Tailscale on the model machine and sign in. On macOS use the app (`brew install --cask tailscale`), not the command-line formula.
2. Make the model server listen on the network, not only on `127.0.0.1`.
3. In the Tailscale admin console, open **Keys** and generate an auth key. Make it **Reusable** and leave **Ephemeral** off.

The **Connect a device** guide on **Settings > Local network** walks through these steps per platform.

## Connect Mantle

1. Open **Settings > Local network**.
2. Paste the key into **Auth key** and click **Save key**.
3. Click **Activate**.

Mantle joins your tailnet. Your model machine appears under **Reachable devices**.

## Point a route at the model

1. Open **Settings > Agents** or **Settings > AI workers** and select one.
2. Set the route's provider to `local`.
3. In **Base URL**, pick your machine from the list. It fills in port 1234 (LM Studio). For Ollama change it to 11434, for example `http://<machine>:11434/v1`.
4. Switch on **Reach via Tailscale**.
5. Pick the model and save.

If Mantle and the model machine share a local network, you can leave **Reach via Tailscale** off and use the machine's local address.

Give the route a cloud model as its backup, so replies keep coming when the machine is off. See [Models and API keys](05-models-and-keys.md).

## Local embeddings

To keep search vectors on the box as well, switch on **Local embedder** in **Settings > Services**, then choose provider `local` in **Settings > Embedding** and click **Rebuild index**. It needs a large server: well over 16 GB of memory, or a GPU. See [Optional services](04-services.md).

## Check it worked

**Settings > Local network** shows the connection as **Running**. Send the agent a message, then open the turn in **Traces** and check the model step names your local model.

## If it fails

- **The machine is not listed**: it is offline, or not signed in to the same tailnet.
- **Requests time out**: the model server listens only on `127.0.0.1`, or the port in **Base URL** is wrong.

## Next

- [Local network screen help](../06-help/network.md)
- [Models and API keys](05-models-and-keys.md)
