/**
 * Boot hook: close the embed gaps once (embedding means sharing, audit F19
 * follow-up). Lowering an item is an admin's decision for the item AND what
 * it embeds; this applies that same decision to the pages, drawings and
 * notes lowered before the release that made it automatic: each one's
 * embeds go down to its level. Logged item by item.
 *
 * Once per brain (a marker in the owner's preferences, reconcileEmbedClosuresOnce):
 * after it, an admin may raise one embed on purpose and a later boot must not
 * lower it again. Fire-and-forget from server/main.ts; never delays or blocks
 * request serving. The same guards as the manifest reconcile: production only
 * (a `pnpm dev` may point at another box's database) and
 * MANTLE_DISABLE_BOOT_RECONCILE. No LLM work: a level change notifies nothing.
 */
import { env } from '@mantle/config';
import { resolveSingleOwnerId } from '@mantle/db';
import { reconcileEmbedClosuresOnce } from '@mantle/content';

export async function reconcileEmbedClosuresOnBoot(): Promise<void> {
  if (env('NODE_ENV') !== 'production') return;
  if (env('MANTLE_DISABLE_BOOT_RECONCILE') === '1') return;
  try {
    const ownerId = await resolveSingleOwnerId();
    if (!ownerId) return;
    const lowered = await reconcileEmbedClosuresOnce(ownerId, (line) => console.log(line));
    if (lowered === null) return; // already ran on this brain
    console.log(
      lowered.length > 0
        ? `[embeds] boot reconcile lowered ${lowered.length} embedded item(s) to the level of what embeds them`
        : '[embeds] boot reconcile: no embed above the item that embeds it',
    );
  } catch (err) {
    // Best-effort: a reconcile failure must never take the server down, and
    // with no marker written it runs again on the next boot.
    console.error('[embeds] boot reconcile skipped (non-fatal):', err instanceof Error ? err.message : err);
  }
}
