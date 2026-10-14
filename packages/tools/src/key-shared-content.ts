/**
 * A key or a linked brain never changes the content of an item others can
 * read (M2 audit N3; access matrix M3): what it embeds would become
 * readable to them with no confirm. The rule the owner MCP surface asked
 * itself (register/context.ts), moved here in A5 step 3a so the gate's
 * pre-run slot runs it for every surface (gate-prerun.ts); the MCP bridge
 * reads the same two functions until it registers through the gate (A5
 * step 4).
 */
import { UUID_RE } from '@mantle/std';
import { othersCanRead } from './shared-item';

/**
 * The item a content tool names (`page_id`, else `id`), trimmed, and the
 * field it came from; `id: null` when the field is there but is not a
 * UUID (the guard refuses that: a padded or odd id must never slip past
 * the check and then be trimmed by the handler, final audit F1). Null when
 * neither field is given (the tool answers its own error).
 */
export function contentToolTarget(
  input: Record<string, unknown>,
): { field: 'page_id' | 'id'; id: string | null } | null {
  const field = input.page_id !== undefined ? 'page_id' : input.id !== undefined ? 'id' : null;
  if (!field) return null;
  const raw = input[field];
  const id = typeof raw === 'string' ? raw.trim() : '';
  return { field, id: UUID_RE.test(id) ? id : null };
}

/** Whose change a refusal names: an API key or a linked brain. */
export type KeyOrPeer = 'key' | 'peer';

/**
 * Why a key's or a peer's call may not change the content `input` names,
 * or null: a field that is not an item id, or an item others can read. A
 * well-formed id is trimmed in place (`input[field]`), so the handler gets
 * the very id that was checked.
 */
export async function keySharedContentRefusal(
  ownerId: string,
  input: Record<string, unknown>,
  who: KeyOrPeer,
): Promise<string | null> {
  const target = contentToolTarget(input);
  if (target?.id) input[target.field] = target.id;
  if (target && !target.id) {
    return `${target.field} must be an item id (a UUID), as page_list or search_nodes give it.`;
  }
  if (target?.id && (await othersCanRead(ownerId, target.id))) {
    return `this item is shared, so ${who === 'key' ? 'an API key' : 'a peer'} cannot change its content (what it embeds would become readable to others). Change it in the app.`;
  }
  return null;
}
