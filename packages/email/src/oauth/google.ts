import { google, type Auth } from 'googleapis';
import { eq } from 'drizzle-orm';
import { open, seal } from '@mantle/crypto';
import { db, emailAccounts, type EmailAccount } from '@mantle/db';

/**
 * Google OAuth helpers — used by both the OAuth callback (which exchanges
 * the auth code for tokens) and the Gmail adapter (which uses the stored
 * refresh token to make API calls).
 *
 * Tokens are sealed with @mantle/crypto into `email_accounts.oauth_tokens_enc`.
 * AAD binds the ciphertext to `gmail:{userId}:{address}` so a stolen row
 * can't be decrypted out of context.
 */

/** Alias for google-auth-library's Credentials. The library is loose about
 *  null vs undefined on each field, so we just inherit its shape rather
 *  than maintain a parallel narrower one. */
export type GoogleTokens = Auth.Credentials;

/** Construct a bare OAuth2 client from env. No credentials attached. */
export function googleOAuth2Client(): Auth.OAuth2Client {
  const id = process.env['GOOGLE_CLIENT_ID'];
  const secret = process.env['GOOGLE_CLIENT_SECRET'];
  const redirect = process.env['GOOGLE_REDIRECT_URI'];
  if (!id || !secret || !redirect) {
    throw new Error(
      'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must all be set',
    );
  }
  return new google.auth.OAuth2(id, secret, redirect);
}

/** Tokens sealed for storage. AAD is account-bound. */
export function sealGoogleTokens(
  tokens: GoogleTokens,
  args: { userId: string; address: string },
): Buffer {
  return seal(JSON.stringify(tokens), aad(args)).ciphertext;
}

export function unsealGoogleTokens(
  ciphertext: Buffer,
  args: { userId: string; address: string },
): GoogleTokens {
  return JSON.parse(open(ciphertext, aad(args))) as GoogleTokens;
}

function aad(args: { userId: string; address: string }): string {
  return `gmail:${args.userId}:${args.address}`;
}

/**
 * Exchange an OAuth auth code for tokens and identify which Gmail mailbox
 * granted them. Used by the callback route — keeps the `googleapis`
 * import inside @mantle/email so apps/web doesn't need it as a direct
 * dependency.
 */
export async function exchangeGoogleAuthCode(code: string): Promise<{
  tokens: GoogleTokens;
  address: string;
}> {
  const client = googleOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const address = profile.data.emailAddress?.toLowerCase();
  if (!address) {
    throw new Error('Gmail profile did not include an email address');
  }
  return { tokens, address };
}

/**
 * Build an OAuth2 client pre-loaded with this account's saved credentials.
 * Listens for the `tokens` event — fires when the library auto-refreshes
 * the access token — and persists the merged blob back into the DB. The
 * caller doesn't need to handle refresh; just use the returned client.
 */
export function authClientForAccount(account: EmailAccount): Auth.OAuth2Client {
  if (!account.oauthTokensEnc) {
    throw new Error(`account ${account.address} has no OAuth tokens stored`);
  }
  const current = unsealGoogleTokens(account.oauthTokensEnc, {
    userId: account.userId,
    address: account.address,
  });

  const client = googleOAuth2Client();
  client.setCredentials(current);

  client.on('tokens', (next) => {
    // `next` may carry only `access_token` + `expiry_date` on refresh —
    // merge into the persisted blob so we keep the refresh_token around.
    const merged = { ...current, ...next };
    const ciphertext = sealGoogleTokens(merged, {
      userId: account.userId,
      address: account.address,
    });
    // Fire-and-forget: the in-memory `client` is already updated by the
    // library, so a write failure here only means the next process won't
    // see the new access_token (it'll do its own refresh).
    db.update(emailAccounts)
      .set({ oauthTokensEnc: ciphertext })
      .where(eq(emailAccounts.id, account.id))
      .catch((err) => console.error('[gmail] failed to persist refreshed tokens', err));
  });

  return client;
}
