# Desktop app

Jackdaw for Linux, macOS and Windows opens a brain that is already installed. It adds desktop notifications and a tray icon, and can hold several brains.

## Install

Download the installer for your system from the [Jackdaw releases page](https://github.com/crossworks-engineering/jackdaw/releases):

| System | File |
|---|---|
| Linux | `.deb` (amd64) or `.AppImage` (x86_64) |
| macOS (Apple Silicon) | `.dmg` or `.zip` |
| Windows | `Setup.exe` |

On macOS, drag **Jackdaw** to **Applications**. Then do the steps in [Open it the first time on a Mac](#open-it-the-first-time-on-a-mac).

On Windows, the installer is not signed. If SmartScreen says **Windows protected your PC**, click **More info**, then **Run anyway**.

## Open it the first time on a Mac

The macOS build is not yet signed with an Apple Developer ID. macOS blocks the first launch. You allow it one time.

1. Open **Jackdaw**. macOS says it could not verify the app. Click **Done**.
2. Open **System Settings > Privacy & Security**.
3. Scroll down to **Security**. Find the line about Jackdaw and click **Open Anyway**.
4. Type your Mac password. Click **Open**.

After this, Jackdaw opens normally.

:::caution[macOS says the app is damaged]
Builds up to 0.6.251 show "Jackdaw is damaged and can't be opened", with no **Open Anyway**. The file is not damaged. Remove the download flag in Terminal, then open the app:

```bash
xattr -dr com.apple.quarantine /Applications/Jackdaw.app
```

A newer build does not need this.
:::

## Connect to your brain

1. Open Jackdaw. The **Connect to your Mantle** screen appears.
2. Type your brain's address, the same one you open in a browser, and click **Connect**. A bare name such as `brain.example.com` gets `https://` added. For a brain on plain HTTP, type `http://` in front.
3. Sign in with your usual email and password.

On a brain with no account yet, the sign-in screen asks you to create your login with the setup code instead. See [Create your account](../02-first-steps/01-create-account.md). This is how you set up a brain installed with no web UI.

## More than one brain

Use **Brain > Add or Remove a Brain…** (Ctrl+Shift+B, or Cmd+Shift+B on a Mac). Each brain keeps its own login, and the **Brain** menu switches between them.

## Updates

On Linux and Windows the app checks for a new version at launch and every 4 hours, downloads it in the background, and installs it when you quit. The macOS build cannot update itself: download each new release by hand.

## If it fails

- **Couldn't reach a Mantle server at …**: open the same address in a browser. If that fails too, the server is down or the address is wrong.
- **macOS blocks the app**: see [Open it the first time on a Mac](#open-it-the-first-time-on-a-mac).

## Next

- [Talk to the assistant](../02-first-steps/02-first-chat.md)
