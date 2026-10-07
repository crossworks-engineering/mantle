/**
 * Tell a login that a key was made on it (Jason, 2026-10-07): a stolen
 * session that makes a key must not go unseen. Never the secret, never the
 * prefix: only the key's name, its access and its expiry.
 *
 *  - A member or a client: one message in their own chat thread (their
 *    in-app notices), which the push worker also sends to their phone as a
 *    chat push (the login_notice trigger, migration 0213), sealed to each
 *    device.
 *  - An admin has no thread of their own (the assistant thread is shared and
 *    model-facing), so an admin gets a push sealed to their own devices, and
 *    the key's row in Settings > API access.
 *
 * Every push is sealed end to end (lib/push/seal.ts): the relay and the
 * phone vendors see ciphertext only. Best effort: a failure is logged and
 * the key stays made; the key.created audit row is written either way.
 */
import { appendTeamMessage } from '@mantle/content';
import type { AccessKeyAccess, AccessKeyRole } from './access-keys';

export type KeyMadeNotice = {
  /** The brain (anchor) id. */
  ownerId: string;
  loginId: string;
  role: AccessKeyRole;
  name: string;
  access: AccessKeyAccess;
  expiresAt: Date | null;
};

/**
 * The notice text: plain, short, and never the secret or its prefix.
 * `withName`: the key's name is the caller's own text, so it is left out of
 * a message that lands in a thread the login's assistant reads (final audit
 * F5: no caller-chosen text in a model-facing context). An admin's push
 * never reaches a model and keeps it.
 */
export function keyMadeText(
  n: Pick<KeyMadeNotice, 'role' | 'name' | 'access' | 'expiresAt'>,
  opts: { withName: boolean } = { withName: true },
): string {
  const access = n.access === 'read_write' ? 'read and write' : 'read only';
  const expires = n.expiresAt ? n.expiresAt.toISOString().slice(0, 10) : 'never';
  const fix =
    n.role === 'client'
      ? 'revoke it in API keys and sign out'
      : 'revoke it in API access and change your password';
  const what = opts.withName ? `${n.name.slice(0, 100)}, ${access}` : access;
  return `A new API key was made on your login: ${what}, expires ${expires}. If this was not you, ${fix}.`;
}

/** Send the notice. Never throws. */
export async function notifyKeyMade(n: KeyMadeNotice): Promise<void> {
  try {
    if (n.role === 'admin') {
      await pushToAdmin(n.ownerId, n.loginId, keyMadeText(n, { withName: true }));
      return;
    }
    const text = keyMadeText(n, { withName: false });
    await appendTeamMessage({
      ownerId: n.ownerId,
      loginId: n.loginId,
      contactId: null,
      direction: 'outbound',
      text,
      channel: 'web',
    });
  } catch (err) {
    console.error('[access-keys] key-made notice failed:', err);
  }
}

/** A push sealed to ONE admin's own devices (never another admin's). */
async function pushToAdmin(ownerId: string, loginId: string, text: string): Promise<void> {
  // Loaded here: the route must not load the push store on every import.
  const { getPushInstance, listAdminSubscriptions } = await import('./push/store');
  const { sendToDevices } = await import('./push/notify');
  const instance = await getPushInstance();
  if (!instance) return;
  const devices = await listAdminSubscriptions(ownerId, { loginId });
  if (devices.length === 0) return;
  await sendToDevices(
    instance,
    devices,
    { v: 1, t: 'Mantle', b: text, deepLink: '/settings/api-access', ts: Date.now() },
    'api-key-made',
    { opaqueFor: loginId },
  );
}
