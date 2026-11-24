/**
 * The company sign-in button's label ("Sign in with {label}",
 * docs/oidc-sign-in.md), as a screen sets it: the box's setup screen
 * (PUT /api/users/sso-setup) or a Control Center's Fleet sign-in page
 * (POST /api/fleet/sso, the box's sso_set). The sign-in screen shows it before
 * anyone signs in, so a value that does not fit is refused, never stored.
 *
 * The rule, after the value is trimmed: one line, 1 to 60 characters, letters
 * (any script), digits, spaces and the marks . , - ' & ( ) +, with at least
 * one letter or digit. No control character, no markup, no line break, no
 * other mark. An empty value clears the label (the default applies again).
 */

/** The most characters of a label. */
export const SSO_LABEL_MAX = 60;

/** The label's pattern, applied to the trimmed value. */
export const SSO_LABEL_RE = /^(?=.*[\p{L}\p{N}])[\p{L}\p{N} .,'&()+-]{1,60}$/u;

/** A label as typed: trimmed, `null` for an empty one (clear the label), or
 *  `false` when it does not fit the pattern. */
export function ssoLabelValue(raw: string): string | null | false {
  const v = raw.trim();
  if (v === '') return null;
  return SSO_LABEL_RE.test(v) ? v : false;
}
