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
 *  button's label ("Sign in with {label}"). A client that holds a bearer
 *  (the web app, the desktop app, the phone) opens
 *  `GET /api/auth/oidc/start?redirect=<target>&challenge=<S256>` (see
 *  OidcHandoff); `?return=<path>` signs the browser itself in with a
 *  cookie. */
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
      /** A linked login confirms key creation with a fresh sign-in; this says
       *  whether it may type its password instead (optional mode, or the
       *  original account: a provider can be down). */
      passwordConfirms: boolean;
    };

/**
 * Handing a flow to a client that is not the browser's cookie session
 * (docs/oidc-sign-in.md "Handing a sign-in to a client"). The client makes a
 * PKCE verifier (RFC 7636: 43 to 128 unreserved characters), keeps it, and
 * sends its S256 challenge (43 base64url characters) and where the flow ends,
 * one exact URL:
 *  - `mantle://oidc`, the desktop app and the phone;
 *  - `<origin>/auth/oidc`, the web app's own page, where the origin is this
 *    brain's public origin, MANTLE_CLIENT_ORIGIN or a named
 *    MANTLE_API_CORS_ORIGINS entry.
 * The browser comes back there with a fragment:
 * `#oidc=code&code=<c>&purpose=<OidcHandoffPurpose>&iss=<brain>`, or
 * `#oidc=<OidcCallbackResult>&iss=<brain>` when the flow stopped. Before
 * spending anything, compare `iss` with the origin the client itself connected
 * to, never with a value a brain told it: a device can hold several brains,
 * and a code from another one must never be sent here. So a client must
 * connect to the brain's public URL (MANTLE_PUBLIC_URL), not an alias.
 * A code lasts 2 minutes, works once and is worth nothing without the
 * verifier. A flow to `mantle://oidc` always asks the person to sign in at the
 * provider, and fails on a provider that sends no `auth_time`.
 */
export type OidcHandoff = { redirect: string; challenge: string };
export type OidcHandoffPurpose = 'signin' | 'link' | 'fresh';

/** POST /api/auth/oidc/link: start a link.
 *
 * With `handoff` (any client, a bearer one too): opens on the session or a
 * held login, on `ticket` (OidcRefusal.ticket or oidcTicket from a token
 * sign-in), or on the session with the login's password typed again. Open
 * `url` in the browser, then spend the code at POST /api/auth/oidc/exchange:
 * the link is made there.
 *
 * With no `handoff`: the browser's own cookie session. Opens on the 5-minute
 * ticket a password sign-in on this browser set (used up by the start), or
 * on the session with the login's password typed again. Navigate the window
 * to `url`; the provider returns to the brain, which links and sends the
 * browser to `returnTo` with `?oidc=linked` (or `?oidc=<OidcCallbackError>`). */
export type OidcLinkStartBody = {
  password?: string;
  returnTo?: string;
  handoff?: OidcHandoff;
  ticket?: string;
};
export type OidcLinkStarted = { url: string };

/** POST /api/auth/oidc/exchange (no login): spend a code from the flow's
 *  redirect, for a sign-in or a link. `fresh` codes are not spent here: they
 *  go in the request they confirm (OidcFreshProof). */
export type OidcExchangeBody = { code: string; verifier: string; deviceName?: string };

/** A sign-in's answer: a bearer, as POST /api/auth/device-login answers one.
 *  It lasts MANTLE_OIDC_SESSION_HOURS and is never rotated: when it ends
 *  the person signs in through the provider again. `linked` when a link
 *  from a held login signed it in. */
export type OidcTokenAnswer = {
  token: string;
  expiresIn: number;
  expiresAt: string;
  deviceId: string;
  role: string;
  loginId: string;
  brainId?: string;
  sso: true;
  linked?: true;
};
/** A link made for a login that already has its session. */
export type OidcLinkAnswer = { linked: true };
export type OidcExchanged = OidcTokenAnswer | OidcLinkAnswer;

/** The `code` of a refused exchange: the code is gone (`expired`, also a
 *  wrong verifier), the account is another login's (`taken`), or this login
 *  already holds another account of the provider (`has-other`). */
export type OidcExchangeRefusal = { error: string; code: 'expired' | 'taken' | 'has-other' };

/** POST /api/auth/oidc/fresh: a linked login confirms who it is with a fresh
 *  company sign-in (the provider asks again: prompt=login, max_age=0), in
 *  place of its password. Open `url` in the browser, then send the code and
 *  the verifier as `fresh` in the request it confirms (OidcFreshProof). */
export type OidcFreshStartBody = OidcHandoff;
export type OidcFreshStarted = { url: string };
/** A fresh sign-in spent on a request: one code, one request. */
export type OidcFreshProof = { code: string; verifier: string };

/** The `code` of a refused password sign-in (403 from /api/auth/login,
 *  /api/auth/token, /api/auth/device-login and /api/auth/mobile-login), or
 *  of a refused link start:
 *  - `sso-required`: this login signs in with company sign-in only.
 *  - `sso-link-required`: the password was right; link before going on.
 *    The cookie login also set the ticket: show the one "Link your company
 *    sign-in" step, whose button is POST /api/auth/oidc/link with no body.
 *    The token logins answer `ticket` instead: send it with the handoff.
 *  - `password-needed`: a link start with no fresh ticket: ask for the
 *    password and send it.
 *  - `already-linked`: the login holds a link already.
 *  - `sso-session`: a session company sign-in made cannot do this: pair a
 *    phone or a chat, or reset its own password with no old password, since
 *    each would outlive the session. The phone signs in itself. */
export type OidcRefusalCode =
  'sso-required' | 'sso-link-required' | 'password-needed' | 'already-linked' | 'sso-session';
/** `ticket`: a token login's held ticket on `sso-link-required` (5 minutes,
 *  good only to start the link). */
export type OidcRefusal = { error: string; code: OidcRefusalCode; ticket?: string };

/** The `oidc` query value the callback sends the browser back with:
 *  `linked` on a link, else why it stopped. A sign-in that works carries
 *  none. Failures of a sign-in land on `/login?oidc=<code>`.
 *  `wrong-account`: a fresh sign-in used another account than the one
 *  linked to this login. */
export type OidcCallbackResult =
  | 'linked'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'unavailable'
  | 'not-linked'
  | 'not-allowed'
  | 'taken'
  | 'has-other'
  | 'wrong-account';

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
