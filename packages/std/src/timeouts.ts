/**
 * THE timeout table (A10 #10, docs/provider-http.md): every network deadline
 * by name, at the value its call site had before the fold. A call site names
 * an entry (`PROVIDER_TIMEOUTS.discover`) instead of writing a number, so a
 * deadline is changed here, once, and the table shows them side by side.
 *
 * Two kinds of entry are new, each a named behaviour change: the provider
 * pool's own default (`default`), and the deadlines of calls that had none
 * (`embed`, `transcribe`, and `speech` on the two speech adapters that had
 * none).
 */

/** Model-provider calls (`@mantle/voice` adapters, through providerFetch). */
export const PROVIDER_TIMEOUTS = {
  /** A model, voice or catalogue list (GET .../models): the settings form's
   *  live discovery. */
  discover: 15_000,
  /** The lighter catalogue lists: embedding model lists, a local server's
   *  model list, OpenRouter's speech models. */
  catalog: 8_000,
  /** OpenRouter's key info (GET /key) before a discovery. */
  keyInfo: 10_000,
  /** The Copilot OAuth to session-token exchange. */
  tokenExchange: 15_000,
  /** A one-shot hosted chat call (headers and body). */
  chat: 60_000,
  /** A one-shot chat call to an OpenAI-compatible relay (Copilot, Mammouth,
   *  a custom endpoint), whose first byte can come later. */
  chatRelay: 120_000,
  /** A one-shot chat call to a self-hosted model (CPU inference). */
  chatLocal: 300_000,
  /** A stream's headers must arrive within this long. */
  streamConnect: 60_000,
  /** The longest silence between two chunks of an open stream. */
  streamIdle: 120_000,
  /** The decisions judge: it sits in front of a call that runs anyway. */
  decision: 1_500,
  /** One image to text. */
  vision: 60_000,
  /** A whole PDF to text (Anthropic document input). */
  visionDocument: 120_000,
  /** Several images in one request (the drawing check: up to 16 crops of
   *  up to 2000 px, answered by a reasoning model such as Gemini Pro, which
   *  thinks before it answers): one image's minute is far too short. */
  visionImages: 240_000,
  /** Text to speech. */
  speech: 60_000,
  /** Image generation. */
  image: 120_000,
  /** Image generation on Hugging Face (a cold model loads first). */
  imageCold: 180_000,
  /** A local embedding sub-batch (MANTLE_LOCAL_EMBED_TIMEOUT_MS overrides). */
  localEmbed: 120_000,
  /** NEW: a hosted embedding call. Before, none (undici's 300 s header and
   *  300 s body-idle defaults only), so a hung call stalled a worker. The
   *  longest embedding deadline we already had (localEmbed). */
  embed: 120_000,
  /** NEW: a speech-to-text call (the audio upload and the transcript). Before,
   *  none. Generous: an hour of audio is a large upload. */
  transcribe: 600_000,
  /**
   * NEW: providerFetch's own default for a call that names none. Applied to
   * the whole exchange of an ordinary response and to the headers only of an
   * event stream, so a long healthy stream is never cut. The longest provider
   * deadline we already had (imageCold).
   */
  default: 180_000,
} as const;

/** Everything else that waits on the network or on a slow promise. */
export const NET_TIMEOUTS = {
  /** The dashboard pill's local embedder probe. */
  healthPill: 1_200,
  /** One dashboard vital (CPU, Postgres, the object store, ...). */
  healthVital: 1_800,
  /** A local service probe: the embedder, the browser service. */
  localProbe: 1_500,
  /** One sanity check on /debug/sanity. */
  sanityCheck: 3_000,
  /** The remote MCP endpoint's own initialize, from the status route. */
  mcpStatus: 5_000,
  /** One image fetch while a drawing renders. */
  drawFile: 5_000,
  /** The onboarding wizard's reachability probe. */
  onboardingProbe: 6_000,
  /** The onboarding wizard's test call. */
  onboardingTest: 10_000,
  /** The push relay. */
  pushRelay: 10_000,
  /** The OpenRouter model catalogue for context windows (tracing). */
  modelCatalog: 8_000,
  /** The provider model catalogues of the model explorer. */
  modelExplorer: 12_000,
  /** An HTTP tool call (the API tool's default; a tool may set its own). */
  httpTool: 15_000,
  /** An OAuth2 client-credentials token request. */
  oauthToken: 15_000,
  /** The OpenRouter Data API (curation tools, the pool curator). */
  openRouterData: 25_000,
  /** The toolsmith's web fetch. */
  webFetch: 25_000,
  /** One job of the documents engine (Gotenberg): its own API_TIMEOUT is
   *  60 s, plus the upload and the answer. */
  documentsJob: 90_000,
  /** A simulated turn (Agent Studio sandbox, eval runs). */
  simTurn: 300_000,
  /** One nightly maintenance sweep. */
  sweep: 30 * 60_000,
} as const;
