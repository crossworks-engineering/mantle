/**
 * The tags of the shipped migrations (meta/_journal.json). The named heads
 * bypass is for migrations only, and each names itself by its tag; a logged
 * bypass whose name is not one of these did not come from a migration
 * (/debug/integrity flags it, W1 audit LOW 5). Pure data.
 */
import journal from '../migrations/meta/_journal.json';

export const MIGRATION_TAGS: ReadonlySet<string> = new Set(
  (journal as { entries: { tag: string }[] }).entries.map((e) => e.tag),
);
