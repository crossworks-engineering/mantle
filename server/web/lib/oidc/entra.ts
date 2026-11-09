/**
 * Entra's company sign-in issuers (docs/oidc-sign-in.md): the tenant an
 * issuer names, and whether a value is a GUID. Company sign-in uses them on
 * every box (the test's scope); SCIM's auto-link on a Control Center too.
 */
import { isUuid } from '@mantle/std';

/** Entra's sign-in hosts: the public cloud, US Government, China. */
const ENTRA_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoftonline.us',
  'login.partner.microsoftonline.cn',
]);

/**
 * The tenant the company sign-in issuer names: the first path part of
 * MANTLE_OIDC_ISSUER that is a GUID (Entra's
 * `https://login.microsoftonline.com/<tenant id>/v2.0`), lower case, or null
 * for an issuer that names none or is not one of Entra's hosts (no
 * auto-link there).
 */
export function issuerTenant(issuer: string): string | null {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  // Entra's own sign-in hosts only: their tokens' tid and oid are Entra's,
  // not claims another provider lets a user or an admin set.
  if (url.protocol !== 'https:' || !ENTRA_HOSTS.has(url.hostname.toLowerCase())) return null;
  const part = url.pathname.split('/').find((p) => isUuid(p));
  return part ? part.toLowerCase() : null;
}

/** Whether `v` is a GUID (an Entra object or tenant id). */
export function isGuid(v: string | null | undefined): v is string {
  return isUuid(v);
}
