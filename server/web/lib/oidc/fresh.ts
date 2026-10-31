/**
 * Fresh sign-in in place of a password (corporate plan section 9.4,
 * docs/oidc-sign-in.md): what key creation and MCP consent ask of a login
 * linked to a company account. Same strength as the password they ask of
 * anyone else: the provider signs the person in again (prompt=login,
 * max_age=0), and the account must be the one linked to this login (flow.ts
 * finishFresh). One code buys one request, for the login and session epoch
 * that asked.
 *
 * Off: every login confirms with its password, with no read.
 */
import type { OidcFreshProof } from '@mantle/client-types';
import { handoffCodeHash, verifierMatches } from './handoff';
import { passwordRule } from './hold';
import { issuerKey, oidcSettings } from './settings';
import { loginLinked, spendHandoffCode } from './store';

/** How a login confirms who it is. */
export type StepUp = Readonly<{ kind: 'password' } | { kind: 'company'; label: string }>;

/** How `loginId` confirms: a linked login with a fresh sign-in. */
export async function stepUpFor(loginId: string): Promise<StepUp> {
  const s = oidcSettings();
  if (s.mode === 'off') return { kind: 'password' };
  return (await loginLinked(loginId, issuerKey(s.issuer)))
    ? { kind: 'company', label: s.label }
    : { kind: 'password' };
}

/** Whether a typed password can confirm this login: not in required mode
 *  when company sign-in is its only way in (hold.ts). In optional mode a
 *  linked login's password still works, for an app from before fresh
 *  sign-in. */
export async function passwordConfirms(loginId: string): Promise<boolean> {
  return (await passwordRule(loginId)) === 'allow';
}

/** Spend a fresh sign-in on this request: a client's code and verifier. */
export async function spendFresh(
  login: { loginId: string; sessionEpoch: number },
  proof: OidcFreshProof,
): Promise<boolean> {
  if (oidcSettings().mode === 'off') return false;
  const spent = await spendHandoffCode(handoffCodeHash(proof.code), ['fresh'], {
    loginId: login.loginId,
    epoch: login.sessionEpoch,
  });
  return !!spent?.challenge && verifierMatches(proof.verifier, spent.challenge);
}

/** Spend the MCP consent page's fresh sign-in: a page of this brain, so no
 *  verifier. The code is good only for the login and epoch that asked, so
 *  it is worth nothing outside that session. */
export async function spendConsentFresh(
  login: { loginId: string; sessionEpoch: number },
  code: string,
): Promise<boolean> {
  if (oidcSettings().mode === 'off' || code.length === 0 || code.length > 128) return false;
  const spent = await spendHandoffCode(handoffCodeHash(code), ['fresh'], {
    loginId: login.loginId,
    epoch: login.sessionEpoch,
  });
  return !!spent && spent.challenge === null;
}
