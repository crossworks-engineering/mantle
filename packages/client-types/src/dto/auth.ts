/**
 * First-run auth on the wire: the public bootstrap state a login screen reads
 * before anyone has signed in, and the first-run signup body.
 */

/** GET /api/auth/bootstrap-state. Public and boolean-only. */
export type BootstrapStateDTO = {
  /** No account exists yet: the login screen shows "create your login". */
  firstRun: boolean;
  /** Signup asks for the installer's setup code (MANTLE_SETUP_CODE). Only
   *  ever true while `firstRun` is. Absent on a brain from before the field. */
  setupCodeRequired?: boolean;
};

/** POST /api/auth/signup. Open only while no account exists. */
export type SignupBody = {
  email: string;
  password: string;
  /** The setup code the installer printed. Required when the bootstrap
   *  state says `setupCodeRequired`; dashes, spaces and case are ignored. */
  setupCode?: string;
};

/** The `reason` of a refused signup: `setup-code` for a wrong or missing
 *  code. (The other 403, "an account already exists", carries no reason.) */
export type SignupRefusedReason = 'setup-code';

// ── Company sign-in (OIDC; brain docs/oidc-sign-in.md) ─────────────────────

/** MANTLE_OIDC_MODE as the brain reads it: `off` (the default; the sign-in
 *  screen stays as it is), `optional` (passwords work; a linked login may
 *  also use company sign-in) or `required` (a linked login uses company
 *  sign-in only; an unlinked one signs in with its password and links). */
export type OidcMode = 'off' | 'optional' | 'required';

/** GET /api/auth/oidc/config (public, no login). Off: `{ mode: 'off' }`
 *  only, and the client shows no company sign-in at all. Otherwise the
 *  button's label ("Sign in with {label}"); the button opens
 *  `GET /api/auth/oidc/start?return=<path>` as a top-level navigation. */
export type OidcConfigDTO = { mode: 'off' } | { mode: 'optional' | 'required'; label: string };

/** GET /api/auth/oidc/status (the signed-in login; 401 without one). Off:
 *  `{ mode: 'off' }` only. */
export type OidcStatusDTO =
  | { mode: 'off' }
  | {
      mode: 'optional' | 'required';
      label: string;
      /** This login is linked to a company account. */
      linked: boolean;
      /** The original account: keeps its password in every mode. */
      owner: boolean;
      /** An admin marked this login an outside person: it keeps its
       *  password in required mode, and is offered no link. */
      outside: boolean;
      /** Show the dismissible "Sign in with {label} next time. Link now."
       *  card: unlinked, not outside, not dismissed in the last 7 days. */
      offer: boolean;
      /** Required mode and this login must link before it goes on (a
       *  session from before the mode changed): show only the link step. */
      linkRequired: boolean;
      /** DELETE /api/auth/oidc/link is open to it (optional mode, or an
       *  owner or outside login, while linked). */
      canUnlink: boolean;
    };

/** POST /api/auth/oidc/link { password?, returnTo? }: start a link. Opens
 *  on the 5-minute ticket a password sign-in on this browser set (used up
 *  by the start), or on
 *  the session with the login's password typed again. Navigate the window
 *  to `url`; the provider returns to the brain, which links and sends the
 *  browser to `returnTo` with `?oidc=linked` (or `?oidc=<OidcCallbackError>`). */
export type OidcLinkStartBody = { password?: string; returnTo?: string };
export type OidcLinkStarted = { url: string };

/** The `code` of a refused password sign-in (403 from /api/auth/login,
 *  /api/auth/token, /api/auth/device-login and /api/auth/mobile-login), or
 *  of a refused link start:
 *  - `sso-required`: this login signs in with company sign-in only.
 *  - `sso-link-required`: the password was right; link before going on.
 *    The cookie login also set the ticket: show the one "Link your company
 *    sign-in" step, whose button is POST /api/auth/oidc/link with no body.
 *    The token logins set none: link on the web first.
 *  - `password-needed`: a link start with no fresh ticket: ask for the
 *    password and send it.
 *  - `already-linked`: the login holds a link already.
 *  - `sso-session`: POST /api/auth/pair from a session company sign-in
 *    made: a phone cannot be paired from it yet (it would outlive the
 *    session); the phone signs in itself. */
export type OidcRefusalCode =
  'sso-required' | 'sso-link-required' | 'password-needed' | 'already-linked' | 'sso-session';
export type OidcRefusal = { error: string; code: OidcRefusalCode };

/** The `oidc` query value the callback sends the browser back with:
 *  `linked` on a link, else why it stopped. A sign-in that works carries
 *  none. Failures of a sign-in land on `/login?oidc=<code>`. */
export type OidcCallbackResult =
  | 'linked'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'unavailable'
  | 'not-linked'
  | 'not-allowed'
  | 'taken'
  | 'has-other';

/** POST /api/auth/oidc/offer: hide the link offer for 7 days. */
export type OidcOfferDismissed = { ok: true; until: string };

/** GET /api/users/oidc (the users area): who is linked. Off: `{ mode: 'off' }`. */
export type OidcAdminSummaryDTO =
  | { mode: 'off' }
  | {
      mode: 'optional' | 'required';
      label: string;
      /** MANTLE_OIDC_OUTSIDE (on by default): the operator allows outside
       *  marks. Off, a
       *  mark is refused and keeps no password. */
      outsideAllowed: boolean;
      counts: {
        /** Logins not disabled. */
        active: number;
        linked: number;
        /** Active, not linked, not the original account, not outside:
         *  in required mode each signs in with its password once and is
         *  asked to link. */
        unlinked: number;
        /** Marks that keep a password now (allowed, not an Admin user, not
         *  linked). */
        outside: number;
      };
      logins: {
        loginId: string;
        email: string;
        displayName: string | null;
        owner: boolean;
        admin: boolean;
        outside: boolean;
        linked: boolean;
        linkedAt: string | null;
        lastUsedAt: string | null;
      }[];
    };

/** PATCH /api/users/:id/oidc { outside }: mark an outside person (keeps a
 *  password in required mode) or clear it. DELETE removes the login's link. */
export type OidcAdminOutsideBody = { outside: boolean };
