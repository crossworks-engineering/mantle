/**
 * Resolve + persist the Azure AD app registration used for Graph OAuth.
 *
 * Precedence: a UI-set `microsoft_config` row (owner-scoped singleton) wins; if
 * absent, fall back to `MS_*` env so pre-existing env-configured deployments
 * keep working. The client secret is sealed with @mantle/crypto (AAD = owner
 * id), exactly like `tailscale_config` — the UI only ever sees the mask.
 */
import { eq } from 'drizzle-orm';
import { db, microsoftConfig } from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { oauthConfigFromEnv, type MsOAuthConfig } from './config';

function mask(secret: string): string {
  if (secret.length < 8) return '••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** The concrete OAuth config to drive a flow with, or null if this brain has
 *  no Microsoft app configured (neither a UI row nor env). Owner-scoped. */
export async function resolveOAuthConfig(ownerId: string): Promise<MsOAuthConfig | null> {
  const [row] = await db
    .select()
    .from(microsoftConfig)
    .where(eq(microsoftConfig.ownerId, ownerId))
    .limit(1);
  if (row) {
    return {
      clientId: row.clientId,
      clientSecret: open(row.clientSecretEnc, ownerId),
      tenant: row.tenant,
      redirectUri: row.redirectUri,
    };
  }
  return oauthConfigFromEnv();
}

export interface MsConfigStatus {
  configured: boolean;
  /** Where the active config comes from — drives the UI ("set here" vs "from
   *  environment, read-only"). */
  source: 'db' | 'env' | null;
  clientId: string | null;
  tenant: string;
  redirectUri: string | null;
  /** Masked secret for display; never the plaintext. */
  secretMasked: string | null;
}

/** Non-secret view of the current config for the settings form. */
export async function getConfigStatus(ownerId: string): Promise<MsConfigStatus> {
  const [row] = await db
    .select()
    .from(microsoftConfig)
    .where(eq(microsoftConfig.ownerId, ownerId))
    .limit(1);
  if (row) {
    return {
      configured: true,
      source: 'db',
      clientId: row.clientId,
      tenant: row.tenant,
      redirectUri: row.redirectUri,
      secretMasked: row.secretMasked,
    };
  }
  const env = oauthConfigFromEnv();
  if (env) {
    return {
      configured: true,
      source: 'env',
      clientId: env.clientId,
      tenant: env.tenant,
      redirectUri: env.redirectUri,
      secretMasked: mask(env.clientSecret),
    };
  }
  return { configured: false, source: null, clientId: null, tenant: 'common', redirectUri: null, secretMasked: null };
}

/** True if a flow can be started (UI row OR env). Owner-scoped. */
export async function isMicrosoftConfigured(ownerId: string): Promise<boolean> {
  return (await resolveOAuthConfig(ownerId)) !== null;
}

export interface SaveConfigInput {
  clientId: string;
  /** Omit to keep the stored secret on update; required on first save. */
  clientSecret?: string;
  tenant: string;
  redirectUri: string;
}

/** Upsert the owner's UI config. On update with no `clientSecret`, the existing
 *  sealed secret is preserved. Returns false if a first-time save omitted the
 *  secret (the caller should surface "secret is required"). */
export async function saveConfig(ownerId: string, input: SaveConfigInput): Promise<boolean> {
  const [existing] = await db
    .select({ ownerId: microsoftConfig.ownerId })
    .from(microsoftConfig)
    .where(eq(microsoftConfig.ownerId, ownerId))
    .limit(1);

  const base = {
    clientId: input.clientId.trim(),
    tenant: input.tenant.trim() || 'common',
    redirectUri: input.redirectUri.trim(),
    updatedAt: new Date(),
  };

  if (input.clientSecret && input.clientSecret.trim()) {
    const secret = input.clientSecret.trim();
    const { ciphertext, keyVersion } = seal(secret, ownerId);
    const sealed = { clientSecretEnc: ciphertext, keyVersion, secretMasked: mask(secret) };
    if (existing) {
      await db.update(microsoftConfig).set({ ...base, ...sealed }).where(eq(microsoftConfig.ownerId, ownerId));
    } else {
      await db.insert(microsoftConfig).values({ ownerId, ...base, ...sealed });
    }
    return true;
  }

  // No secret provided.
  if (!existing) return false; // first save MUST include the secret
  await db.update(microsoftConfig).set(base).where(eq(microsoftConfig.ownerId, ownerId));
  return true;
}

/** Remove the UI config, reverting to env (if any). Owner-scoped. */
export async function clearConfig(ownerId: string): Promise<boolean> {
  const rows = await db
    .delete(microsoftConfig)
    .where(eq(microsoftConfig.ownerId, ownerId))
    .returning({ ownerId: microsoftConfig.ownerId });
  return rows.length > 0;
}
