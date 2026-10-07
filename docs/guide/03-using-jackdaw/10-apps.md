# Apps

Have the assistant build a small app for you, try it, refine it, then make it live and share it.

An app is a small single-purpose screen: a tip calculator, a job sheet, a stock count, a dashboard. The **Appsmith** agent writes the code. It runs in a sealed sandbox inside Jackdaw, in your theme.

## Build an app

1. Ask the assistant what it should do, not how to code it: "Build me an app for logging generator hours: date, hours run, who ran it, and a total per month."
2. Appsmith writes the app, builds it and fixes its own build errors. It tells you where to find the app.
3. Open it from **Apps**. The **Builder** view shows the draft running.
4. With the app open, ask the assistant for changes: "Round the totals", "Add a filter by month". Each change rebuilds the preview.
5. Click **Commit** to make the draft live.

You can also click **New app** on the Apps screen first, then describe it to the assistant with the app open.

## Draft and live

| Button | What it does |
|---|---|
| **Preview** | Builds the draft and refreshes the preview. The live app does not change. |
| **Commit** | Builds the draft and makes it live. A draft that does not build never goes live. |
| **Discard** | Throws the draft away. |

## Views

Pick a view from the **View** menu in the app header:

- **Builder**: the running app.
- **Code**: the source files. Edit by hand, **Format**, then **Save** to the draft. Save before asking Appsmith for more, because its edits replace unsaved ones.
- **History**: every commit as a version, plus snapshots of code and data. **Take snapshot** before a risky change. Restore code to the draft, or restore the data.
- **Activity**: who opened and used the shared app.

## Share an app

After the first commit, click **Access** and pick a level:

- **Team**: members run it signed in with their own logins, with the tools you granted it. See [Team and members](12-team.md).
- **Client**: signed-in clients run it.
- **Public**: anyone with the link sees it full screen, read-only, with no access to your brain's tools.

Treat a public link as a secret. Set the level back to **Admin** to close it.

## Tips

- Start small, then ask for one change at a time.
- One app, one job. Two small apps work better than one large one.
- If it needs outside data, name the service. See [App data](11-apps-data.md).

## Next

- [App data](11-apps-data.md)
- Screen help: [Apps](../06-help/apps.md)
