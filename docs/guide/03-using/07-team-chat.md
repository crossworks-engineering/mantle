# Team Chat

**Team Chat** lets the people you work with talk to your brain — without giving
them your brain. You mark a Contact as a *team member*, hand them a short
token, and they get their own chat at `/team` where they can ask the assistant
anything the brain knows: project history, documents, decisions, "what was
agreed about X". They ask; the brain answers from its memory, with the same
citations you get.

What they can **never** do is change anything. The responder that serves team
members is strictly read-only. When a member asks for a change — *"please
update the site register, here's the new sheet"* — the request (attachment and
all) lands as a **task in your review queue**. You decide, you act, and your
reply goes straight back into their chat.

## Making someone a team member

Membership lives on **Contacts**:

1. Open the person in `/contacts` and flip the **Team member** switch.
2. A short token is shown **once** — copy it and give it to them over a channel
   you trust. (Lost it? **Regenerate** mints a new one and kills the old.)
3. They open `/team` on your Mantle's address, enter the token, and they're in.

That one token is their entire identity here: it also admits them to any app
you've shared in *team* mode (see [Apps](06-apps.md)), and everything they do
is recorded against their name. To remove someone, flip the switch off or
delete the contact — their access dies instantly, even mid-conversation.

## What a team member sees

A clean chat, and nothing else — no sidebar, no settings, none of your screens.
Their conversation is a single ongoing thread that remembers them: they can
leave and come back weeks later and pick up where they left off. They can
attach files (a photo of a form, an updated spreadsheet) and watch the
assistant work in real time, the same live progress you see.

Each member sees only their **own** thread. There is no member-to-member chat,
and no way to read anyone else's conversation.

## Requests — how changes actually happen

The team responder holds exactly one "write" ability: filing a request. Any ask
that would change the brain becomes a task tagged as a team request, stamped
with who asked, from which message, with which attachments. Nothing is applied
automatically.

You work these from the **Requests** tab on the Team screen: read the request,
do the change (or don't), then hit **Reply** — your answer is posted into the
member's chat, closing the loop in the same place they asked.

## The Team screen (yours)

The sidebar **Team** entry opens `/team-admin`, your window into all of it:

- **Chats** — every member, ordered by recent activity, with unread badges.
  Click one to read their thread; every assistant answer links to its full
  trace so you can see exactly which tools ran and what they read.
- **Requests** — the open review queue, with reply and mark-done.
- **Access log** — every sign-in, question, and denied attempt, per member.

## Email and journal stay private by default

Team members can draw on your brain's *knowledge* — notes, pages, tables,
files, search. Your **email and journal do not qualify** unless you explicitly
opt in: a switch on the Team screen header, guarded by a confirmation that
spells out what you'd be exposing. Leave it off (the default) and team answers
simply never read your mailbox or journal.

## Safety, briefly

- **One token, one person, revocable in one click** — membership is re-checked
  on every single request, so revocation is immediate.
- **Read-only by construction** — the team responder has no editing tools at
  all; the request queue is the only write path, and it's human-reviewed.
- **Everything is audited** — per-member access log, plus a full trace for
  every answer.
- **Spend is capped** — each member is rate-limited with a daily turn cap, so
  a leaked token can't run up your model bill.

One thing to be clear-eyed about: within its limits, a team member can ask
about *anything the brain knows* (outside email/journal). Team Chat is built on
the principle that the team **is** the trust boundary — if some material
shouldn't be visible to this team at all, it belongs in a separate brain, not
behind a hoped-for filter. See the [security overview](../../security.md) for
the full model.
