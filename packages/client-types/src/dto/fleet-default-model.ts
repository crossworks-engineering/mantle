/**
 * The Control Center's Default Model (docs/control-center.md, "Default
 * Model"): one model provider and one of this brain's keys for it. The CC
 * lists that provider's models with that key, and every place on the Fleet
 * screen that picks a model picks from that list. A BRAIN preference
 * (`fleetDefaultModel`): one choice for every admin and browser.
 *
 * Nothing here is a secret: a key is named by its id, its name and the
 * masked hint the keys screen shows (first 4 and last 4 of a long token).
 */

/** What is stored: the provider id and the key id. `null` clears it. */
export type StoredFleetDefaultModel = {
  provider: string;
  keyId: string;
};

/** One of this brain's keys, as the Default Model card names it. */
export type FleetDefaultModelKey = {
  id: string;
  name: string;
  label: string;
  /** The keys screen's hint, never the key. */
  masked: string;
};

/** A chat provider this brain holds at least one key for. */
export type FleetDefaultModelChoice = {
  provider: string;
  providerName: string;
  keys: FleetDefaultModelKey[];
};

/** GET /api/fleet/default-model and control_default_model_get. */
export type FleetDefaultModelView = {
  /** The stored provider, or null when none is set. */
  provider: string | null;
  providerName: string | null;
  /** The stored key while it is still this brain's key for the provider. */
  key: FleetDefaultModelKey | null;
  /** Set, but the key was deleted or is no longer the provider's: the
   *  pickers say so and point to the card. */
  problem: 'key-missing' | null;
  /** What the card can pick from. */
  choices: FleetDefaultModelChoice[];
};
