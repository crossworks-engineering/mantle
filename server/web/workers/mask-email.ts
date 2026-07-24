/**
 * Mask the local-part of an email address before logging.
 *
 * Operators see enough to match the row in the DB ("j****n@gmail.com")
 * without the full PII landing in journalctl / centralised log
 * shipping. The first + last char of the local-part survive so a human
 * scanning logs can still recognise their own address; everyone else's
 * is a meaningless blur of asterisks.
 *
 * Edge cases handled (see mask-email.test.ts):
 *   - undefined / null / empty → '(none)'
 *   - no '@' at all            → '***'  (don't leak the bare string)
 *   - '@example.com' (no local)→ '***'
 *   - one- or two-char local   → '*' (don't expose the entire local)
 *   - long local-part          → capped at 6 stars so logs stay scannable
 */
export function maskEmail(addr: string | null | undefined): string {
  if (!addr) return '(none)';
  const at = addr.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = addr.slice(0, at);
  const domain = addr.slice(at);
  const hint =
    local.length <= 2
      ? '*'
      : `${local[0]}${'*'.repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}`;
  return `${hint}${domain}`;
}
