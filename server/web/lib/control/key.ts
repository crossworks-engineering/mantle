/**
 * The control service's key pair (docs/control-center.md, plan section
 * 2.6): made on its first start in the container's own volume, and never
 * read by anything else. A new pair (a suspected leak, a lost CC): stop the
 * service, move the file away, start it, and set the new public key line on
 * every box.
 */
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '@mantle/tracing';
import { privateKeyFromPem, publicKeyLine } from './sign';

const KEY_FILE = 'ed25519.pem';

/** The service's key pair: read from `dir`, or made there on first start
 *  (mode 0600). */
export function loadOrMakeKey(dir: string): { privateKey: KeyObject; line: string } {
  const file = join(dir, KEY_FILE);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
      flag: 'wx',
    });
    log('control').info('made a new control key pair');
  }
  const privateKey = privateKeyFromPem(readFileSync(file, 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${file} is not an Ed25519 key`);
  }
  return { privateKey, line: publicKeyLine(createPublicKey(privateKey)) };
}

