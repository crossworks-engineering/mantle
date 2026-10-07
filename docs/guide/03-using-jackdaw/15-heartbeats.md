# Heartbeats

Make an agent act on a schedule without being asked, with quiet hours and a stopping point.

A heartbeat names a skill (what to do), an agent (who does it, with its tools), a schedule, and a surface where its message lands. It keeps a small state between firings, so it can remember what it already asked. It stops when its skill marks the job complete, or after a set number of firings.

Mantle ships one: **Brain health**, a weekly check of capacity and search quality that stays silent unless something needs attention.

## Before you start

Write the skill first. A heartbeat's skill describes the job for one firing. See [Skills and tools](14-skills-and-tools.md).

## Create a heartbeat

1. Open **Settings > Heartbeats** and click **New heartbeat**.
2. Fill in **Name**, then pick the **Agent** and the **Skill**.
3. Under **Schedule**, choose:
   - **interval**: every so many minutes, with optional jitter.
   - **once**: one firing at a set time.
   - **manual**: only when you click **Fire now**.
4. Under **Surface**, choose **telegram** or **web**.
5. Under **Gates**, choose **none**, **sensible** or **custom**:
   - **Quiet from** / **Quiet to**: no firing in these hours (your profile timezone unless you set another).
   - **Min idle**: skip if you were active in the last few minutes.
   - **Cooldown**: the least time between two firings.
6. Optionally set **Earliest at** and **Max fires**.
7. Save.

Gates default to nothing. A heartbeat with no gates fires exactly on schedule, at night too.

## Manage heartbeats

- **Pause** and **Resume** stop and restart a heartbeat.
- **Fire now** runs it once, straight away.
- Open a heartbeat to see its state and recent firings, including the ones a gate skipped. Each run links to its trace.

When you reply to a heartbeat's message, the normal assistant answers, knowing the heartbeat is open, and updates or completes it.

## Mind the cost

Every firing is a model call, even when it sends nothing. A frequent heartbeat on an expensive agent shows up on the spend graph. Give its agent only the tool groups the job needs.

## Check it worked

Click **Fire now**, then open the heartbeat. The firing appears in its log with a link to the trace.

## Next

- [Profile and appearance](16-profile.md)
- Screen help: [Heartbeats](../06-help/heartbeats.md)
