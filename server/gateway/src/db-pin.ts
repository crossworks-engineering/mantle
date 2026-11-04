/**
 * The gateway's database connection, held to the real database. The
 * gateway is the one stack container on mantle_services, so a box service
 * that took the database's name (an alias `postgres`) could
 * answer the gateway's connection and, were the password ever sent, catch
 * it. Two guards, both at every connection:
 *
 *  - the address: the database host is resolved once at start, every answer
 *    must lie in a default subnet and in no services subnet, and every
 *    connection goes to that one checked address (pinned), never to what
 *    the name answers later;
 *  - the sign-in: only SCRAM. A server that asks for the password in clear
 *    or as MD5 (or any method but SASL) is cut before the client answers,
 *    so the password never leaves the gateway; SCRAM sends a proof, not the
 *    password, and postgres.js checks the server's signature, so a server
 *    that does not hold the password's verifier cannot complete it.
 */
import net from 'node:net';
import { inCidr, type Cidr } from './upstream';

/** The sign-in requests a server may make (the `R` message's code): OK, and
 *  the three SASL steps. Anything else (cleartext 3, MD5 5, Kerberos, GSS,
 *  SSPI) is refused. */
const ALLOWED_AUTH = new Set([0, 10, 11, 12]);

/** The database address to connect to, or why there is none. */
export function pinnedDatabase(
  answers: readonly string[],
  defaults: readonly Cidr[],
  services: readonly Cidr[],
): { ok: true; address: string } | { ok: false; error: string } {
  if (answers.length === 0) return { ok: false, error: 'the database host did not resolve' };
  for (const a of answers) {
    if (!net.isIPv4(a)) return { ok: false, error: `the database host answered ${a}, not IPv4` };
    if (services.some((c) => inCidr(a, c))) {
      return {
        ok: false,
        error: `the database host answered ${a}, an address on mantle_services: something there took the database's name`,
      };
    }
    if (!defaults.some((c) => inCidr(a, c))) {
      return { ok: false, error: `the database host answered ${a}, not on the default network` };
    }
  }
  return { ok: true, address: answers[0]! };
}

/**
 * Watch a socket's first messages from the server and cut it when a sign-in
 * request is not SCRAM. The check runs on the `data` event before the
 * client sees the bytes, until the server says AuthenticationOk.
 */
export function guardSignIn(socket: net.Socket): net.Socket {
  const emit = socket.emit.bind(socket) as (ev: string | symbol, ...args: unknown[]) => boolean;
  let pending = Buffer.alloc(0);
  let signedIn = false;
  socket.emit = ((ev: string | symbol, ...args: unknown[]): boolean => {
    if (ev !== 'data' || signedIn) return emit(ev, ...args);
    const chunk = args[0] as Buffer;
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const len = pending.readUInt32BE(1);
      if (pending.length < 1 + len) break;
      if (pending[0] === 0x52 && len >= 8) {
        const code = pending.readUInt32BE(5);
        if (!ALLOWED_AUTH.has(code)) {
          socket.destroy(
            new Error(
              `the database asked for sign-in method ${code}, not SCRAM: refused (the password is never sent)`,
            ),
          );
          return false;
        }
        if (code === 0) {
          signedIn = true;
          pending = Buffer.alloc(0);
          break;
        }
      }
      pending = pending.subarray(1 + len);
    }
    return emit(ev, ...args);
  }) as typeof socket.emit;
  return socket;
}

/** A postgres.js `socket` option: every connection to `address`:`port`,
 *  connected, with its sign-in held to SCRAM. */
export function pinnedSocket(address: string, port: number): () => Promise<net.Socket> {
  return () =>
    new Promise((resolve, reject) => {
      const s = guardSignIn(new net.Socket());
      s.once('error', reject);
      s.connect(port, address, () => {
        s.off('error', reject);
        resolve(s);
      });
    });
}
