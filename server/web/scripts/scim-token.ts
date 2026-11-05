/**
 * pnpm -C server/web scim-token: make a SCIM token for this box
 * (docs/scim.md). Writes the token once, to this terminal only, for the
 * operator to paste into the identity provider, and the .env line that
 * holds its sha256. The box keeps only the hash; the token is never logged,
 * stored or sent anywhere by Mantle. Run it again to replace the token (the
 * old one stops working once the new hash is in the .env and the app is
 * restarted).
 */
import { newScimToken } from '../lib/scim/settings';

const { token, hash } = newScimToken();
process.stdout.write(
  [
    'SCIM token (paste it into the identity provider as the secret token, then clear this screen):',
    '',
    `  ${token}`,
    '',
    'Add this line to the box .env and restart the app:',
    '',
    `  MANTLE_SCIM_TOKEN_HASH=${hash}`,
    '',
  ].join('\n'),
);
