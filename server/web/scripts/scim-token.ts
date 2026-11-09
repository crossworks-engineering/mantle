/**
 * pnpm -C server/web scim-token: make a SCIM token for this box
 * (docs/scim.md). Writes the token once, to this terminal only, for the
 * operator to paste into the identity provider, and the .env line that
 * holds its sha256. The box keeps only the hash; the token is never logged,
 * stored or sent anywhere by Mantle. Run it again to replace the token (the
 * old one stops working once the new hash is in the .env and docker compose
 * up -d has run: a plain restart does not apply a .env change). SCIM runs
 * on a Control Center only (docs/control-center.md): the output says so.
 */
import { newScimToken } from '../lib/scim/settings';

const { token, hash } = newScimToken();
process.stdout.write(
  [
    'SCIM token (paste it into the identity provider as the secret token, then clear this screen):',
    '',
    `  ${token}`,
    '',
    'Add this line to the box .env and run docker compose up -d:',
    '',
    `  MANTLE_SCIM_TOKEN_HASH=${hash}`,
    '',
    'SCIM runs on a Control Center only (MANTLE_IS_CONTROL_CENTER=on): on any other box this line counts for nothing.',
    '',
  ].join('\n'),
);
