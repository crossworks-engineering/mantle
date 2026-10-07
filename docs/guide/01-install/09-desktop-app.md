# Desktop app

Jackdaw for Linux, macOS and Windows opens a brain that is already installed. It adds desktop notifications and a tray icon, and can hold several brains.

## Install

Download the installer for your system from the [Jackdaw releases page](https://github.com/crossworks-engineering/jackdaw/releases):

| System | File |
|---|---|
| Linux | `.deb` (amd64) or `.AppImage` (x86_64) |
| macOS (Apple Silicon) | `.dmg` or `.zip` |
| Windows | `Setup.exe` |

On macOS, drag **Jackdaw** to **Applications**, then open it. The Mac app is signed and notarized by Apple, so it opens with no warning.

On Windows, the installer is not signed. If SmartScreen says **Windows protected your PC**, click **More info**, then **Run anyway**.

:::caution[macOS says the app is damaged]
Mac builds up to 0.6.251 were not signed. macOS shows "Jackdaw is damaged and can't be opened". The file is not damaged. Download the newest release instead. To keep an old build, remove the download flag in Terminal, then open the app:

```bash
xattr -dr com.apple.quarantine /Applications/Jackdaw.app
```
:::

## Connect to your brain

1. Open Jackdaw. The **Connect to your Mantle** screen appears.
2. Type your brain's address, the same one you open in a browser, and click **Connect**. A bare name such as `brain.example.com` gets `https://` added. For a brain on plain HTTP, type `http://` in front.
3. Sign in with your usual email and password.

On a brain with no account yet, the sign-in screen asks you to create your login with the setup code instead. See [Create your account](../02-first-steps/01-create-account.md). This is how you set up a brain installed with no web UI.

## More than one brain

Use **Brain > Add or Remove a Brain…** (Ctrl+Shift+B, or Cmd+Shift+B on a Mac). Each brain keeps its own login, and the **Brain** menu switches between them.

## Updates

The app checks for a new version at launch and every 4 hours, downloads it in the background, and installs it when you quit. On a Mac, this needs a signed build: if you have 0.6.251 or earlier, download the next release by hand one time.

## If it fails

- **Couldn't reach a Mantle server at …**: open the same address in a browser. If that fails too, the server is down or the address is wrong.
- **macOS says the app is damaged**: you have a build up to 0.6.251. Download the newest release.

## Next

- [Talk to the assistant](../02-first-steps/02-first-chat.md)
