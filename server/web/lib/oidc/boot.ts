/**
 * The boot step of company sign-in (docs/oidc-sign-in.md). Off: nothing,
 * no read and no write. On: one line, and the mode applied is recorded
 * (oidc_mode_state), so what follows runs only on a real switch.
 *
 * Into required (the last boot with company sign-in on applied optional, or
 * none did): every active login the rule refuses (hold.ts passwordRule: a
 * linked login, or an unlinked one that is not the original account or an
 * honoured outside person) has its sessions ended: its epoch bumped, its
 * device bearers revoked (the push relay told), each audited; its links and
 * keys kept. No password session from before the switch lives on, and
 * going back to optional later revives none. A plain restart in required
 * mode ends nothing (the per-request hold still refuses password sessions).
 * The mode is recorded only once every end succeeded, so a step that failed
 * runs again at the next boot.
 *
 * In required mode, a warning while some active logins are not linked, and
 * one naming how many outside marks keep a password.
 */
import { errorMessage, withRetry } from '@mantle/std';
import { log } from '@mantle/tracing';
import { endLoginSessions } from '@/lib/auth';
import { forgetRelayDevices } from '@/lib/push/store';
import { outsideHonoured, ruleOf } from './hold';
import { issuerKey, oidcSettings } from './settings';
import { auditFireAndForget } from '@/lib/audit';
import { activeLoginsWithLinks, appliedMode, recordAppliedMode } from './store';

const BOOT_ATTEMPTS = 6;
const BOOT_RETRY_MS = 10_000;

export async function oidcBootCheck(): Promise<void> {
  const s = oidcSettings();
  if (s.mode === 'off') return;
  log('auth').info(`company sign-in is ${s.mode} ("${s.label}")`);
  if (s.mode !== 'required') {
    if ((await appliedMode()) !== 'optional') await recordAppliedMode('optional');
    return;
  }
  // The database may not answer yet at container start: try again a few
  // times, so a switch to required does end the old sessions (the
  // per-request hold refuses them meanwhile).
  const logins = await withRetry(() => activeLoginsWithLinks(issuerKey(s.issuer)), {
    retries: BOOT_ATTEMPTS - 1,
    retryOn: () => true,
    delayMs: () => BOOT_RETRY_MS,
    onRetry: ({ retry, failure }) =>
      log('auth').warn(
        `company sign-in: the boot step could not read the logins (retry ${retry}): ${errorMessage(failure.error)}`,
      ),
  });
  // The gate's own rule (hold.ts ruleOf): a login whose password sessions
  // the gate lets act keeps them.
  const keeps = (l: (typeof logins)[number]) => ruleOf(s, l) === 'allow';
  const before = await appliedMode();
  if (before !== 'required') {
    let ended = 0;
    let failed = 0;
    for (const l of logins) {
      if (keeps(l)) continue;
      try {
        const routing: string[] = [];
        await endLoginSessions(l.loginId, { removedRoutingTokens: routing });
        // The push relay forgets the devices that went with the sessions.
        if (routing.length > 0) await forgetRelayDevices(routing);
        auditFireAndForget({
          actorId: l.loginId,
          actorEmail: l.email,
          action: 'auth.oidc_sessions_ended',
          detail: { reason: 'switch-to-required', from: before },
        });
        ended += 1;
      } catch (err) {
        failed += 1;
        // The per-request hold still refuses its password sessions; the
        // step runs again at the next boot (the mode is not recorded).
        log('auth').warn(
          `company sign-in: the sessions of login ${l.loginId} could not be ended at boot: ${errorMessage(err)}`,
        );
      }
    }
    if (ended > 0) {
      log('auth').info(
        `MANTLE_OIDC_MODE=required (was ${before ?? 'never on'}): ended the sessions of ${ended} logins that sign in with the company account or link first`,
      );
    }
    if (failed === 0) await recordAppliedMode('required');
  }
  const unlinked = logins.filter((l) => !l.linked && !keeps(l)).length;
  if (unlinked > 0) {
    log('auth').warn(
      `MANTLE_OIDC_MODE=required: ${unlinked} of ${logins.length} active logins are not linked yet; each signs in with its password once and is asked to link (Settings > Users shows who)${s.outsideAllowed ? '' : '. Outside people cannot link: they are held until MANTLE_OIDC_OUTSIDE is on and an admin marks them'}`,
    );
  }
  // The outside marks the operator allows keep a password: said at every
  // boot, so the operator sees how far the policy reaches.
  const outside = logins.filter((l) => !l.owner && !l.linked && outsideHonoured(s, l)).length;
  if (outside > 0) {
    log('auth').warn(
      `MANTLE_OIDC_MODE=required: ${outside} active logins are marked outside people and keep their passwords (Settings > Users; MANTLE_OIDC_OUTSIDE=off refuses marks)`,
    );
  }
}
