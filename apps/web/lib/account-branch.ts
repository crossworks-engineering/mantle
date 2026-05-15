import { createHash } from 'node:crypto';

/**
 * Build a stable ltree segment for an email account's branch path.
 *
 *   jason@schoeman.me  → inbox.jason_3a1f
 *   jason@gmail.com    → inbox.jason_8b2c
 *
 * The 4-char hex suffix is a sha256 of the domain truncated; it keeps
 * two `jason@…` accounts on different providers from colliding under
 * the same `inbox.jason` path. ltree labels are restricted to
 * [A-Za-z0-9_], hence the explicit sanitisation of the local-part.
 */
export function accountBranchPath(address: string): string {
  const [local, domain] = address.toLowerCase().split('@');
  const cleanLocal =
    (local ?? '').replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'account';
  const hash = createHash('sha256').update(domain ?? '').digest('hex').slice(0, 4);
  return `inbox.${cleanLocal}_${hash}`;
}
