/** Re-export from the shared workspace package. See @mantle/content/contacts. */
export {
  CONTACTS_ROOT_LABEL,
  listContacts,
  countContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  digitsOnly,
  formatCell,
  hasIdentity,
  normalizeCountryCode,
  normalizeEmail,
  isPlausibleEmail,
  type ContactRow,
  type CreateContactInput,
  type UpdateContactInput,
} from '@mantle/content';
