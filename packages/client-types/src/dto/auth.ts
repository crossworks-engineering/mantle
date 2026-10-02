/**
 * First-run auth on the wire: the public bootstrap state a login screen reads
 * before anyone has signed in, and the first-run signup body.
 */

/** GET /api/auth/bootstrap-state. Public and boolean-only. */
export type BootstrapStateDTO = {
  /** No account exists yet: the login screen shows "create your login". */
  firstRun: boolean;
  /** Signup asks for the installer's setup code (MANTLE_SETUP_CODE). Only
   *  ever true while `firstRun` is. Absent on a brain from before the field. */
  setupCodeRequired?: boolean;
};

/** POST /api/auth/signup. Open only while no account exists. */
export type SignupBody = {
  email: string;
  password: string;
  /** The setup code the installer printed. Required when the bootstrap
   *  state says `setupCodeRequired`; dashes, spaces and case are ignored. */
  setupCode?: string;
};

/** The `reason` of a refused signup: `setup-code` for a wrong or missing
 *  code. (The other 403, "an account already exists", carries no reason.) */
export type SignupRefusedReason = 'setup-code';
