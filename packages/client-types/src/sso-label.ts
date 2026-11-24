/**
 * The company sign-in button's label ("Sign in with {label}",
 * docs/oidc-sign-in.md), as a screen sets it: the box's setup screen
 * (PUT /api/users/sso-setup) or a Control Center's Fleet sign-in page
 * (POST /api/fleet/sso, the box's sso_set). The sign-in screen shows it before
 * anyone signs in, so a value that does not fit is refused, never stored.
 * Every place that takes a label asks ssoLabelValue: the box route, the box's
 * signed case, the CC route and the CC's ask, and the read of the row.
 *
 * The rule, on the value put in NFC and trimmed: 1 to 60 characters (code
 * points), each a letter (any script), a digit, a combining mark right after
 * a letter, a digit or another mark (an accent, a Devanagari or Tamil vowel
 * sign, an Arabic vowel mark), a space, or one of the marks
 * . , - ' ’ & ( ) +; with at least one letter or digit. No control
 * character, no format character (right-to-left marks and overrides,
 * zero-width characters), no no-break space, no emoji, no markup, no line
 * break, no other mark. An empty value clears the label (the default applies
 * again).
 *
 * The curly apostrophe (U+2019) is taken: phones and macOS type it in place
 * of ' in a name such as O’Neil, and it is a plain mark, not markup.
 */

/** The most characters (code points, after NFC) of a label. */
export const SSO_LABEL_MAX = 60;

/** The label's pattern (flag `u`), applied to the value in NFC, trimmed. */
export const SSO_LABEL_RE = /^(?=.{1,60}$)(?=.*[\p{L}\p{N}])(?:[\p{L}\p{N}]\p{M}*|[ .,'’&()+-])+$/u;

/** The one refusal text of a label that does not fit. */
export const SSO_LABEL_REFUSED = `The label is 1 to ${SSO_LABEL_MAX} characters: letters (with their accents), digits, spaces and . , - ' ’ & ( ) + only, with at least one letter or digit.`;

/** A label as typed, in NFC and trimmed: the value to store, `null` for an
 *  empty one (clear the label), or `false` when it does not fit. */
export function ssoLabelValue(raw: string): string | null | false {
  const v = raw.normalize('NFC').trim();
  if (v === '') return null;
  return SSO_LABEL_RE.test(v) ? v : false;
}
