/**
 * @mantle/content · misc
 *
 * Odds and ends that belong to no larger surface.
 *
 * One of the package index's export lists, split by area so adding one
 * export touches one small file and two sessions adding a DTO do not
 * collide. Curation is deliberate here: the
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
