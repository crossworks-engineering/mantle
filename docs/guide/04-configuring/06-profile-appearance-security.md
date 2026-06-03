# Profile, appearance & security

The small-but-important personal settings.

## Settings → Profile

Your identity and locale:

- **Name & avatar** — how you appear in the app.
- **Timezone** — used so the assistant resolves relative times correctly. "Remind me
  tomorrow at 3pm" becomes the right absolute moment because it knows your zone.
- **Locale** — date/number formatting and language hints for replies.
- **Reminder agent** — which agent's bot delivers your event reminders, if you run
  more than one.

Getting timezone right matters most — it's what makes scheduling and reminders land
at the time you actually meant.

## Settings → Appearance

- **Light / dark mode.**
- **Colour theme** — pick from the available themes. (Tags, charts, and accents all
  derive from the theme, so the whole app recolours consistently.)

Purely cosmetic; change it whenever.

## Settings → Security

- **Change your password.**

Mantle is single-user with a simple, private sign-in — there's no signup, OAuth, or
multi-user roles to manage. Your session lasts a long time, so you rarely re-enter
your password. If you ever need to invalidate every session at once, that's an
operator action (rotating the server's session secret), not a button here.

---

That's the end of the everyday configuration. For the deeper, more technical
material — observability, sharing/federation, self-hosting — see the
[technical section](../05-technical/01-architecture-overview.md).
