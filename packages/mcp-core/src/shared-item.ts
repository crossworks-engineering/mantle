/**
 * Whether anyone but an admin can read an item now (workspaces W5b2). The
 * one copy is @mantle/tools shared-item.ts since A5 step 3a (the gate's
 * pre-run check reads it in every process); this path stays for its
 * importers (the v1 page route).
 */
export { othersCanRead } from '@mantle/tools';
