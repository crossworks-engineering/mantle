/**
 * The one gate of company sign-in (corporate plan sections 9.2, 10.2 and
 * 17, docs/oidc-sign-in.md): whether a session may act now. Every path that
 * honours a session asks `sessionHeld` (lib/auth/session.ts findLogin for a
 * cookie and a device bearer, the bearer to cookie upgrade, the token
 * refresh), and the boot step and the sign-in routes read the same rule
 * (`ruleOf`), so the answer is decided here and only here, from four
 * things: the mode, the login's facts (linked, original account, outside
 * mark), the session's kind and its life left.
 *
 * Two kinds of session:
 *  - 'password': a cookie a password sign-in made (no company sign-in
 *    mark), or a device bearer from one;
 *  - 'sso': a cookie or a device bearer company sign-in made (`so` claim,
 *    tokens.ts).
 *
 * The table (`sessionMayAct`, pinned row by row in oidc-unit.test.ts):
 *  - off: a password session acts, with no read; an SSO session does not
 *    (off is no company sign-in at all, section 9.2);
 *  - optional: a password session acts, with no read; an SSO session acts
 *    while its login is linked to the issuer now and its life left is not
 *    above MANTLE_OIDC_SESSION_HOURS (section 10.2);
 *  - required: a password session acts only where the rule allows a
 *    password (the original account, an honoured outside person); an SSO
 *    session as in optional. Every other password session is no session:
 *    the person signs in again, a linked login with the company account, an
 *    unlinked one with its password, which holds it to the one link step.
 *    Nobody is stranded (section 17.1 rule 4).
 */
import {
  passwordHoldFor,
  passwordIsWayIn,
  type CredentialKind,
  type PasswordHold,
} from '@mantle/config';
import { TtlCache, errorMessage } from '@mantle/std';
import { issuerKey, oidcSettings, type OidcOn, type OidcSettings } from './settings';
import { oidcRuleFacts } from './store';

export type PasswordRule = 'allow' | 'sso-required' | 'link-required';

/** What the rule reads of a login. */
export type RuleFacts = Readonly<{
  owner: boolean;
  linked: boolean;
  outside: boolean;
  admin: boolean;
}>;

/** A session the gate judges. `secondsLeft`: an SSO session's life left. */
export type SessionKind = { kind: 'password' } | { kind: 'sso'; secondsLeft: number };

/** Whether a login's outside mark keeps its password now: the operator
 *  allows outside logins (MANTLE_OIDC_OUTSIDE, on by default: plan
 *  decision D3), and it is no Admin user. The one predicate the
 *  rule, the counts and the status read share. */
export function outsideHonoured(s: OidcSettings, f: { outside: boolean; admin: boolean }): boolean {
  return s.mode !== 'off' && s.outsideAllowed && f.outside && !f.admin;
}

/** The rule of a password sign-in, or a password session, of a login with
 *  facts `f` (null: the row is gone). Pure. */
export function ruleOf(s: OidcSettings, f: RuleFacts | null): PasswordRule {
  if (s.mode !== 'required') return 'allow';
  // A row that is gone is refused by the caller's own next step; never let
  // in here.
  if (!f) return 'link-required';
  if (f.owner) return 'allow';
  if (!passwordIsWayIn(s.mode, f)) return 'sso-required';
  if (outsideHonoured(s, f)) return 'allow';
  return 'link-required';
}

/** Whether a session of `kind` may act for a login with facts `f`. Pure:
 *  the whole table. */
export function sessionMayAct(s: OidcSettings, kind: SessionKind, f: RuleFacts | null): boolean {
  if (kind.kind === 'password') return ruleOf(s, f) === 'allow';
  if (s.mode === 'off') return false;
  return !!f && f.linked && kind.secondsLeft > 0 && kind.secondsLeft <= s.sessionSeconds;
}

/** Whether the gate needs the login's facts for this session: never for a
 *  password session outside required mode, nor for anything while off. */
function needsFacts(s: OidcSettings, kind: SessionKind): s is OidcOn {
  if (s.mode === 'off') return false;
  return kind.kind === 'sso' || s.mode === 'required';
}

/** What the rule says of a password sign-in, or a password session, of
 *  `loginId`. */
export async function passwordRule(
  loginId: string,
  s: OidcSettings = oidcSettings(),
): Promise<PasswordRule> {
  if (s.mode !== 'required') return 'allow';
  return ruleOf(s, await oidcRuleFacts(loginId, issuerKey(s.issuer)));
}

/** The facts the gate read, a few seconds per login and issuer: one read
 *  per login, not per request. */
const facts = new TtlCache<string, Promise<RuleFacts | null>>({
  ttlMs: 10_000,
  maxEntries: 10_000,
});

function factsOf(loginId: string, s: OidcOn): Promise<RuleFacts | null> {
  const key = `${s.issuer}\n${loginId}`;
  const hit = facts.get(key);
  if (hit) return hit;
  const p = oidcRuleFacts(loginId, issuerKey(s.issuer));
  // A read that failed is not kept.
  p.catch(() => facts.delete(key));
  facts.set(key, p);
  return p;
}

/**
 * The gate: whether a session of `kind` for `loginId` is held (no session)
 * now. False at once, with no read, for a password session outside required
 * mode; true at once for an SSO session while off. A read that fails holds
 * it (fail closed: the person signs in again).
 */
export function sessionHeld(loginId: string, kind: SessionKind): boolean | Promise<boolean> {
  const s = oidcSettings();
  if (!needsFacts(s, kind)) return !sessionMayAct(s, kind, null);
  return factsOf(loginId, s).then(
    (f) => !sessionMayAct(s, kind, f),
    (err: unknown) => {
      const text = `company sign-in: the facts of login ${loginId} could not be read, its session is held: ${errorMessage(err)}`;
      // Loaded here, as settings.ts does: the session imports this module.
      void import('@mantle/tracing').then(({ log }) => log('auth').warn(text));
      return true;
    },
  );
}

/**
 * The password hold (lib/auth/password-hold.ts) that applies to a
 * credential of `kind` for `loginId`, whose hold by the password rule alone
 * is `hold`: the same facts and rule this gate reads (@mantle/config
 * passwordHoldFor holds the table). No read while off, nor in optional mode
 * but for a grant's recheck (whether the login is linked). A read that
 * fails keeps the hold (fail closed).
 */
export function credentialPasswordHold(
  loginId: string,
  hold: PasswordHold,
  kind: CredentialKind,
): PasswordHold | Promise<PasswordHold> {
  if (hold === null) return null;
  const s = oidcSettings();
  const decide = (f: RuleFacts | null): PasswordHold =>
    passwordHoldFor(hold, kind, {
      passwordWayIn: ruleOf(s, f) !== 'sso-required',
      companyWayIn: s.mode !== 'off' && !!f?.linked,
    });
  if (s.mode === 'off') return decide(null);
  if (s.mode === 'optional' && !(kind === 'grant' && hold === 'recheck')) return decide(null);
  return factsOf(loginId, s).then(decide, () => hold);
}

/** The kind of a session cookie the session verified (tokens.ts
 *  verifySessionCookie). */
export function cookieSessionKind(c: { oidc?: true; exp: number }): SessionKind {
  return c.oidc
    ? { kind: 'sso', secondsLeft: c.exp - Math.floor(Date.now() / 1000) }
    : { kind: 'password' };
}

/** A device bearer of a password sign-in, or a pairing from one. */
export const DEVICE_BEARER: SessionKind = Object.freeze({ kind: 'password' });

/** The kind of a device bearer the session verified (tokens.ts
 *  verifyMobileToken): company sign-in's own (`so` claim), judged as its
 *  cookie is, or a password sign-in's. */
export function bearerSessionKind(c: { oidc?: true; exp: number }): SessionKind {
  return c.oidc ? cookieSessionKind(c) : DEVICE_BEARER;
}

/** Forget the kept facts: all (tests), or one login's (a link, an unlink
 *  or an outside mark changed it, so the gate reads the new state at once:
 *  the SSO cookie a link mints must not meet a cached "unlinked"). */
export function forgetHolds(loginId?: string): void {
  if (loginId === undefined) {
    facts.clear();
    return;
  }
  const s = oidcSettings();
  if (s.mode !== 'off') facts.delete(`${s.issuer}\n${loginId}`);
}
