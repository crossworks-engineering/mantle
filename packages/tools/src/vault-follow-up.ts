/**
 * What follows a write to the vault that changed the secret a name holds,
 * for every client of the vault's write gateway (@mantle/api-keys vault.ts):
 * the Keys routes and the api_key_* tools call it with the gateway's
 * result, so a connector is never left on a mark taken for another key.
 */
import { voidConnectorMarksForKey } from './external-access';
import { closeMcpClient } from './mcp-client';

/**
 * After a vault key changed under the same service and label (a rotate, a
 * save over an existing key, a new key a connector already names): the
 * connectors that sign in with it lose their read-only marks (access matrix
 * T7, the guide's "a new key voids them") and drop their cached connection,
 * which still holds the old key.
 */
export async function afterVaultKeyReplaced(
  ownerId: string,
  service: string,
  label: string,
): Promise<void> {
  const slugs = await voidConnectorMarksForKey(ownerId, service, label);
  await Promise.all(slugs.map((slug) => closeMcpClient(ownerId, slug)));
}
