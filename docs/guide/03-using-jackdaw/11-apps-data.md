# App data

Give an app its own storage, connect it to live data, and ask the assistant about what it holds.

An app reaches data in only two ways: its own database, and tools you grant it. It cannot read your notes, tables or mail on its own.

## Pick the simplest kind

| The app needs | Use |
|---|---|
| Nothing stored (a calculator, a converter) | Pure code. Nothing to set up. |
| To remember entries, or fixed reference data | Its own database. |
| Your brain's data, or an outside service | A tool. |

Say which one you want when you ask Appsmith, for example "keep the entries in the app's own database".

## The app's own database

Each app gets one private database. No other app can open it.

- Appsmith creates the tables and can pre-load reference data, such as a price list from a spreadsheet you name.
- Users of a shared app at **Team** or **Client** level can write to it, so one app can be a shared job log.
- It is included in backups. **History > Take snapshot** keeps a copy you can restore.

## Live data through tools

1. Ask for it by name: "Show today's weather from OpenWeather."
2. Appsmith asks the Toolsmith agent to build and test a tool for that service.
3. If the service needs an API key you have not stored, Appsmith stops and says which key to add. Add it under **Settings > API keys**, then ask it to carry on. See [Models and API keys](../05-admin/05-models-and-keys.md).
4. The tool is added to the app's list of allowed tools. The app calls it through Jackdaw. Your key never reaches the app.

An app at **Team** level or lower may use an outside tool only after you switch on **External access** for that tool on **Settings > Tools**. A public link gets no tools at all.

For more on building tools, see [Toolsmith](../07-api/05-toolsmith.md).

## Ask the assistant about app data

The assistant can read every app's database, read-only:

- "How many open items are in my tracker app?"
- "What's in the inventory table of the stock app?"

Clear table and column names help it answer.

## Mirror app data into a Table

To see an app's table in **Tables**, ask the assistant: "Export the jobs table of the job log app to a Table." The Table is a read-only copy. It updates after each write in the app. The app stays the master, so edit the data in the app.

## If it fails

- **The app shows no data**: usually an API key is missing, or the tool is not on the app's allowed list. Ask the assistant to check and fix it with the app open.
- **It works for you but not for a member**: the outside tool needs **External access**.

## Next

- [Team and members](12-team.md)
- Screen help: [Apps](../06-help/apps.md)
