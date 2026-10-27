/**
 * The login's Desk: where each widget and desk icon sits on the client's
 * grid, and the desk's few settings. Kept on the login's own profile row
 * and served by its own route, GET and PUT /api/profile/home-desk. The
 * CLIENT owns the meaning (which ids exist, each widget's bounds); the brain
 * only keeps the shape sound and the size bounded (projectHomeDesk), so a new
 * widget needs no brain release.
 */
export type HomeDeskItem = { id: string; x: number; y: number; w: number; h: number };
export type HomeDesk = {
  v: 1;
  items: HomeDeskItem[];
  /** Items a kind widget lists, by tree kind. */
  counts: Record<string, number>;
  /** Pinned items as desk icons. */
  icons: boolean;
  clock: 'digital' | 'analog';
};

/**
 * GET /api/profile/home-desk, a PUT that landed (200), and a PUT that lost
 * (409, the desk another device saved since): the stored desk and its
 * version. `homeDesk` null and `version` 0 until the login saves one.
 */
export type HomeDeskState = { homeDesk: HomeDesk | null; version: number };

/**
 * PUT /api/profile/home-desk: replace the desk, compare-and-set. `version`
 * is the one this client last read or saved; the save lands (and the
 * version goes up by one) only while the stored version still equals it.
 * `loginId` is the login the desk belongs to (the shell's `loginId`): a save
 * for any login but the session's is a 403 `{ error, code:
 * 'login-mismatch' }`, so a desk is never saved over another login's.
 */
export type HomeDeskPutBody = { homeDesk: HomeDesk; version: number; loginId: string };
