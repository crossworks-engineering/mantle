/**
 * @mantle/content · misc
 *
 * Odds and ends that belong to no larger surface.
 *
 * Split out of the 962-line index.ts on 2026-09-02 (audit, tier 3). The
 * export lists are UNCHANGED — this package's public surface is exactly what
 * it was. What changed is that adding one export now touches one small file
 * instead of the single barrel that saw 102 commits in 90 days, so two
 * sessions adding a DTO no longer collide. Curation is deliberate here: the
 * alternative, `export *`, would publish every module's internals (tuning
 * constants like EMBED_TEXT_PER_FILE, helpers like renderIdentityBlock) as
 * API nobody chose to promise.
 */

export {
  listPdfPasswords,
  createPdfPassword,
  deletePdfPassword,
  getPdfPasswordCandidates,
  markPdfPasswordUsed,
  type PdfPasswordRow,
} from './pdf-passwords';

export {
  HEARTBEAT_INTERVAL_MS,
  heartbeatFilePath,
  startProcessHeartbeat,
} from './process-heartbeat';

export {
  LOCATIONS_ROOT_LABEL,
  listLocations,
  countLocations,
  listLocationTags,
  getLocation,
  createLocation,
  updateLocation,
  deleteLocation,
  findNearbyLocations,
  haversineMeters,
  type LocationRow,
  type NearbyLocation,
  type CreateLocationInput,
  type UpdateLocationInput,
} from './locations';

export {
  sanitizeLocationPing,
  buildLocationContextLine,
  type LocationPing,
  type LocationSource,
} from './location-ping';
