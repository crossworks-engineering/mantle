# Create your account

Open your brain's address, create the owner login, then let the setup wizard get the brain ready.

## Before you start

- The address and the **setup code** the installer printed. Lost the code? On the server, run `bash scripts/install.sh --setup-code` in the install directory.
- An [OpenRouter](https://openrouter.ai/keys) key. It runs chat, indexing, images and voice.

## Create the login

1. Open the brain's address. The screen says **Create your login to begin.**
2. Enter your email, a password and the setup code.
3. Click **Create login**.

Only the first account signs up this way. After that the same screen is the normal sign-in. To add people later, see [Member and client logins](../05-admin/07-logins.md).

## Walk the setup wizard

The wizard starts by itself. It saves each step as you go, so you can close it and come back.

| Step | What you do |
|---|---|
| **Welcome** | Wait for **System status** to turn green. Add your name, timezone and locale. |
| **Your key** | Paste the OpenRouter key and click **Save & test**. |
| **Models** | Pick the assistant model and the faster worker model, or keep the defaults. |
| **Voice** | Optional: add an xAI key for a smoother voice. Skip to keep voice on OpenRouter. |
| **Memory** | Pick the embedding model and click **Enable memory search**. Without it, search by meaning stays off. |
| **Set up** | Click **Set up my assistant**. It creates the assistant and its background workers. |
| **Check** | Click **Run the checks** and look for green. |
| **Purpose** | Say what this brain is for. Every agent reads it. |
| **Personality** | Choose the assistant's character, name and creativity. |
| **Telegram** | Optional. See [Connect Telegram](05-connect-telegram.md). |
| **Done** | Click **Talk to your assistant**. |

You can change anything the wizard set later, under **Settings**.

## If it fails

- **System status shows red**: some services are not running. On the server, run `bash scripts/install.sh --check`, fix what it flags, then click **Re-check**.
- **The setup code is refused**: print it again with `bash scripts/install.sh --setup-code` and copy it exactly.
- **There is no sign-up screen**: the brain was installed without the web UI. Set it up from the [desktop app](../01-install/07-desktop-app.md) or with `bash scripts/onboard.sh` on the server.

## Next

- [Talk to the assistant](02-first-chat.md)
