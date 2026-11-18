/**
 * Where a mail server may be (Sync service plan M2). The host a person typed
 * is resolved here and each answer checked before IMAP or SMTP connects: a
 * link-local, cloud metadata, multicast or reserved address is refused. A
 * private address is allowed, as before M4: a company mail server on the LAN
 * is a real case. The connection then goes to the checked address, with the
 * typed name kept for TLS (SNI and the certificate), so a second lookup
 * cannot swap the address.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { envFlag } from '@mantle/config';
import { isBlockedIp } from '@mantle/std/egress';

export class HostRefusedError extends Error {
  constructor(host: string) {
    super(`The server ${host} is not allowed (it resolves to a reserved address).`);
    this.name = 'HostRefusedError';
  }
}

/** The address to connect to for `host`, checked. */
export async function checkedAddress(host: string): Promise<string> {
  const name = host.trim();
  const answers = isIP(name)
    ? [{ address: name, family: isIP(name) }]
    : await lookup(name, { all: true, verbatim: true });
  if (answers.length === 0) throw new HostRefusedError(name);
  for (const a of answers) {
    if (isBlockedIp(a.address, { allowLan: true })) throw new HostRefusedError(name);
  }
  // IPv4 first: a container network often has no IPv6 road out.
  return (answers.find((a) => a.family === 4) ?? answers[0]!).address;
}

/** A test bench's switch (SYNC_PLAINTEXT_MAIL=1): a mailbox may log in with no
 *  TLS. Unset, a mailbox with its TLS box off must upgrade with STARTTLS, so
 *  the app password never crosses in plain text. */
export function plaintextMailAllowed(): boolean {
  return envFlag('SYNC_PLAINTEXT_MAIL');
}
