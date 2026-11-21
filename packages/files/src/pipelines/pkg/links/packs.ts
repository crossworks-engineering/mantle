/**
 * The rule packs of Links (./links.ts), in the order they run. A pack is a
 * file beside this one: data and small functions, switched on by a count of
 * its own patterns (no setting, no model). A new pack is one more line
 * here, and changes no other pack.
 */
import type { LinkPack } from './links';
import { PIPING_SPEC_PACK } from './piping-spec';

export const LINK_PACKS: readonly LinkPack[] = [PIPING_SPEC_PACK];
