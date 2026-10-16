/**
 * The item check of a write whose route the gate cannot judge alone (F4 fix
 * round 2): what the write needs depends on its body (an app restore's
 * mode), or the route names no item (an import over an existing app). Asked
 * in the caller's scope, as the gate's itemWriteGate asks it, before
 * anything is written: a refusal is thrown as the database's edit check
 * raises it (editCheckRefusalError), so the one mapper answers it as that
 * refusal: an item the scope does not read the 404, one it reads but may not
 * change the 403 item-workspace. System work is not checked.
 */
import { itemWriteRefusalOf, type ItemNeed } from '@mantle/db';
import { editCheckRefusalError } from '@mantle/std';

/** Throws unless the caller's scope may `need` item `id`. */
export async function assertItemRight(id: string, need: ItemNeed): Promise<void> {
  const refused = await itemWriteRefusalOf([id], need);
  if (refused) throw editCheckRefusalError(refused.detail ?? 'no_read');
}
