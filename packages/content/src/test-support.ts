/**
 * The owner functions of a contact's sharing and its shares that skip the
 * Admin check (plan v3.2 S6 c1, audit LOW-6; moved here in S6 c3): each
 * calls the act's SQL body for an owner with no Admin user asked, on the
 * system actor (contact-share-codes.ts, contact-shares.ts). The routes call
 * the definers (admin-acts.ts: adminContactSharing,
 * adminCreateContactShares, adminRevokeAllContactShares), which check the
 * Admin user inside. Only test fixtures call these: this entry is not part
 * of the package's main entry, and eslint.config.mjs refuses a static
 * import of it outside test files.
 */
export {
  enableContactSharing,
  regenerateContactCode,
  disableContactSharing,
} from './contact-share-codes';
export { createContactShares, revokeAllContactShares } from './contact-shares';
