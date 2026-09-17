# Profile, appearance & security

The small-but-important personal settings.

## Settings → Profile

Your identity and locale:

- **Name & avatar**: how you appear in the app.
- **Timezone**: used so the assistant resolves relative times correctly. "Remind me
  tomorrow at 3pm" becomes the right absolute moment because it knows your zone.
- **Locale**: date/number formatting and language hints for replies.
- **Reminder agent**: which agent's bot delivers your event reminders, if you run
  more than one.
- **House style**: your writing rules, in your own words (e.g. "never use em
  dashes"). Every agent follows them in anything it writes for you, chat
  replies, pages, tables, emails, and your rules win over the built-in writing
  guidance. They're never applied to quoted text, code, or a document an agent
  is copying verbatim. Leave blank to keep the defaults.

Getting timezone right matters most; it's what makes scheduling and reminders land
at the time you actually meant.

## Settings → Appearance

- **Light / dark mode.**
- **Colour theme**: pick from the available themes. (Tags, charts, and accents all
  derive from the theme, so the whole app recolours consistently.)

Purely cosmetic; change it whenever.

## Settings → Logins

- **Reset a password**: including your own; there's no recovery mail in the loop,
  so setting a new one directly is the whole flow.
- **Devices**: the live sessions signed in as that login. Revoke one to end it
  immediately.

A brain has one owner and one set of data; a login is a way *in*, not a separate
world, and there are no permission tiers to manage. Sessions last a long time, so
you rarely re-enter a password. To invalidate every session at once, that's still
an operator action (rotating the server's session secret), not a button here.

There used to be a separate **Security** screen. Its password form duplicated the
reset on this screen, so both halves now live here.

---

That's the end of the everyday configuration. For the deeper, more technical
material (observability, sharing/federation, self-hosting) see the
[technical section](../05-technical/01-architecture-overview.md).
