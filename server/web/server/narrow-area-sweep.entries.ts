/**
 * The ONE table of the narrow area-route sweep (narrow-area-sweep.db.test.ts):
 * every writing area row of the route table (buildRoutePolicy over the
 * manifest: an `area`, effect `write`, not gone, not public) has an entry.
 * `{}` drives it with the body the a10 body sweep made from the route's own
 * schema (__snapshots__/a10-body-sweep.bodies.json) at its sample path;
 * `body` or `path` name another; `skip` says why the sweep does not send it.
 * narrow-area-sweep.entries.test.ts fails on a writing area row with no
 * entry and on an entry that names no row, so a new writing area route
 * cannot land without one.
 */
export type NarrowSweepEntry =
  Readonly<{ body?: unknown; path?: string }> | Readonly<{ skip: string }>;

/** The sample id of the paths (a10-body-sweep.samples.ts SAMPLE_ID): the
 *  fixture holds a row of each table at it. */
const S = '11111111-1111-4111-8111-111111111111';
/** The fixture's other rows (narrow-area-sweep.db.test.ts seedFixture). */
export const KEY_OR = '55555555-5555-4555-8555-555555555555';
export const PEER_NODE = '33333333-3333-4333-8333-333333333301';
export const MAIL_NODE = '33333333-3333-4333-8333-333333333302';
export const LANDED_NODE = '33333333-3333-4333-8333-333333333303';
export const WORKER_KINDS = [
  'summarizer',
  'decider',
  'document',
  'image_gen',
  'stt',
  'tts',
  'vision',
];
export const WORKER = (n: number): string => `66666666-6666-4666-8666-6666666666a${n}`;
/** The sandbox daemon the sweep's fetch answers for (its own box service). */
export const SANDBOXD = 'http://sandboxd.sweep';
const workerTest = (kind: string) => ({
  path: `/api/ai-workers/${WORKER(WORKER_KINDS.indexOf(kind) + 1)}/test/${kind === 'image_gen' ? 'image' : kind === 'summarizer' ? 'chat' : kind === 'decider' ? 'decision' : kind}`,
});

export const NARROW_SWEEP_ENTRIES: Readonly<Record<string, NarrowSweepEntry>> = Object.freeze({
  'POST /api/agents': {
    body: {
      slug: 'sweep',
      name: 'sweep',
      role: 'assistant',
      model: 'sweep',
      apiKeyId: KEY_OR,
      systemPrompt: 'sweep',
    },
  },
  // An edit that names a run limit, the description and a turn-on (round 13b
  // items C, D and F: assistant-grant and skill-text).
  'PATCH /api/agents/:id': {
    body: {
      name: 'sweep2',
      description: 'sweep d',
      memoryConfig: { max_iterations: 5 },
      params: { temperature: 0.5 },
      enabled: true,
    },
  },
  'DELETE /api/agents/:id': {},
  'POST /api/agents/:id/persona': {},
  'POST /api/agents/:id/telegram': {},
  'DELETE /api/agents/:id/telegram': {},
  'POST /api/agents/:id/telegram/chats': { body: { chatId: S, status: 'denied' } },
  'POST /api/agents/:id/test/chat': {},
  'POST /api/ai-workers': {},
  'POST /api/ai-workers/models': { body: { apiKeyId: KEY_OR, kind: 'tts', providerId: 'sweep' } },
  'POST /api/ai-workers/reembed': {},
  'POST /api/ai-workers/test-embedding': {},
  'POST /api/ai-workers/voices': {},
  'PATCH /api/ai-workers/:id': {},
  'DELETE /api/ai-workers/:id': {},
  'POST /api/ai-workers/:id/default': {},
  'POST /api/ai-workers/:id/test/chat': workerTest('summarizer'),
  'POST /api/ai-workers/:id/test/decision': workerTest('decider'),
  'POST /api/ai-workers/:id/test/document': workerTest('document'),
  'POST /api/ai-workers/:id/test/image': workerTest('image_gen'),
  'POST /api/ai-workers/:id/test/stt': workerTest('stt'),
  'POST /api/ai-workers/:id/test/tts': workerTest('tts'),
  'POST /api/ai-workers/:id/test/vision': workerTest('vision'),
  'POST /api/backups': {},
  'POST /api/backups/run': {},
  'POST /api/calendar': {
    body: { displayName: 'Sweep cal', url: 'https://example.invalid/c.ics' },
  },
  'PATCH /api/calendar/:id': {},
  'DELETE /api/calendar/:id': {},
  'POST /api/config/adopt': {},
  'POST /api/config/adopt-all': {},
  'POST /api/debug/integrity/landed/delete': { body: { nodeId: LANDED_NODE } },
  'POST /api/debug/maintenance/run': {},
  'POST /api/debug/maintenance/run/cancel': {},
  'POST /api/dev-tools/execute-tool': {
    body: { slug: 'note_create', input: { title: 'Sweep note', content: 'b' } },
  },
  'POST /api/dev-tools/mcp': {},
  'POST /api/dev-tools/proxy': { body: { url: 'https://203.0.113.10/x' } },
  'POST /api/dev-tools/queue-approval': {},
  'POST /api/docs/collections': {},
  'POST /api/docs/collections/all': {},
  'PATCH /api/docs/collections/:id': {},
  'POST /api/email/accounts': {
    body: {
      address: 'sweep@example.invalid',
      host: '127.0.0.1',
      port: 1,
      secure: false,
      password: 'x',
    },
  },
  'PATCH /api/email/accounts/:id': {
    body: { host: '127.0.0.1', port: 1, secure: false, password: 'x' },
  },
  'PUT /api/email/accounts/:id/folders': { body: { folders: ['INBOX'] } },
  'POST /api/email/discover/contacts': {},
  'PATCH /api/email/messages/:id': {},
  'POST /api/embedding': { body: { model: 'embeddinggemma:latest' } },
  'PATCH /api/embedding/extraction': {},
  'POST /api/embedding/rebuild': {},
  'POST /api/embedding/recover': {},
  'POST /api/embedding/test': {
    body: { provider: 'local', model: 'embeddinggemma:latest', baseUrl: null, apiKeyId: null },
  },
  'POST /api/heartbeats': {
    body: {
      slug: 'sweep',
      name: 'sweep',
      agentSlug: 'sweep-agent',
      skillSlug: 'sweep-skill',
      schedule: { kind: 'manual' },
      surface: { kind: 'web' },
    },
  },
  'PATCH /api/heartbeats/:id': { body: { name: 'sweep2' } },
  'DELETE /api/heartbeats/:id': {},
  'POST /api/heartbeats/:id/fire': {},
  'POST /api/keys': {},
  'POST /api/keys/test': { body: { keyId: S, service: 'anthropic' } },
  'PATCH /api/keys/:id': { body: { anthropicWorkspaceId: null } },
  'DELETE /api/keys/:id': {},
  'POST /api/keys/:id/rotate': {},
  'DELETE /api/mcp-clients/:id': {},
  'POST /api/mcp-connectors': { body: { slug: 'sweep', url: 'https://203.0.113.10/mcp' } },
  'GET /api/mcp-connectors/oauth/callback': {
    path: '/api/mcp-connectors/oauth/callback?state=sweep-state&error=access_denied',
  },
  'HEAD /api/mcp-connectors/oauth/callback': {
    skip: "the GET row's handler (Hono answers HEAD with GET's): driven as GET",
  },
  'PATCH /api/mcp-connectors/:slug': {
    path: '/api/mcp-connectors/mcp-sweepfix',
    body: { name: 'Sweep MCP' },
  },
  'DELETE /api/mcp-connectors/:slug': { path: '/api/mcp-connectors/mcp-sweepfix' },
  'POST /api/mcp-connectors/:slug/oauth/start': {
    path: '/api/mcp-connectors/mcp-sweepfix/oauth/start',
  },
  'POST /api/mcp-connectors/:slug/sync': { path: '/api/mcp-connectors/mcp-sweepfix/sync' },
  'PATCH /api/mcp-settings': { body: { enabled: true } },
  'POST /api/mcp-status': {},
  'DELETE /api/microsoft/accounts/:id': {},
  'POST /api/microsoft/accounts/:id/drives': {},
  'PATCH /api/microsoft/accounts/:id/mail': {},
  'PUT /api/microsoft/config': {},
  'DELETE /api/microsoft/config': {},
  'PATCH /api/microsoft/drives/:id': {},
  // One scope, so the scope set's insert is reached (ms_drive_scopes'
  // narrow INSERT: the sweep's per-row record shows the narrow login makes it).
  'PUT /api/microsoft/drives/:id/scopes': {
    body: { scopes: [{ itemId: 'sweep-item', path: '/Sweep', isFolder: true, name: 'Sweep' }] },
  },
  'GET /api/microsoft/oauth/callback': {},
  'HEAD /api/microsoft/oauth/callback': {
    skip: "the GET row's handler (Hono answers HEAD with GET's): driven as GET",
  },
  'POST /api/model-combos/apply': {},
  'POST /api/model-pools': {
    body: { pool: 'agents', name: 'Sweep model', routes: [{ provider: 'sweep', model: 'sweep' }] },
  },
  'PATCH /api/model-pools/:id': { body: { note: 'sweep', rating: 3 } },
  'DELETE /api/model-pools/:id': {},
  'POST /api/network/activate': {},
  'POST /api/network/deactivate': {},
  'POST /api/network/key': { body: { authKey: 'tskey-sweep', hostname: 'sweep' } },
  'DELETE /api/network/key': {},
  'POST /api/onboarding': { body: { action: 'step', step: 'sweep' } },
  'POST /api/openapi-connectors': {
    body: { slug: 'sweep', specUrl: 'https://203.0.113.10/openapi.json' },
  },
  'POST /api/openapi-connectors/preview': {
    body: { specUrl: 'https://203.0.113.10/openapi.json' },
  },
  'PATCH /api/openapi-connectors/:slug': {
    path: '/api/openapi-connectors/openapi-sweepfix',
    body: { name: 'Sweep API' },
  },
  'DELETE /api/openapi-connectors/:slug': { path: '/api/openapi-connectors/openapi-sweepfix' },
  'POST /api/openapi-connectors/:slug/sync': {
    path: '/api/openapi-connectors/openapi-sweepfix/sync',
  },
  'POST /api/pdf-passwords': {},
  'DELETE /api/pdf-passwords/:id': {},
  'POST /api/peers': { body: { displayName: 'sweep', baseUrl: 'https://peer.example.test' } },
  'PATCH /api/peers/:id': { body: { enabled: true } },
  'DELETE /api/peers/:id': {},
  'POST /api/peers/:id/rotate': {},
  'POST /api/peers/:id/shares': { body: { nodeId: PEER_NODE } },
  'DELETE /api/peers/:id/shares': { path: `/api/peers/${S}/shares?nodeId=${PEER_NODE}` },
  'PATCH /api/pending/:id': {},
  'POST /api/runners/:id': {},
  'POST /api/runs/:id': { body: { action: 'cancel' } },
  'DELETE /api/sandboxes/:id': {},
  'POST /api/sandboxes/:id/stop': {},
  'POST /api/secrets': {},
  'PATCH /api/secrets/:id': { body: { title: 'sweep2', note: 'n2' } },
  'DELETE /api/secrets/:id': {},
  'POST /api/secrets/:id/reveal': {},
  'POST /api/services/:name': { path: '/api/services/sandboxes', body: { enable: true } },
  'POST /api/settings/worker-groups': {},
  'PATCH /api/settings/worker-groups/:id': { body: { name: 'sweep2', enabled: true } },
  'DELETE /api/settings/worker-groups/:id': {},
  'POST /api/skills': {},
  'PATCH /api/skills/:id': { body: { description: 'sweep d2', enabled: true } },
  'DELETE /api/skills/:id': {},
  'POST /api/studio/prose': {
    body: { entityType: 'agent', entityId: S, field: 'system_prompt', body: 'sweep prompt' },
  },
  'POST /api/studio/reset': { body: { slug: 'pages' } },
  'POST /api/studio/sandbox': {
    body: { agentId: S, messages: [{ role: 'user', content: 'hi' }] },
  },
  'POST /api/team-admin/invites': { body: { email: 'sweep-invitee@example.test' } },
  'DELETE /api/team-admin/invites/:id': {},
  'PATCH /api/team-admin/settings': { body: { teamPrivateReads: true } },
  'PATCH /api/telegram/chats/:id': { body: { responderAgentId: S } },
  'POST /api/tool-groups': {},
  'PATCH /api/tool-groups/:id': { body: { name: 'sweep2', description: 'sweep d2' } },
  'DELETE /api/tool-groups/:id': {},
  'POST /api/tools': {
    body: {
      slug: 'sweep',
      name: 'sweep',
      description: 'sweep',
      handler: { kind: 'http', url: 'https://203.0.113.10/x', method: 'GET' },
    },
  },
  'PUT /api/tools/settings': {},
  'PATCH /api/tools/:id': { body: { description: 'sweep d2', requiresConfirm: false } },
  'DELETE /api/tools/:id': {},
  'PUT /api/tools/:id/external-access': { body: { allow: true, readOnlyConfirmed: true } },
  'POST /api/updates/check': {},
  'POST /api/updates/request': {},
  'POST /api/users': {},
  'PATCH /api/users/:id': { body: { displayName: 'sweep', role: 'admin', signOut: true } },
  'DELETE /api/users/:id': {},
  'PUT /api/users/:id/agent': { body: { name: 'sweep', sourceAgentId: S } },
  'DELETE /api/users/:id/agent': {},
  'DELETE /api/users/:id/devices/:jti': {},
  'POST /api/users/:id/password': {},
});

/** The push relay the sweep's fetch answers for (/api/push/connect, reset). */
export const RELAY = 'http://relay.sweep';

/**
 * The login-self rows: the writes a
 * login makes to its own profile and push devices, on the login-self exit
 * (not area rows, so not in the route table's area list). Each is sent as
 * the owner (`owner`) or the fixture's member login (`member`), on both
 * passes, in this order (Connect before Reset: the first Connect registers
 * the brain with the relay at push-device). The device enrol rows
 * (POST .../push/subscriptions and their DELETE) take a mobile bearer, not
 * a session: push-device's own cells drive them (device-cap.db.test.ts,
 * narrow-allowlist.db.test.ts); the image uploads (avatar, photo, logo PUT)
 * take a file body: profile-assets cells.
 */
export const LOGIN_SELF_ROWS: readonly {
  readonly key: string;
  readonly as: 'owner' | 'member';
  readonly body: unknown;
}[] = [
  { key: 'PUT /api/profile', as: 'owner', body: { timezone: 'UTC' } },
  { key: 'PUT /api/profile/backgrounds', as: 'owner', body: { backgrounds: 'sweep' } },
  { key: 'PUT /api/profile/color-theme', as: 'owner', body: { colorTheme: 'sweep' } },
  { key: 'PUT /api/profile/default-mode', as: 'owner', body: { defaultMode: 'light' } },
  { key: 'PUT /api/profile/fonts', as: 'owner', body: {} },
  { key: 'PUT /api/profile/nav-favorites', as: 'owner', body: { navFavorites: [] } },
  { key: 'PUT /api/profile/neat-background', as: 'owner', body: { neatBackground: 'sweep' } },
  { key: 'PUT /api/profile/reminder-channel', as: 'owner', body: { reminderChannel: 'telegram' } },
  { key: 'PUT /api/profile/share-neat', as: 'owner', body: { shareNeat: true } },
  { key: 'DELETE /api/profile/logo', as: 'owner', body: null },
  { key: 'DELETE /api/profile/photo', as: 'owner', body: null },
  { key: 'PUT /api/push/preferences', as: 'owner', body: {} },
  {
    key: 'POST /api/push/connect',
    as: 'owner',
    body: { platform: 'ios', osPushToken: 'sweep-os-token' },
  },
  {
    key: 'POST /api/member/push/connect',
    as: 'member',
    body: { platform: 'android', osPushToken: 'sweep-os-token-2' },
  },
  { key: 'PUT /api/member/push/preferences', as: 'member', body: {} },
  { key: 'POST /api/push/reset', as: 'owner', body: null },
];

/** The writing area rows of a route table: an Admin area, effect write,
 *  not a retired route's stub, not public. */
export function writingAreaRows<
  R extends { key: string; area: unknown; effect: string; gone?: boolean; public: boolean },
>(policy: ReadonlyMap<string, R>): R[] {
  return [...policy.values()].filter((r) => r.area && r.effect === 'write' && !r.gone && !r.public);
}
