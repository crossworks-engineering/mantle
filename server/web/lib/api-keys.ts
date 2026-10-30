/**
 * Thin re-export so existing imports (`@/lib/api-keys`) keep working. The
 * implementation lives in `@mantle/api-keys` so server/api and the MCP server
 * can use the same helpers. Every write a Keys route makes goes through the
 * vault's one write gateway (setVaultKey, deleteVaultKey, testVaultKey,
 * importVaultKeys): its gate and its audit row.
 */
import type { VaultActor, VaultKeySummary } from '@mantle/api-keys';
import type { SessionUser } from '@/lib/auth/session';

export {
  listApiKeys,
  getApiKey,
  setApiKey,
  setVaultKey,
  deleteVaultKey,
  testVaultKey,
  importVaultKeys,
  type ApiKeySummary,
  type VaultKeySummary,
  type VaultSetInput,
} from '@mantle/api-keys';

/** Who a Keys route writes as, for the vault's audit row. */
export function vaultActor(user: SessionUser): VaultActor {
  return { loginId: user.actor.id, email: user.actor.email, via: 'web' };
}

/** A secret as a Keys route answers it: never a value. Dates as the JSON
 *  reply sends them. */
export function vaultKeyReply(key: VaultKeySummary) {
  return {
    id: key.id,
    name: key.name,
    kind: key.kind,
    service: key.service,
    label: key.label,
    target: key.target,
    tags: key.tags,
    needsApproval: key.needsApproval,
    viaTailnet: key.viaTailnet,
    masked: key.masked,
    anthropicWorkspaceId: key.anthropicWorkspaceId,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}
