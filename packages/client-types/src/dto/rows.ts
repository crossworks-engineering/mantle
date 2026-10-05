/**
 * @mantle/client-types · rows
 *
 * Row/DTO shapes lifted out of the server packages at the jackdaw split,
 * the hand-written mirrors of @mantle/db jsonb/enum shapes, and the redacted
 * account DTOs.
 *
 * Split out of the 2548-line index.ts on 2026-09-02 (audit, tier 3) with the
 * contents unchanged. index.ts re-exports every one of these, so the package's
 * public surface is byte-identical — only the file a symbol lives in moved.
 */

import type { AppNav, AppOpenStat, AppTint } from '../app-nav';
import type { AccessLevel } from './access';

// ── Row/DTO shapes moved from the server packages (jackdaw split P0) ─────────
// Sources: @mantle/content, @mantle/email, @mantle/microsoft, @mantle/runtime/agent
// re-export these names, so server code keeps its original import paths.

export type TaskRow = {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  tags: string[];
  /** Checklist inside the task ("task breakup"). Stored in `data.todos`. */
  todos: TaskTodo[];
  /** Fractional ordering key for the board (within-column order). Stored in
   *  `data.rank`; null on tasks never dragged — they sort after ranked ones. */
  rank: string | null;
  /** Comments on this task (node_comments rows). List/detail badge material. */
  commentCount: number;
  summary: string | null;
  /** When the task was filed away, or null while it is live. Archived tasks are
   *  excluded from every list, count and board unless explicitly requested —
   *  it is what keeps a Done column from growing without bound. Orthogonal to
   *  `status`: an archived task keeps the status it had. */
  archivedAt: string | null;
  /** On a done task: the status it had before it was marked done, which a
   *  reopen (`PATCH {reopen: true}`) restores. Null when the brain does not
   *  know it (the reopen then lands on 'open') and on every task that is not
   *  done. Optional: brains before this field do not send it. */
  statusBeforeDone?: TaskStatus | null;
  createdAt: string;
  updatedAt: string;
};

/** One checklist item inside a task. Server assigns `id` on write. */
export type TaskTodo = {
  id: string;
  text: string;
  done: boolean;
};

/** Mirrors @mantle/db `NodeCommentAuthorKind`. */
export type NodeCommentAuthorKind = 'owner' | 'member' | 'agent' | 'client';

/**
 * A comment on a node (tasks first; the table is node-generic). `authorName`
 * is a display snapshot at post time; `mine` is computed server-side per
 * viewer (an owner login sees its own comments as mine, a team member sees
 * theirs), so clients never reconcile the two auth worlds themselves.
 */
export type NodeComment = {
  id: string;
  nodeId: string;
  authorKind: NodeCommentAuthorKind;
  authorName: string;
  mine: boolean;
  body: string;
  createdAt: string;
  editedAt: string | null;
};

export type JournalRow = {
  id: string;
  title: string;
  body: string;
  /** Who wrote the entry. Stamped server-side; agent tool calls can't spoof it. */
  author: 'user' | 'agent';
  /** Authoring agent's slug when author='agent'; null for user-authored rows. */
  agentSlug: string | null;
  /** Kind key (see KINDS in journal-options). Legacy pre-v2 rows map their old
   *  `category` to a kind at read time; free text is tolerated. */
  kind: string | null;
  /** Gap lifecycle — only entries with kind='gap' carry one ('open'|'resolved'). */
  status: string | null;
  entryDate: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EventRow = {
  id: string;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  remindMinutesBefore: number;
  remindAt: string;
  reminderSentAt: string | null;
  /** IANA timezone (e.g. "Africa/Johannesburg") captured from the
   *  client at create time. Used for display only — `starts_at` is
   *  always a UTC instant so the reminder fires at the right moment
   *  regardless of where the agent process or DB run. Defaults to
   *  'UTC' if the client didn't supply one. */
  timezone: string;
  /** Recurrence frequency; 'none' for a one-shot event. */
  recur: RecurFreq;
  /** Optional end-of-series cutoff (ISO). null = repeats until deleted. */
  recurUntil: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Notion-style content width: centered/narrow vs full available space. */
export type PageWidth = 'narrow' | 'wide';

export type PageRow = {
  id: string;
  /** DEPRECATED (folder phase 7): pages do not nest, so this is always
   *  null. A page's place is its folder in the pages tree
   *  (`GET /api/tree/pages`; `PageDetail.folderId`). Kept so a client from
   *  before the tree, which built a hierarchy from it, still parses the row. */
  parentId: string | null;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  visibility: PageVisibility;
  width: PageWidth;
  /** Access level (admin > team > client > public); the owner UI's badge. */
  audience: AccessLevel;
  createdAt: string;
  updatedAt: string;
};

/**
 * DEPRECATED (folder phase 7): `GET /api/pages` answers plain `PageRow`s.
 * Pages do not nest, so nothing has sub-pages or a parent page any more; a
 * client from before the tree reads `childCount` as 0 and `parentTitle` as
 * null (both absent from the wire). Where a page sits is the pages tree's
 * (`GET /api/tree/pages`).
 */
export type PageListRow = PageRow & {
  childCount: number;
  parentTitle: string | null;
};

export type AppRow = {
  id: string;
  title: string;
  /** Emoji, or `lucide:<name>` from the client's curated set (app-nav.ts). */
  icon: string | null;
  /** Tile tint key (APP_TINTS); null = the client's neutral default. */
  color: AppTint | null;
  tags: string[];
  summary: string | null;
  description: string | null;
  /** Number of declared api_tool slugs. */
  toolCount: number;
  /** Whether the published source has a green build (renders today). */
  hasBuild: boolean;
  /** Whether an uncommitted draft exists. */
  hasDraft: boolean;
  /**
   * The app's exposure: mode of its active share ('public'), or null when it
   * has never been shared / the share is revoked (owner-only).
   */
  shareMode: ShareMode | null;
  /** Whether this app is the designated Team Hub (prefs.teamHubAppId). */
  isHub: boolean;
  /** Access level (admin > team > client > public); the owner UI's badge. */
  audience: AccessLevel;
  /** The share it inherits from a folder above it (team or client), or
   *  null; it is read at the more open of this and `audience`. Optional:
   *  absent from brains before the folder audit fixes. */
  inherited?: 'team' | 'client' | null;
  /** The share it is read at through something that embeds it (migration
   *  0208), or null. Optional: absent from brains before it. */
  embedded?: 'team' | 'client' | null;
  /** Informational (client logins C6): members and clients only read the
   *  app's data. Off, an app at team or client level is a shared workspace
   *  everyone who runs it writes. Set with PATCH /api/apps/:id
   *  `{ dataReadOnly }`. Absent from an older brain: read as false. */
  dataReadOnly?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AppDetail = AppRow & {
  source: AppSource;
  draft: AppSource | null;
  manifest: AppManifest;
  draftBuild: BuildRef | null;
  publishedBuild: BuildRef | null;
  /** When the draft last changed (ISO), null with no draft. The editor sends
   *  it back as `baseDraftUpdatedAt` on save, and the save answers 409 when
   *  the draft changed since (an agent or another window). Optional: absent
   *  from an older brain. */
  draftUpdatedAt?: string | null;
};

/**
 * One entry on an app's History line (apps snapshots, Phase 2). A VERSION
 * (`trigger` 'publish') is the code a publish made live; a SNAPSHOT (the
 * owner's, or one taken automatically before a restore or a schema change)
 * also holds a copy of the app's database. `seq` is the number the owner sees
 * (v1, v2 …).
 */
export type AppSnapshot = {
  id: string;
  seq: number;
  trigger:
    'publish' | 'manual' | 'pre_restore' | 'pre_schema' | 'pre_delete' | 'pre_import' | 'nightly';
  kind: 'version' | 'snapshot';
  note: string | null;
  actor: 'owner' | 'agent' | 'mcp' | 'system';
  createdAt: string;
  /** The seq this one's content was restored from, when it was. */
  restoredFrom: number | null;
  /** Whether it holds a copy of the database (a snapshot), and its size. */
  hasData: boolean;
  dbBytes: number | null;
  /** The code it holds: files and their total size. */
  fileCount: number;
  sourceBytes: number;
  /** Whether an unpublished draft was saved with it. */
  hasDraft: boolean;
};

/** What a restore puts back: code into the draft, the data, or both live. */
export type AppRestoreMode = 'code' | 'data' | 'full';

/**
 * One entry on a table's History line (apps first-class plan, Phase 4). A
 * `commit` entry is the published table a commit replaced (kept by
 * itself, the newest 20); a `manual` one the owner took. Each holds a copy
 * of the whole workbook. `seq` is the number the owner sees (v1, v2 …).
 */
export type TableSnapshot = {
  id: string;
  seq: number;
  trigger: 'commit' | 'manual';
  note: string | null;
  actor: 'owner' | 'agent' | 'mcp' | 'system';
  createdAt: string;
  /** The table's version the copy holds (it counts commits). */
  tableVersion: number | null;
  /** The copy's size in bytes. */
  bytes: number | null;
};

export type ProfilePreferences = {
  /** IANA timezone, e.g. 'Africa/Johannesburg'. UTC when not set. */
  timezone: string;
  /** The last zone the auto-from-location hook DERIVED (not necessarily the one
   *  in `timezone`, if the user manually overrode since). Used purely for
   *  hysteresis: the hook only acts when the freshly-derived zone differs from
   *  this, so it won't fight a manual change or re-switch every turn at the same
   *  place. See auto-timezone.ts. */
  lastAutoTimezone?: string;
  /** BCP-47 locale, e.g. 'en-GB'. Drives date/number/currency
   *  formatting. Falls back to en-GB to match the legacy pinned
   *  format-datetime behaviour, so existing UI doesn't shift for
   *  users who haven't visited /settings/profile yet. */
  locale: string;
  /** Avatar style id — the BRAIN's avatar visual language, applied to every
   *  generated avatar (the owner's and every agent's). Brain-level alongside
   *  colorTheme and the display fonts, because it is a branding choice, not a
   *  personal one: one style with a different seed per entity reads as one
   *  product, six unrelated styles at once read as noise. Individuality lives
   *  in `avatarSeed`, which stays personal. See @mantle/web-ui/avatar for the
   *  registry; unknown ids resolve to the default rather than stranding. */
  avatarStyle?: string;
  /** How much of the theme generated avatars take on: 'native' (the style's own
   *  palette), 'mixed' (themed background, original artwork — the default) or
   *  'theme' (theme colours throughout). Brain-level for the same reason as
   *  avatarStyle: it describes how this brain's avatars look, not one login's
   *  taste. Read via projectAvatarTint, never raw. */
  avatarTint?: string;
  /** Which generated background each area of the shell shows, as
   *  `area=style` pairs (`menu=waves,header=off`). Brain-level for the same
   *  reason as avatarStyle and colorTheme: it is the look of the product.
   *  `off` is a real, storable choice, see @mantle/web-ui/backgrounds. Areas
   *  on their default are omitted, so a default change still reaches brains
   *  that never chose. Read via projectBackgrounds, never raw. */
  backgrounds?: string;
  /** The generated whole-surface Neat gradient (login screen, content area),
   *  as a compact JSON spec `{v,seed,tone,speed}` — colours are DERIVED from
   *  the live theme tokens client-side, never stored, so the background
   *  follows every colour theme and mode. Brain-level for the same reason as
   *  backgrounds: it is the look of the product. Unset ⇒ the plain themed
   *  fill. Read via projectNeatBackground, never raw. */
  neatBackground?: string;
  /** The brain's default light/dark mode for surfaces where the visitor has
   *  not chosen one themselves — today the public /s share reader, which stamps
   *  it server-side and lets the visitor's own toggle override it locally.
   *  'light' | 'dark' | 'system'; unset ⇒ 'light' (the share surface's
   *  historical rendering, so an unset brain looks exactly as before). Brain-
   *  level like colorTheme: it is the look of the product's public face. Read
   *  via projectDefaultMode, never raw. */
  defaultMode?: string;
  /** Whether the public /s share reader paints the saved Neat gradient at all.
   *  Default ON (only an explicit `false` disables, the streamThoughts
   *  contract): the switch exists for owners who want share links to stay on
   *  the plain themed surface — the printable rendering — while the app keeps
   *  its background. Brain-level like neatBackground itself. */
  shareNeat?: boolean;
  /** Seed for THIS user's avatar; the UI defaults it to the user id when unset
   *  so an avatar still renders. Personal — two admins share the brain's style
   *  but never the same avatar. */
  avatarSeed?: string;
  /** Avatar-builder component choices for THIS login's avatar, layered over
   *  the seed: component name → pinned variant, or null to hide an optional
   *  component. Per-login (the profile routes address the ACTOR's row). Stale
   *  entries (saved under another brain style) are ignored at render time.
   *  READ: absent/empty = seed only. WRITE (profile PUT): applied only when
   *  SENT; `{}` clears. */
  avatarParts?: Record<string, string | null>;
  /** Content-addressed storage key of THIS login's uploaded profile PHOTO —
   *  when set, clients show the photo instead of the generated avatar
   *  (photo → generated seed → initials). Per-login (the photo routes address
   *  the ACTOR's row); set only from Settings → Profile, never for agents.
   *  Served privately by GET /api/profile/photo (cookie or asset token). */
  avatarPhotoKey?: string;
  /** Content-Type of the photo bytes (png/jpeg/webp — never SVG). */
  avatarPhotoType?: string;
  /** Slug of the responder agent whose Telegram bot delivers event reminders.
   *  Unset → the reminder worker falls back to the most-recently-active allowed
   *  DM (whichever bot you last messaged). Set it to pin reminders to one
   *  persona, e.g. 'telegram-default' (Saskia), so they don't come from
   *  whichever bot happened to be most recent. */
  reminderAgentSlug?: string;
  /** Where event reminders are delivered: 'telegram' (a bot DM) or 'mobile' (a
   *  push to the companion app). Auto-tracked — it follows the last channel the
   *  user actually messaged on (see noteInboundChannel), and can be set manually
   *  from the profile; a manual choice holds until the next message on the other
   *  channel supersedes it. Unset ⇒ the reminder worker defaults to 'telegram'
   *  (backward-compatible). See docs/reminder-delivery-routing.md. */
  reminderChannel?: ReminderChannel;
  /** What the user likes to be called (captured during onboarding). Cosmetic —
   *  the assistant's real knowledge of the user comes from the Journal identity
   *  block; this is for greetings/UI. */
  displayName?: string;
  /** Custom site name rendered as the header wordmark in place of "mantle" —
   *  a per-box label (e.g. 'Refinery') so anyone with several brains can see at
   *  a glance which one they're on. Cosmetic only; unset ⇒ the Mantle wordmark.
   *  Read via projectSiteName, never raw. */
  siteName?: string;
  /** This brain's peer name — shown in the header CENTRE (replacing the old page
   *  title) as this node's federation-facing identity label. Cosmetic; unset ⇒
   *  the header centre is empty. Read via projectPeerName, never raw. */
  peerName?: string;
  /** The owner's writing conventions, in their own words — appended to EVERY
   *  agent's composed system prompt as a `## House style` block (see
   *  composeSystemPromptWithSkills). Brain-level, because it describes how this
   *  brain writes, not how one login works.
   *
   *  Free text rather than a checkbox on purpose: the first rule anyone wants
   *  is "no em dashes", the second is "don't say 'delve'", and a boolean per
   *  rule is a migration per taste. Unset ⇒ no block is emitted at all, so the
   *  cached prompt prefix is byte-identical to before the feature existed.
   *  Read via projectHouseStyle, never raw. */
  houseStyle?: string;
  /** The UI colour-theme id (the header theme toggler / random shuffle). The
   *  DB copy is the source of truth so the choice follows the owner across
   *  browsers and brands member-facing surfaces (/s, /team) — localStorage
   *  stays only as the before-paint fast path. Unset ⇒ the default theme.
   *  Read via projectColorTheme, never raw. */
  colorTheme?: string;
  /** Selectable header WORDMARK font key (Settings → Appearance → Fonts). The
   *  font LIST lives in the web app (server/web/lib/display-fonts.ts); the server
   *  stores any well-formed slug and the client falls back to the default for
   *  keys it doesn't know, so trimming the library never strands the preference.
   *  Unset ⇒ the default wordmark face (Bricolage Grotesque). Read via
   *  projectFontKey, never raw. */
  fontLogo?: string;
  /** Selectable header page-TITLE font key — same contract as `fontLogo`.
   *  Unset ⇒ the default UI sans. Read via projectFontKey, never raw. */
  fontTitle?: string;
  /** The INTERFACE font key — what the whole UI is set in, not just a header
   *  ornament. Same contract as `fontLogo`; unset ⇒ Inter (the always-loaded
   *  next/font face). Read via projectFontKey, never raw. */
  fontUi?: string;
  /** The PAGES/NOTES font key — what long-form prose is set in, in the editor,
   *  on shared pages, and in the PDF export. Same contract as `fontLogo`; unset
   *  ⇒ 'inherit' (follow the interface font). This is the one slot where the
   *  choice leaves the browser: a page exported to PDF is typeset in it. */
  fontProse?: string;
  /** UI scale: 'xsmall' | 'small' | 'medium' | 'large'. Drives the ROOT
   *  font-size, so the rem-based shell scales with it rather than only the
   *  letters. Unset ⇒ 'medium'. Read via projectFontSize, never raw. */
  fontSize?: string;
  /** Wordmark scale — same vocabulary as `fontSize`, but a LOCAL multiplier on
   *  one element rather than the root font-size (a wordmark that rescaled the
   *  whole shell would be a bug). Unset ⇒ 'medium'. */
  fontLogoSize?: string;
  /** Peer-name scale. Same contract as `fontLogoSize`. */
  fontTitleSize?: string;
  /** Pages/Notes prose scale. Same contract as `fontLogoSize`. */
  fontProseSize?: string;
  /** Brand logo: the content-addressed storage key of the uploaded image
   *  (attachments/aa/bb/<sha256> — @mantle/storage contentKey). Set/cleared
   *  ONLY via PUT/DELETE /api/profile/logo, which validates the bytes; when
   *  set, both headers render the image in place of the siteName wordmark.
   *  The sha in the key doubles as the cache-busting version. Read via
   *  projectLogoKey, never raw. */
  logoKey?: string;
  /** The logo's mime type, from the validated upload (svg/png/jpeg/webp
   *  allowlist — projectLogoType). The public serve route replays it. */
  logoType?: string;
  /** Optional DARK-MODE logo variant — same storage/validation contract as
   *  logoKey, uploaded via PUT /api/profile/logo?variant=dark. Renderers show
   *  it when the UI is in dark mode and fall back to the base logo (then the
   *  wordmark) when unset — so a light-on-transparent mark stays readable on
   *  both themes without forcing every brain to upload two files. */
  logoDarkKey?: string;
  /** The dark variant's mime type (same allowlist as logoType). */
  logoDarkType?: string;
  /** Free-text "what this brain is for" — captured at onboarding, editable in
   *  Settings → Profile. Injected as the "# Purpose of this brain" section of the
   *  always-on identity block (identity-context.ts), so every agent knows the
   *  brain's mission. */
  purpose?: string;
  /** The brain's speciality archetype key (see onboarding-questions.ts
   *  PURPOSE_ARCHETYPES — 'personal' | 'analytics' | 'research' | 'robotics' |
   *  'team' | 'custom'). Descriptive for now; the seam a later phase can branch
   *  default provisioning on. */
  purposeArchetype?: string;
  /** ISO instant onboarding was completed. Unset ⇒ the onboarding wizard runs
   *  on next login; the (app) shell redirects there. Set ⇒ shell renders normally. */
  onboardedAt?: string;
  /** Resume marker for the onboarding wizard — the key of the furthest step the
   *  user has reached. Lets a refreshed/re-entered wizard pick up where it left off. */
  onboardingStep?: string;
  /** Model choices captured by the onboarding "Models" step — the operator
   *  overlay `provisionDefaults()` applies on top of the manifest seed (the
   *  assistant's chat model + the indexing workers' fast model). When
   *  `route: 'azure'`, those rows are pinned to an Azure OpenAI endpoint via
   *  the `custom` provider (key stored under service `custom`). */
  onboardingModels?: OnboardingModelChoices;
  /** When true, tools an AGENT authors (via Toolsmith / api_tool_create) start
   *  confirm-gated: every call parks for operator approval until the operator
   *  clears "requires confirm" for that tool in Settings → Tools. Defaults
   *  OFF — a simple single-owner brain trusts itself; turn it ON if you grant
   *  tool-authoring to an agent that reads untrusted content (email/web), so an
   *  injected agent can't stand up a silent exfiltration endpoint. Independent
   *  of the always-on guards (self-grant block, no-lower-via-update, SSRF). */
  toolsmithRequireApproval?: boolean;
  /** APP_VERSION the boot-time manifest reconcile last synced this brain to.
   *  The reconcile (server/web instrumentation → reconcileManifestOnBoot) runs once
   *  per version on a deployed/updated instance, so a self-hoster who only pulls a
   *  new image still gets new tools/skills/group-membership without running seed
   *  scripts. Equal to APP_VERSION ⇒ already reconciled, skip. */
  lastReconciledVersion?: string;
  /** When true, outbound/egress tools (email_send, web_fetch, web_search)
   *  fired during an UNATTENDED heartbeat run park for operator approval
   *  instead of executing inline. Only tools that reach OUT are gated — the
   *  heartbeat's own surface reply (the final Telegram message) is not a tool
   *  and still goes through. Defaults OFF: most heartbeats are trusted
   *  routines. Turn it ON for an agent that reads untrusted content on a
   *  timer, so an injected instruction can't silently email or fetch on your
   *  behalf while you're away. Pairs with the interactive Telegram approval
   *  card so a parked egress call can be cleared from a phone. */
  heartbeatEgressGate?: boolean;
  /** Show the live "thinking" trail + stream the reply token-by-token in the
   *  /assistant chat (and the companion). **Defaults ON** (undefined → on); set
   *  false to fall back to a static thinking bubble + the reply appearing whole
   *  on completion. This is the per-brain runtime control for live turn
   *  streaming; the `MANTLE_TURN_STREAMING` env var is a deploy-level override
   *  (env off wins). Read by the web turn route (202 vs blocking + the SSE gate)
   *  via `isStreamThoughtsEnabled`. */
  streamThoughts?: boolean;
  /** How the LIVE thinking trail renders during a turn: 'list' stacks completed
   *  actions above the active line (default); 'replace' shows only the current
   *  action, each one replacing the last (compact, single line). The frozen
   *  record view (after the turn) is unaffected. */
  thoughtTrailMode?: ThoughtTrailMode;
  /** Persist the thought trail onto the finished message so it survives a page
   *  refresh — reconstructed from the turn's tool actions and stored on the
   *  durable row, so it reloads on web AND the companion. **Defaults ON**; set
   *  false to keep it ephemeral (in-memory only; clears on reload). See
   *  `isPersistThoughtsEnabled`. */
  persistThoughts?: boolean;
  /** Per-user thinking budget in tokens. Real model reasoning is requested only
   *  when the live-thinking switch is ON (`streamThoughts`) AND this is > 0;
   *  0 / unset = no thinking. Maps to the provider's knob in the adapters
   *  (Anthropic adaptive, OpenRouter `reasoning.max_tokens`, Gemini
   *  `thinkingConfig`, Copilot `reasoning_effort`). This is the per-user
   *  replacement for the old per-box `MANTLE_THINKING_BUDGET` env gate. Resolve
   *  via `resolveThinkingBudget` — never read raw, so the switch gate always
   *  applies. **Defaults unset (off).** */
  thinkingBudget?: number;
  /** Whether this box exposes its remote MCP connector (the OAuth-gated
   *  `/api/mcp` endpoint addable as a claude.ai custom connector). **Defaults
   *  OFF** — it's an explicit opt-in because it puts the tool surface on the
   *  public internet (behind OAuth). When off, `/api/mcp` + the OAuth
   *  authorize/register endpoints 404, so no new client can connect and existing
   *  tokens stop working. Flip it in Settings → MCP. */
  remoteMcpEnabled?: boolean;
  /** Whether the external Team Chat responder may read the owner's PRIVATE
   *  corpus — email + journal — on a team member's behalf. **Defaults OFF**:
   *  team members always get brain-wide knowledge reads (search, files, notes,
   *  pages, tables, tasks, contacts, app data), but the owner's personal email
   *  history and journal stay off-limits unless this is explicitly turned on.
   *  Enforced at the team turn's tool resolution (`isTeamPrivateReadsEnabled`
   *  strips `email_*`/`journal_*` when off), independent of the `team-read`
   *  group grant, so the switch can't be bypassed by a manifest change. Flip it
   *  from the Team admin surface. */
  teamPrivateReads?: boolean;
  /** Node id of the mini-app designated as the members' HOME APP (the name
   *  is from the retired /team hub). A member login's home renders it
   *  full-bleed while it has a green published build and is at a level
   *  members may run (`resolveMemberHomeApp`, member-apps.ts); the built-in
   *  member home is the fallback. No share link is involved. Read via
   *  projectTeamHubAppId, never raw. */
  teamHubAppId?: string;
  /** The email account client sign-in codes are sent from (client logins
   *  C2b). A BRAIN key: one sender for the brain. Unset = codes are off. */
  clientSigninSenderId?: string;
  /** Tags the owner curates as Dashboard sections on the /team overview: each
   *  tag renders a section of up to 5 team-visible shared pages carrying it
   *  (newest-updated first, title + summary + /s link). Order here = section
   *  order. The share stays the single source of truth for WHAT is visible —
   *  this pref only chooses which tag groupings get pinned. Unset/empty ⇒ no
   *  curated sections. Read via projectTeamHubTags, never raw. */
  teamHubTags?: string[];
  /** BRAIN-level sidebar layout for mini apps: folders (nested up to
   *  APP_NAV_MAX_DEPTH), their order, and where each app sits. Written ONLY
   *  through saveAppNav (rev-checked), read via projectAppNav, never raw. */
  appNav?: AppNav;
  /** Per-login: app ids pinned above the tree, in order. */
  appPins?: string[];
  /** Per-login: sidebar favourite hrefs, in order. Moved server-side from the
   *  web client's localStorage so they follow the person across devices. */
  navFavorites?: string[];
  /** Per-login: open count + last-opened instant per app id, feeding the
   *  "Most used" and "Recent" filters. Written by recordAppOpen. */
  appOpens?: Record<string, AppOpenStat>;
};

export type BackupConfig = {
  enabled: boolean;
  frequency: BackupFrequency;
  /** Hour of day (0-23) in the USER's timezone (profiles.preferences.timezone). */
  hour: number;
  /** Newest N dumps retained in the directory. */
  keep: number;
  /** Absolute destination directory. Empty/unset → resolveBackupDir default. */
  location?: string;
};

export type BackupFile = { name: string; bytes: number; mtime: string };

export type BackupStatus = {
  lastRunAt: string;
  ok: boolean;
  /** Set when ok=false. */
  error?: string;
  file?: string;
  bytes?: number;
  durationMs?: number;
  /** 'schedule' | 'manual' — what triggered the run. */
  trigger: string;
  /** When the last SUCCESSFUL run finished — preserved across failed runs,
   *  so the /debug/integrity staleness check can tell "failing for a week"
   *  from "failed once after last night's good dump". */
  lastSuccessAt?: string;
  /** Sqlite-native table workbooks snapshotted beside the dump (durability
   *  gate 2). failed>0 is surfaced in the settings card — a backup that
   *  silently skips a workbook is the gap this closes. */
  tableDbs?: { snapshotted: number; missing: number; failed: number };
  /** Per-app mini-app SQLite databases snapshotted beside the dump. Same
   *  durability gate as tableDbs: these live on their own volume, so pg_dump
   *  alone misses them and a scheduled backup would silently omit all app
   *  data (e.g. a Team Hub app's DB) without this pass. */
  appDbs?: { snapshotted: number; missing: number; failed: number };
};

export type CuratedTeamSection = {
  /** The curated tag — the section heading (display-cased by the UI). */
  tag: string;
  /** Up to {@link TEAM_CURATED_SECTION_LIMIT} team-visible page shares carrying
   *  the tag, newest node update first. */
  items: TeamVisibleShare[];
};

/** One contact's OLD team portal chat (the Members tab's "Chat archive"
 *  roster, GET /api/team-admin/members). Since team codes were retired
 *  (member logins Phase 6, migration 0178) the roster is every contact with
 *  portal chat, not every code holder. */
export type TeamMemberActivity = {
  contactId: string;
  /** Contact node title; '(deleted contact)' can't occur here: portal chat
   *  rows cascade with the contact. */
  contactName: string;
  /** The first portal message (it was when the contact's team code was
   *  made, before 0178). */
  memberSince: string;
  lastMessageAt: string | null;
  lastMessageText: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  messageCount: number;
  /** Member inbound messages since the owner last read this thread in
   *  /team-admin (all inbound when never read). Drives the unread badge. */
  unread: number;
};

export type TeamRequest = {
  taskId: string;
  title: string;
  body: string;
  status: 'open' | 'done';
  priority: string;
  createdAt: string;
  /** Provenance from data.teamRequest. A member LOGIN's request (the only
   *  kind filed since the team-code portal retired) has `loginId` set and
   *  `contactId` null; a request from the old portal has a contact and no
   *  login. Reply and "View their chat" apply when either is set. */
  contactId: string | null;
  /** The member login that filed it; null on a portal-era request. */
  loginId: string | null;
  contactName: string | null;
  /** When the owner last posted a resolution to the member for this request. */
  notifiedAt: string | null;
  /** True for a request a CLIENT login filed through the client-responder
   *  (client logins C4, 0.232.336 on): the reply still goes into that
   *  login's thread. Absent on older brains = a member's request. */
  fromClient?: boolean;
};

/** The newest thing waiting in one "needs you" queue: its title and who it
 *  is from, never its content (a notification shows exactly this). */
export type NeedsYouItem = {
  id: string;
  title: string;
  /** The member's display name (or the email's local part). */
  from: string;
  /** When it started waiting (submitted, or the request was filed). */
  at: string;
};

/**
 * GET /api/team-admin/needs-you: what waits for an admin, as counts from
 * count queries (never a capped list), so every window and device shows the
 * same number. The owner live stream (/api/realtime) sends a change typed
 * `needs_you` whenever one of these counts may have moved; the client
 * refetches this. Admins only: a member login gets 403.
 */
export type NeedsYou = {
  review: {
    /** Items members submitted (incl. taken items whose admin is gone). */
    submitted: number;
    /** Team-shared items deactivated logins left behind. */
    leftBehind: number;
    /** The newest submitted item, or null. */
    newest: NeedsYouItem | null;
  };
  requests: {
    /** Open (not done) team requests. */
    open: number;
    newest: NeedsYouItem | null;
  };
  /** Contacts whose sharing locked after 30 wrong codes in a day (contact
   *  shares, migration 0214): the code opens nothing until the lock lapses
   *  or an admin regenerates it. `newest.from` is empty. Absent from brains
   *  before 0214. */
  sharing?: {
    locked: number;
    newest: NeedsYouItem | null;
  };
  /** Embedding or extraction provider failures an admin must act on
   *  (migration 0230, docs/embeddings.md "Provider outages"). Absent from
   *  brains before 0230; empty while all works. */
  providers?: ProviderAlert[];
  /** review.submitted + review.leftBehind + requests.open (+ sharing.locked)
   *  (+ providers.length). */
  total: number;
};

/**
 * One open provider outage, as an admin sees it. `reason` is fixed text
 * chosen by `code`, never provider text: it is safe on a banner and a phone.
 */
export type ProviderAlert = {
  subject: 'embedding' | 'extraction';
  /** quota | auth | no_key | model (permanent); rate_limit | server |
   *  network | timeout (transient, shown after 10 min). */
  code: string;
  permanent: boolean;
  reason: string;
  /** Provider id (e.g. `openai`) and model slug. Never a key. */
  provider: string | null;
  model: string | null;
  /** When it started failing (ISO). */
  since: string;
  /** The extract queue stopped taking jobs until it works again. */
  paused: boolean;
  /** When the brain tries one tiny call again (ISO), or null. */
  nextProbeAt: string | null;
  /** Extract jobs that wait: queued, retrying, running and dead-lettered.
   *  Null when the queue has not started yet. */
  waiting: number | null;
};

export type AccountFoldersResult =
  | {
      ok: true;
      address: string;
      /** Every folder the server reports right now (the pick list). */
      allFolders: string[];
      /** The current explicit allow-list, or null = "scan all non-excluded". */
      included: string[] | null;
      /** Folders the operator opted OUT of (rendered disabled). */
      excluded: string[];
      /** Folders the sync has actually touched (per the cursor). */
      scanned: string[];
    }
  | { ok: false; error: string };

export interface FolderFacet {
  folder: string;
  count: number;
  unread: number;
}

export interface MessageListItem {
  id: string;
  fromAddr: string;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  internalDate: Date;
  isRead: boolean;
}

export interface MsConfigStatus {
  configured: boolean;
  /** Where the active config comes from — drives the UI ("set here" vs "from
   *  environment, read-only"). */
  source: 'db' | 'env' | null;
  clientId: string | null;
  tenant: string;
  redirectUri: string | null;
  /** Masked secret for display; never the plaintext. */
  secretMasked: string | null;
}

/** One retrieved (or near-miss) item: capped text + its ranking distance. */
export type SnapshotItem = {
  text: string;
  /** Ranking distance (cosine, salience/recency-adjusted where the section
   *  ranks that way). Null for always-injected items (preferences) that
   *  bypass the vector race. */
  dist: number | null;
  kind?: string | null;
  entity?: string | null;
  nodeId?: string | null;
  title?: string | null;
  heading?: string | null;
};

/** A context stage the decision trace names (ContextTrace). */
export type ContextTraceStage =
  | 'embed'
  | 'facts'
  | 'prefs'
  | 'hits'
  | 'search'
  | 'scoring'
  | 'select'
  | 'supersede'
  | 'pruning'
  | 'versions'
  | 'journal'
  | 'map'
  | 'relations'
  | 'digests'
  | 'history';

/** What found a candidate: the vector arm, the keyword arm, both, the
 *  source note of a matching fact (promoted), always-on (preferences), the
 *  Journal tiers. */
export type ContextTraceArm = 'vector' | 'keyword' | 'both' | 'fact-source' | 'always' | 'journal';

/**
 * One candidate a context stage touched (decision trace v1). Compact on
 * purpose: ids, rounded numbers and reason codes, no text (the text is in the
 * snapshot's sent/dropped lists, and on the node).
 */
export type ContextTraceRow = {
  /** Block: fact, pref (preference), hit (content hit), chunk (passage), journal. */
  b: 'fact' | 'pref' | 'hit' | 'chunk' | 'journal';
  /** Item key: fact id, node id, or `nodeId:ordinal` for a passage. */
  k: string;
  /** The outcome for this turn's prompt. */
  out: 'kept' | 'dropped';
  /** The stage that decided the outcome. */
  at: ContextTraceStage;
  /** Reason code. Kept: `sent`, `promote:fact-source`, `always`. Dropped:
   *  `guard:0.85` and `cut:<d>` (distance cutoffs), `limit:<n>` (the block's
   *  budget cap), `room:promote` (gave its slot to a promoted passage),
   *  `judge:<t>` (a Jev score under the threshold), `dedupe:journal`,
   *  `dedupe:fact`, `superseded`, `version`, `type:<t>`, `shadow` (a Journal
   *  pick in shadow mode). */
  why: string;
  arm?: ContextTraceArm;
  /** 1-based rank in the order the stage received it (search order). */
  rank?: number;
  /** Passages: 1-based rank in the vector arm / the keyword arm. */
  vr?: number;
  kr?: number;
  /** Passages: 1-based rank in the window arm (passage windows on). */
  wr?: number;
  /** Passages: forced into the tail by the keyword rescue floor. */
  rescued?: true;
  /** Raw cosine distance (Journal: 1 - similarity). */
  d?: number | null;
  /** The distance it was RANKED by (salience, recency), when it differs from `d`. */
  rd?: number;
  /** Jev score 0-3 (passage_scoring, context_pruning, journal_recall). */
  s?: number;
  /** A shadow use's verdict: what WOULD have happened. `out` is unchanged. */
  would?: string;
};

/** Decision trace v1: per stage, what was considered, kept and dropped, and
 *  why. Recorded in the load_context snapshot and the search_chunks step.
 *  Observation only: it never changes what the model sees. */
export type ContextTrace = {
  v: 1;
  /** Stages in run order: candidates in, kept out, wall time. */
  stages: Array<{ name: ContextTraceStage; in: number; out: number; ms: number; note?: string }>;
  /** Passage search: pool size of each arm, and the keyword arm's gate. */
  search?: {
    mode: 'vector' | 'hybrid' | 'keyword';
    vectorPool: number;
    keywordPool: number;
    /** Passages the window arm found (passage windows on), else absent. */
    windowPool?: number;
    /** `off` = no query text; `silent` = no rare term passed the gate;
     *  `and` = no rare term, every word ANDed; `rare` = the rare-term arm ran. */
    keyword: 'off' | 'silent' | 'and' | 'rare';
    /** The stemmed rare terms the keyword arm matched on (at most 8). */
    terms?: string[];
  };
  rows: ContextTraceRow[];
  /** Rows left out past the row cap (kept rows go first). */
  more?: number;
  ms: number;
};

export type ContextSnapshot = {
  query: {
    /** The inbound text as given to retrieval (snipped). */
    inbound: string;
    /** The anaphora-enriched text actually embedded, when it differs. */
    enriched: string | null;
    /** False when embedding was skipped or failed — retrieval ran blind. */
    embedded: boolean;
  };
  facts: { sent: SnapshotItem[]; dropped: SnapshotItem[]; guard: number };
  contentHits: { sent: SnapshotItem[]; dropped: SnapshotItem[]; cutoff: number };
  chunkHits: { sent: SnapshotItem[]; dropped: SnapshotItem[]; cutoff: number };
  relations: string[];
  digests: { count: number; topics: string[] };
  history: {
    count: number;
    /** How many outbound turns carried a [tool record: …] read-back suffix. */
    toolRecords: number;
    /** How many turns carried a [media record: …] read-back suffix. */
    mediaRecords: number;
    /** Start of the open chat thread (ISO) when the chat was ever archived
     *  ("New chat", docs/conversation.md §6c): older turns and digests are
     *  out of the prompt. Absent on a never-archived chat. */
    since?: string;
    /** Title of the archived thread this chat continues from, when the open
     *  thread was started with "Continue from this". */
    continuedFrom?: string;
  };
  personaNotes: { count: number };
  corpusMap: { count: number; truncated: boolean };
  /** Decision trace v1 (absent on turns recorded before it). */
  trace?: ContextTrace;
  /** The decider's `context_pruning` use, when it ran on this turn. In
   *  `shadow` the counts say what WOULD have been dropped; in `live` they were.
   *  Absent when the use is off or the call failed (nothing changed). */
  pruning?: {
    mode: 'shadow' | 'live';
    threshold: number;
    wouldDrop: { facts: number; contentHits: number; chunkHits: number };
    /** Characters of item text under the threshold (≈ tokens × 4). */
    charsSaved: number;
    ms: number;
    cached: boolean;
  };
  /** The decider's `version_grouping` use, when it ran on this turn. Part A
   *  (code): hits whose living successor is also in the pool. Part B (the
   *  model): passages judged a version of a higher-ranked passage from an
   *  unlinked node. `shadow`: counts only; `live`: dropped. */
  versionGrouping?: {
    mode: 'shadow' | 'live';
    threshold: number;
    wouldDrop: { superseded: number; versions: number };
    /** Candidate pairs asked about (0 = no model call). */
    pairs: number;
    ms: number;
    cached: boolean;
  };
  /** The decider's `history_recall` use, when it ran on this turn: every
   *  exchange older than history_limit (up to 50 messages back) with its
   *  score. `shadow`: `wouldAdd` says how many WOULD have rejoined the
   *  history; `live`: they did, before the recent part. */
  historyRecall?: {
    mode: 'shadow' | 'live';
    threshold: number;
    /** `back` = messages back from the newest; `score` null = unscored. */
    exchanges: Array<{ back: number; score: number | null; chars: number }>;
    wouldAdd: number;
    chars: number;
    calls: number;
    failed: number;
    /** Of `failed`: groups the open breaker kept from going out. */
    skipped?: number;
    /** Wall time of the whole fan-out (timeouts included). */
    ms: number;
    cached: boolean;
  };
  /** Journal tiers 2 and 3 (memory_config.journal_tiers), when the lookup
   *  ran. `shadow`: what WOULD have joined the prompt; `live`: what did.
   *  Absent when the tiers are off, both lanes are off, or no embedding. */
  journal?: {
    mode: 'shadow' | 'live';
    cutoff: number;
    /** Set when the lookup was skipped on purpose (greetings, thanks). */
    skipped: 'small_talk' | null;
    picked: Array<{
      nodeId: string;
      kind: string;
      similarity: number;
      chars: number;
      passage: boolean;
      /** The complete body went out (not a passage, not cut). */
      whole?: boolean;
      /** Jev's score when journal_recall picked it. */
      score?: number;
    }>;
    gap: { nodeId: string; similarity: number } | null;
    nearMisses: Array<{ nodeId: string; kind: string; similarity: number }>;
    chars: number;
    /** Facts, passages and content hits the tiers made redundant (dropped
     *  in `live`): only a whole entry (tier 1, or a whole tier 2 pick) makes
     *  its facts and hits redundant; a passage replaces its own chunk. */
    dedupe: { facts: number; chunkHits: number; contentHits?: number };
    /** Tier 1 for this agent: entries shown always-on, and those that did
     *  not fit and compete in tier 2 instead. */
    tier1?: { shown: number; overflow: number; chars: number };
    /** The decider's `journal_recall` use, when it ran: Jev's scores over
     *  the agent-lane rules. `shadow`: `picked` is what Jev WOULD send in
     *  place of the similarity pick; `live`: it did. */
    recall?: {
      mode: 'shadow' | 'live';
      threshold: number;
      /** Rules loaded / rules Jev answered for. */
      rules: number;
      scored: number;
      picked: Array<{ nodeId: string; score: number; chars: number }>;
      calls: number;
      failed: number;
      /** Of `failed`: groups the open breaker kept from going out. */
      skipped?: number;
      ms: number;
      cached: boolean;
    };
  };
};

export type BackupFrequency = 'daily' | 'weekly';

export type PageVisibility = 'private' | 'public';

/**
 * Recurrence frequencies an event can repeat on. `none` is the default —
 * a one-shot event. The reminder worker rolls a recurring event's single
 * row forward to its next occurrence after each ping (no instance
 * materialisation), so one node always represents the next upcoming hit.
 */
export type RecurFreq = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** Transports that can deliver a reminder out-of-band. A browser ('web') can't
 *  receive a push, so it never becomes a reminder target. */
export type ReminderChannel = 'telegram' | 'mobile';

/** Live thinking-trail display modes. */
export type ThoughtTrailMode = 'list' | 'replace';

/** The onboarding "Models" step's stored choices. Kept as one object so the
 *  projection can't half-apply; every field optional so partial saves survive. */
export interface OnboardingModelChoices {
  /** OpenRouter slug for the assistant/persona agent (e.g. `anthropic/claude-sonnet-4.6`). */
  assistantModel?: string;
  /** OpenRouter slug for the indexing workers (e.g. `google/gemini-3.1-flash-lite`). */
  workerModel?: string;
  /** Where the models run: OpenRouter (default) or an Azure OpenAI endpoint. */
  route?: 'openrouter' | 'azure';
  /** Azure OpenAI base URL (the OpenAI-compatible v1 endpoint), when route=azure. */
  azureBaseUrl?: string;
}

/**
 * Who a share admits. Lives in `shares.settings.mode` (absent = 'public', so
 * every pre-existing share keeps its behavior).
 *
 *   public — anyone with the link (the original model).
 *
 * 'team' is retired (member logins Phase 6 stage 6): members read team items
 * by level with their own logins. Migration 0176 revoked every team link, no
 * link is created or switched to team (PATCH /api/shares answers 400
 * `team-links-retired`), and an old team `/s` link shows a "sign in as a
 * member" page. Kept as a named type so the fields that carry it
 * (`AccessLinkView.mode`, `AppRow.shareMode`) keep their shape.
 */
export type ShareMode = 'public';

/**
 * Why a link was refused (the `reason` of a 400 from the share routes):
 * `team-links-retired` for a team link (member logins Phase 6), and
 * `client-links-retired` for any link on an item at client level (client
 * logins C1): client means signed-in clients, and public is the only level
 * with an open link.
 */
export type ShareRetiredReason = 'team-links-retired' | 'client-links-retired';

export type TeamVisibleShare = {
  /** Share token — the workspace opens /s/<token>. */
  token: string;
  nodeId: string;
  title: string;
  icon: string | null;
  summary: string | null;
  updatedAt: string;
  /** 'team' or 'public' — a member may open both, the badge tells them apart. */
  mode: 'team' | 'public';
  /** Parent node id — lets the pages section rebuild the sub-page tree over
   *  the SHARED subset (an unshared parent leaves its children as roots). */
  parentId: string | null;
  tags: string[];
  /**
   * EVENTS ONLY — the event's own start, from `nodes.data.starts_at`.
   *
   * Every other field here describes the SHARE; this one describes the thing
   * shared, and it is carried because for an event the two are not
   * interchangeable. `updatedAt` says when the row was last written, which is
   * the right meta line for a note or a table and useless for an event: a
   * member scanning what is coming up needs WHEN IT HAPPENS, and an event
   * edited this morning sorts above one starting tomorrow.
   *
   * Optional so a client pinned to an older server still parses the payload,
   * and null for every non-event type.
   */
  startsAt?: string | null;
};

// ── Mirrors of @mantle/db jsonb/enum shapes (jackdaw split P0) ────────────────
// Kept standalone so this package stays zero-dep (same convention as ToolHandler
// above). Drift is pinned directly, at compile time, by
// server/web/lib/client-types-drift.test.ts — the only place that can see both
// sides, since this package may never import @mantle/db. Add a mirror here,
// add its pin there.

/** Task lifecycle vocabulary — mirrors content's TASK_STATUSES/TASK_PRIORITIES
 *  consts, which are `satisfies`-checked against these unions. */
export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high';

/** Mirrors @mantle/db `ConversationAttachment` (jsonb on conversation rows). */
export type ConversationAttachment = {
  kind: 'image' | 'audio' | 'voice' | 'document' | 'video';
  mime?: string;
  caption?: string;
  nodeId?: string;
  fileId?: string;
  url?: string;
};

/** Mirrors @mantle/db `AppSource` — a mini app's virtual file tree. */
export type AppSource = {
  /** Path of the entry module within `files`; must `export default App`. */
  entry: string;
  /** path → TSX/TS source. Bounded (~30 files / ~256 KB) to stay a mini app. */
  files: Record<string, string>;
};

/** Mirrors @mantle/db `AppManifest` — the runtime contract for a running app. */
export type AppManifest = {
  toolSlugs?: string[];
  sqlite?: { schemaSql: string; schemaVersion: number };
  description?: string;
};

/** Mirrors @mantle/db `BuildRef` — pointer to a bundled artifact in storage. */
export type BuildRef = {
  storageKey: string;
  sha256: string;
  builtAt: string;
  esbuildVersion: string;
  bytes: number;
  ok: boolean;
  warnings?: string[];
  css?: { storageKey: string; sha256: string; bytes: number };
};

// ── Redacted account DTOs (hand-mirrored; jackdaw split P0) ───────────────────
// These mirror db-derived server types (`Omit<EmailAccount,…>` etc.) that can't
// be re-exported without dragging the postgres type graph in. Timestamps are
// ISO strings here — the wire truth — where the server-side originals carry
// `Date`. Key-set drift checks live next to the server definitions
// (email/accounts.ts, microsoft/accounts.ts, email's sync-runs consumer).

/** Mirrors @mantle/email `PublicEmailAccount` (an `email_accounts` row minus
 *  the sealed IMAP secret). */
export interface PublicEmailAccount {
  id: string;
  userId: string;
  provider: 'gmail' | 'microsoft' | 'imap';
  address: string;
  displayName: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  /** @deprecated historical reads only (migration 0002). */
  imapFolders: string[];
  imapExcludedFolders: string[];
  imapIncludedFolders: string[] | null;
  firstScanDays: number;
  ingestPolicy: 'approve_list' | 'block_list';
  branchPath: string;
  msAccountId: string | null;
  syncState: Record<string, unknown>;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors @mantle/db `SyncRun` (a `sync_runs` row) as it crosses the wire. */
export interface SyncRun {
  id: string;
  accountId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: 'running' | 'ok' | 'error';
  scanned: number;
  ingested: number;
  error: string | null;
}

/** Mirrors @mantle/microsoft `PublicMsAccount` (an `ms_accounts` row with the
 *  sealed OAuth tokens replaced by presence flags). */
export interface PublicMsAccount {
  id: string;
  userId: string;
  upn: string;
  displayName: string | null;
  tenantId: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  branchPath: string;
  surfaces: Record<string, boolean>;
  syncState: Record<string, unknown>;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}
