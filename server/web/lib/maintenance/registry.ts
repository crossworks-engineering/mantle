/**
 * Maintenance task registry — the single source of truth for every
 * operational/maintenance script in the repo. Consumed by:
 *
 *   - `pnpm maintain` (scripts/maintain.ts) — the terminal runner (Phase 1)
 *   - workers/maintenance.ts — pg-boss cron sweeps over `schedulable` tasks (Phase 2)
 *   - the /debug/integrity Maintenance tab (Phase 3)
 *
 * Design + audit rationale: docs/maintenance-runner.md. This module is pure
 * data (plus invariant assertions) — it must stay importable from CLI, worker,
 * and Next.js contexts alike, so no side effects and no app imports.
 */
import type { TaskCost, TaskKind, TaskStatus } from '@mantle/client-types/types/maintenance';
export type { TaskCost, TaskKind, TaskStatus };

/** What a LIVE run of the task spends. `sql` and `io` are free; `imap` costs
 * network round-trips to the mailbox; `embedding`/`llm` are real model spend. */

export interface MaintenanceTask {
  slug: string;
  title: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  cost: TaskCost;
  /** Eligible for the Phase-2 nightly cron worker. Guardrail below restricts
   * this to free, dry-run-by-default, recurring, live tasks. */
  schedulable: boolean;
  /** Script path relative to `cwd`. */
  script: string;
  /** Repo-relative working directory to spawn in. */
  cwd: 'server/web' | 'packages/email';
  /** The task cannot mutate or spend — it only reads and reports. Such a task
   *  has no dry-run/apply split to opt into, so it satisfies the schedulable
   *  guardrail without an `applyFlag`. Set this ONLY when the script provably
   *  writes nothing: it is the thing that lets the unattended cron run it. */
  readOnly?: boolean;
  /** Flag that switches the script from dry-run (its default) to live. */
  applyFlag?: string;
  /** Flag that switches the script from live (its default) to dry-run. */
  dryRunFlag?: string;
  /** Other flags the script understands, for `maintain info`. */
  extraFlags?: string[];
  /** Required positional args, e.g. a backup destination dir. */
  positionalArgs?: string[];
  /** Env vars beyond DATABASE_URL the script needs. */
  requiresEnv?: string[];
  notes?: string;
}

export const MAINTENANCE_TASKS: MaintenanceTask[] = [
  // ── Recurring hygiene ────────────────────────────────────────────────────
  {
    slug: 'entities-dedupe',
    title: 'Entity near-duplicate consolidation',
    description:
      'Detects near-duplicate entities (auto/review tiers) and merges them, re-pointing edges + facts to the canonical and folding the variant in as an alias. New ingest keeps producing candidates, so this is the one genuinely recurring hygiene job.',
    kind: 'recurring',
    status: 'live',
    cost: 'sql',
    schedulable: true,
    script: 'scripts/entities-dedupe.ts',
    cwd: 'server/web',
    applyFlag: '--go',
    extraFlags: ['--include-review', '--merge=<canonicalId>,<dupId>'],
    notes:
      'Interactive equivalent: the /settings/entities review UI. --go applies only the high-confidence auto tier.',
  },
  {
    slug: 'backup-app-dbs',
    title: 'Snapshot per-app SQLite DBs',
    description:
      'VACUUM INTO snapshots every per-app SQLite database into a destination dir. Invoked by scripts/db-dump.sh on the backup cadence.',
    kind: 'recurring',
    status: 'live',
    cost: 'io',
    schedulable: false,
    script: 'scripts/backup-app-dbs.ts',
    cwd: 'server/web',
    positionalArgs: ['<destDir>'],
    notes: 'Already scheduled via the db-dump.sh backup path — not for the cron worker.',
  },
  {
    slug: 'backup-table-dbs',
    title: 'Snapshot table workbook DBs',
    description:
      'VACUUM INTO snapshots every file-backed table workbook (published + draft) into a destination dir. The Tables-v2 durability gate, invoked by scripts/db-dump.sh.',
    kind: 'recurring',
    status: 'live',
    cost: 'io',
    schedulable: false,
    script: 'scripts/backup-table-dbs.ts',
    cwd: 'server/web',
    positionalArgs: ['<destDir>'],
    notes: 'Already scheduled via the db-dump.sh backup path — not for the cron worker.',
  },

  {
    slug: 'traces-reap',
    title: 'Reap abandoned traces (all owners)',
    description:
      "Closes traces stuck 'running' past the abandon threshold (MANTLE_EXTRACT_EXPIRE_MIN + 15) — the cron twin of the owner-scoped reaper the live-activity view runs on poll. On a box nobody browses, crashed runs otherwise sit as \"active\" for days and skew every running-count rollup. Marks status=error 'abandoned…' with duration_ms NULL (the true duration is unknowable).",
    kind: 'recurring',
    status: 'live',
    cost: 'sql',
    schedulable: true,
    script: 'scripts/traces-reap.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
    notes:
      'Idempotent; a no-op once clean. The /debug/integrity abandoned_traces audit check surfaces the same rows read-only.',
  },
  // ── Remedies (monitored one-shots) ───────────────────────────────────────
  {
    slug: 'dedupe-edges',
    title: 'Collapse duplicate mentioned_in edges',
    description:
      'Collapses duplicate mentioned_in entity edges (pre-idempotent-extractor legacy), keeping the earliest row per logical edge. The extractor is delete-then-insert now, so new dupes cannot accrue — the dashboard Memory-index card monitors the live duplicate count; run this only if it flags a regression.',
    kind: 'remedy',
    status: 'live',
    cost: 'sql',
    schedulable: false,
    script: 'scripts/dedupe-edges.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
    extraFlags: ['--relation=<name>'],
    notes:
      'Deliberately NOT recurring (docs/architecture.md §9k). Non-default --relation can destroy meaningful temporal history — read the script header first.',
  },

  // ── Ops (deliberate events) ──────────────────────────────────────────────
  {
    slug: 're-embed',
    title: 'Re-embed the corpus',
    description:
      'Re-runs embed() over stored vectors in nodes/facts/entities/content_chunks — for switching embedding model or repopulating after a dimension migration. Same-model re-runs hit the embedding cache (free); a different model embeds the whole corpus.',
    kind: 'ops',
    status: 'live',
    cost: 'embedding',
    schedulable: false,
    script: 'scripts/re-embed.ts',
    cwd: 'server/web',
    dryRunFlag: '--dry-run',
    extraFlags: [
      '--model=<id>',
      '--tables=<list>',
      '--types=<list>',
      '--limit=<n>',
      '--batch-size=<n>',
      '--repopulate',
    ],
    requiresEnv: ['ALLOWED_USER_ID'],
    notes: 'Heavy — full walk of up to four tables. Prints an estimated USD cost. Run off-hours.',
  },
  {
    slug: 'extract-backfill',
    title: 'Re-fire extraction for unindexed nodes',
    description:
      'Re-fires node_ingested NOTIFY for nodes missing a summary/embedding so the running agent re-extracts them. Used to sweep old content after extractor changes.',
    kind: 'ops',
    status: 'live',
    cost: 'llm',
    schedulable: false,
    script: 'scripts/extract-backfill.ts',
    cwd: 'server/web',
    extraFlags: ['--types=<list>', '--since=<date>', '--limit=<n>', '--rate=<seconds>'],
    notes:
      'Indirect chat + embedding spend via the extractor; requires the agent (server/api) to be running. No dry-run flag — it prints the candidate count before firing.',
  },
  {
    slug: 'draws-re-render',
    title: 'Re-render drawing snapshots',
    description:
      'Regenerates draws.scene_svg for drawings whose snapshot is missing or was drawn by a different Excalidraw version, using the browser sidecar. The snapshot is a cache of a render, so this is how an upstream bump heals the corpus and how agent-authored drawings get a preview at all.',
    kind: 'ops',
    status: 'live',
    // Browser time, not tokens: the write path never notifies the extractor.
    cost: 'io',
    schedulable: false,
    script: 'scripts/draws-re-render.ts',
    cwd: 'server/web',
    dryRunFlag: '--dry-run',
    extraFlags: ['--all', '--limit=<n>'],
    notes:
      'Costs browser time, not tokens — it never re-runs the extractor. Requires the browser sidecar (BROWSER_WS_ENDPOINT). --all re-renders every drawing, not just stale ones.',
  },
  {
    slug: 'rotate-master-key',
    title: 'Rotate MANTLE_MASTER_KEY',
    description:
      'Re-seals every encrypted-at-rest column (api_keys, IMAP creds, channel tokens, secrets) under MANTLE_MASTER_KEY_NEXT. Resumable; skips rows already re-sealed.',
    kind: 'ops',
    status: 'live',
    cost: 'crypto',
    schedulable: false,
    script: 'scripts/rotate-master-key.ts',
    cwd: 'server/web',
    requiresEnv: ['MANTLE_MASTER_KEY', 'MANTLE_MASTER_KEY_NEXT'],
    notes: 'Follow the documented env-swap procedure. No dry-run.',
  },
  {
    slug: 'sync-now',
    title: 'Synchronous IMAP sync (bypass pg-boss)',
    description:
      'Runs an IMAP sync of every enabled account in-process — a manual re-trigger after config changes. The recurring path is the pg-boss scheduler.',
    kind: 'ops',
    status: 'live',
    cost: 'imap',
    schedulable: false,
    script: 'scripts/sync-now.ts',
    cwd: 'server/web',
    notes: 'First scan of newly-discovered folders covers 12 months — can be slow.',
  },
  {
    slug: 'imap-folders',
    title: 'Probe IMAP folders (read-only)',
    description:
      'Prints every IMAP folder per account and marks which are in scope vs excluded. Diagnostic; writes nothing.',
    kind: 'ops',
    status: 'live',
    cost: 'imap',
    schedulable: false,
    script: 'scripts/imap-folders.ts',
    cwd: 'server/web',
  },
  {
    slug: 'pgboss-init',
    title: 'Materialise the pg-boss schema',
    description:
      'One boss.start() to deterministically create the pgboss schema before workers start. Wired into scripts/up.sh (dev) and the prod migrate gate; no-op once the schema exists.',
    kind: 'ops',
    status: 'live',
    cost: 'sql',
    schedulable: false,
    script: 'scripts/pgboss-init.ts',
    cwd: 'server/web',
  },

  {
    slug: 'extract-images-backfill',
    title: 'Extract embedded images from existing documents',
    description:
      'Re-fires node_ingested for documents ingested before embedded-image extraction existed, so their diagrams and screenshots become real image files under files/extracted-images/. Skips documents that already produced images.',
    kind: 'backfill',
    status: 'live',
    cost: 'llm',
    schedulable: false,
    script: 'scripts/extract-images-backfill.ts',
    cwd: 'server/web',
    applyFlag: '--go',
    extraFlags: ['--types=<list>', '--limit=<n>', '--rate=<seconds>'],
    notes:
      'The parent documents are FREE — the image pass sits ahead of the extractor’s already_extracted guard, so no text/summary/embedding work re-runs. Spend is one vision call per image KEPT (gated on dimensions, byte floor and duplicate collapse; capped at 30/doc). Dry-run by default: it prints the candidate count and an upper bound first. Start with --limit=20 --go and read the real yield off the extract_images trace steps.',
  },

  // ── Retired backfills (historical migrations — kept for reference) ───────
  {
    slug: 'relations-backfill',
    title: 'Backfill entity↔entity relations',
    description:
      'Re-fires node_ingested for nodes with mentions but zero relation edges, clearing data.summary to force a FULL re-extract through the relations-aware extractor.',
    kind: 'backfill',
    status: 'retired',
    cost: 'llm',
    schedulable: false,
    script: 'scripts/relations-backfill.ts',
    cwd: 'server/web',
    applyFlag: '--go',
    extraFlags: ['--types=<list>', '--since=<date>', '--limit=<n>', '--rate=<seconds>'],
    notes: 'EXPENSIVE — full re-extract (summary + embedding + facts + relations) per node.',
  },
  {
    slug: 'regenerate-digests',
    title: 'Repair clobbered conversation digests',
    description:
      'Re-summarises conversation-digest notes whose content was clobbered by an old extractor bug (detects via data.content IS NULL).',
    kind: 'backfill',
    status: 'retired',
    cost: 'llm',
    schedulable: false,
    script: 'scripts/regenerate-digests.ts',
    cwd: 'server/web',
    dryRunFlag: '--dry-run',
  },
  {
    slug: 'backfill-digest-embeddings',
    title: 'Embed conversation digests',
    description:
      'Embeds/re-embeds every conversation-digest note so digests are visible to find_window recall. Superseded: the summarizer embeds at insert time now.',
    kind: 'backfill',
    status: 'retired',
    cost: 'embedding',
    schedulable: false,
    script: 'scripts/backfill-digest-embeddings.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
    requiresEnv: ['ALLOWED_USER_ID'],
    notes: 'Same-model re-runs hit the embedding cache — effectively free.',
  },
  {
    slug: 'widen-content-hits',
    title: 'Bump agents’ content_hit_limit',
    description:
      'Raises existing agents’ content_hit_limit from the old default (3) to 5. Run once per env; only touches rows below the target.',
    kind: 'backfill',
    status: 'retired',
    cost: 'sql',
    schedulable: false,
    script: 'scripts/widen-content-hits.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
    extraFlags: ['--to=<n>'],
    requiresEnv: ['ALLOWED_USER_ID'],
  },
  {
    slug: 'backfill-email-salience',
    title: 'Heuristic bulk-email salience lowering',
    description:
      'Lowers retrieval salience on legacy unknown-delivery emails that look bulk by body heuristics. Superseded by classify-backfill (the precise IMAP-header version).',
    kind: 'backfill',
    status: 'retired',
    cost: 'sql',
    schedulable: false,
    script: 'scripts/backfill-email-salience.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
    extraFlags: ['--salience=<0..1>'],
    requiresEnv: ['ALLOWED_USER_ID'],
  },
  {
    slug: 'classify-backfill',
    title: 'Reclassify legacy unknown-delivery emails',
    description:
      'Re-fetches classification headers over IMAP for legacy unknown emails, re-runs classifyDelivery, and rewrites delivery_kind + node salience.',
    kind: 'backfill',
    status: 'retired',
    cost: 'imap',
    schedulable: false,
    script: 'scripts/classify-backfill.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
    extraFlags: ['--limit=<n>', '--account=<uuid>'],
    requiresEnv: ['ALLOWED_USER_ID', 'MANTLE_MASTER_KEY'],
    notes: 'Read-only against the mailbox (FETCH only, never marks read).',
  },
  {
    slug: 'purge-noncontact-emails',
    title: 'Purge emails from non-contacts',
    description:
      'DELETES already-ingested email nodes whose sender is not in the contacts allowlist (ContactGate cutover). Deletes are irreversible (FK cascade). Refuses to run if the contacts list is empty.',
    kind: 'backfill',
    status: 'retired',
    cost: 'sql',
    schedulable: false,
    script: 'scripts/purge-noncontact-emails.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
    extraFlags: ['--account=<uuid>', '--limit=<n>', '--purge-orphan-files'],
    requiresEnv: ['ALLOWED_USER_ID'],
    notes: 'DESTRUCTIVE.',
  },
  {
    slug: 'backfill-block-ids',
    title: 'Persist stable page block ids',
    description:
      'Walks every page and persists per-block ids (forcing what getPage otherwise does lazily on read). Phase-2b pages rollout backfill.',
    kind: 'backfill',
    status: 'retired',
    cost: 'sql',
    schedulable: false,
    script: 'scripts/backfill-block-ids.ts',
    cwd: 'server/web',
    dryRunFlag: '--dry',
  },
  {
    slug: 'backfill-conversation',
    title: 'Migrate Telegram history to unified stream',
    description:
      'One-time Phase-6 migration copying Telegram history into assistant_messages and re-keying old conversation-digest notes with data.agent_id.',
    kind: 'backfill',
    status: 'retired',
    cost: 'sql',
    schedulable: false,
    script: 'scripts/backfill-conversation.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
    requiresEnv: ['ALLOWED_USER_ID'],
  },
  {
    slug: 'merge-part-tables',
    title: 'Merge legacy "(part N/M)" tables',
    description:
      'Merges legacy part-split sibling tables back into one table (appends parts 2..M into part 1, renames, deletes the extras). Part-splitting is dead.',
    kind: 'backfill',
    status: 'retired',
    cost: 'sql',
    schedulable: false,
    script: 'scripts/merge-part-tables.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
    notes: 'Deletes the merged part tables — families with mismatched columns are skipped.',
  },
  {
    slug: 'retire-table-blobs',
    title: 'Null legacy table JSONB blobs',
    description:
      'For each file-backed table, verifies the workbook file against the registry, then nulls the legacy JSONB data/draft_data blobs (Tables-v2 release N+1).',
    kind: 'backfill',
    status: 'retired',
    cost: 'sql',
    schedulable: false,
    script: 'scripts/retire-table-blobs.ts',
    cwd: 'server/web',
    applyFlag: '--apply',
  },
  {
    slug: 'backfill-rfc-msg-id',
    title: 'Backfill emails.rfc_message_id',
    description:
      'Populates rfc_message_id on emails ingested before migration 0045 via header-only IMAP fetches. All post-0045 ingests populate the column at write time.',
    kind: 'backfill',
    status: 'retired',
    cost: 'imap',
    schedulable: false,
    script: 'src/backfill-rfc-message-id.ts',
    cwd: 'packages/email',
    notes: 'No flags; no dry-run. Idempotent (WHERE rfc_message_id IS NULL guard).',
  },

  // ── Supply chain ─────────────────────────────────────────────────────────
  {
    slug: 'deps-drift',
    title: 'Dependency drift report',
    description:
      'Compares every declared dependency range against the npm registry and reports what a plain `pnpm update` would take. A caret range is permission, not a mechanism: @openrouter/sdk sat at 1.0.0 for 46 releases while its manifest said ^1.0.0, because nothing resolved it and nothing said so. Report-only — never installs, never writes, never touches the DB.',
    kind: 'recurring',
    status: 'live',
    cost: 'io',
    schedulable: true,
    script: 'scripts/deps-drift.ts',
    cwd: 'server/web',
    readOnly: true,
    extraFlags: ['--majors', '--json'],
    notes:
      "Read-only, so there is no dry-run/apply split — running it IS the report, and it exits 0 even when drift is found (a non-zero exit would make the nightly sweep read as failing every time a dependency shipped a patch). --majors also lists versions outside the declared range, which are deliberate migrations rather than update fodder. Ran nightly for real as of the SWEEPS entry — before that this said schedulable:true while the sweep runner's own cost==='sql' check dropped it every time.",
  },
  {
    slug: 'pinned-model-drift',
    title: 'Pinned-model drift report',
    description:
      "Checks the models this brain's enabled agents and workers actually point at against each provider's live list, and reports pins that no longer exist plus newer versions of the same family. A pinned model is a decision, not a subscription — it was right the day it was chosen and nothing ages it. Complements models-drift, which asks whether our onboarding CATALOGUE is current and skips OpenRouter as un-driftable: true of a catalogue, false of a pin, since a delisted slug 404s at turn time. Report-only — never rewrites a model, which stays a cost decision.",
    kind: 'recurring',
    status: 'live',
    cost: 'io',
    schedulable: true,
    script: 'scripts/pinned-model-drift.ts',
    cwd: 'server/web',
    readOnly: true,
    extraFlags: ['--all', '--json'],
    requiresEnv: ['MANTLE_MASTER_KEY'],
    notes:
      'Lists each provider once (5-min cached) and invokes no model, so there is no token spend; the master key is needed only for providers whose list endpoint requires a key — OpenRouter, the common case, is keyless. Exits 0 even when drift is found. Everything it cannot see is reported as "not checked" with a reason, never as missing: a provider with no list API, an absent key, and a catalogue that does not cover the pin\'s modality all say nothing about whether the pin is valid. That distinction is the whole report — the naive version marked a healthy fleet as three models retired, because OpenRouter\'s /models enumerates chat only and its alias ids carry a leading tilde.',
  },
  {
    slug: 'pool-fit',
    title: 'Pool-fit report',
    description:
      'Checks every curated pool entry, enabled agent and enabled worker on an OpenRouter route against what that pool actually needs the model to DO, and reports the ones that cannot do it. The case it was built for: "Read images" and "Image generation" both accept image input, so an image GENERATOR passes every input-side check and then bills image-generation tokens and returns a picture where a text answer was expected. `architecture.output_modalities` is the half that separates them. Complements pinned-model-drift, which asks whether a model still EXISTS — this asks whether it belongs. Report-only: removing a curated entry is the owner\'s curation and repointing a live row is a cost decision.',
    kind: 'recurring',
    status: 'live',
    cost: 'io',
    schedulable: true,
    script: 'scripts/pool-fit.ts',
    cwd: 'server/web',
    readOnly: true,
    extraFlags: ['--all', '--json'],
    notes:
      "Keyless — OpenRouter's catalog is public, fetched once per run and cached 6h, and no model is invoked. Exits 0 even when a misfit is found. Only OpenRouter routes are subjects: the modality facts come from OpenRouter's catalog, so a direct-provider slug ('claude-opus-5') is out of scope rather than a finding, and the meta-routers (openrouter/auto*) are reported unchecked because their modalities are the union over everything they might route to. Same rule as the four write guards (`poolModelIssue`), so the report and the guards can never disagree.",
  },
  {
    slug: 'models-drift',
    title: 'Model catalogue drift report',
    description:
      "Compares each provider's live model list against our curated catalogue and reports both directions: models they serve that we don't offer, and entries we offer that they no longer serve. A static catalogue is a snapshot and nothing ages it — grok-4.5 shipped and our dropdown never mentioned it, which looks identical to the model not existing. Report-only: decrypts stored keys to authenticate the list calls, writes nothing.",
    kind: 'recurring',
    status: 'live',
    cost: 'io',
    schedulable: true,
    script: 'scripts/models-drift.ts',
    cwd: 'server/web',
    readOnly: true,
    extraFlags: ['--json'],
    requiresEnv: ['MANTLE_MASTER_KEY'],
    notes:
      'Reads api_keys and calls each provider once; no model is invoked, so there is no token spend. Skips OpenRouter, Copilot, local and custom — they build their lists from the provider and cannot drift by construction. Exits 0 even when drift is found: a provider shipping a model is not a failure.',
  },
];

export function getTask(slug: string): MaintenanceTask | undefined {
  return MAINTENANCE_TASKS.find((t) => t.slug === slug);
}

/** True when the given argv would make the task perform a live (mutating /
 * spending) run rather than a dry run. */
export function isLiveRun(task: MaintenanceTask, args: string[]): boolean {
  if (task.applyFlag) return args.includes(task.applyFlag);
  if (task.dryRunFlag) return !args.includes(task.dryRunFlag);
  return true; // no dry-run convention — invoking it IS the live run
}

/**
 * "Free" for scheduling purposes: costs nothing to run unattended.
 *
 * THE definition, exported so the cron's belt-and-braces re-check uses this
 * rather than its own copy. It had one, and the two drifted the moment this
 * widened from `sql` to `sql | io`: `deps-drift` shipped `schedulable: true`,
 * passed the registry assertion, and was then silently dropped by a stale
 * `cost !== 'sql'` in the sweep runner. It never ran once. A safety rule stated
 * in two places is a safety rule that will disagree with itself.
 */
export function isFreeCost(cost: TaskCost): boolean {
  return cost === 'sql' || cost === 'io';
}

/**
 * Cost-safety guardrail (see the standing "no runaway-LLM triggers" rule):
 * anything the cron worker may run unattended must be FREE and must not mutate
 * without an explicit opt-in. Throws at module load if the registry violates it.
 *
 * "Free" means `sql` or `io` — both are documented as costing nothing (see the
 * TaskCost note above); `imap` burns mailbox round-trips and `embedding`/`llm`
 * are real model spend, so those stay barred. The rule's intent has always been
 * about SPEND, and a local file read or a public-registry GET is not spend.
 *
 * "Must not mutate without opt-in" is satisfied two ways: a dry-run-by-default
 * task with an `applyFlag` the worker declines to pass, or a `readOnly` task
 * that has nothing to opt into. Widening to the latter is what lets a pure
 * report be scheduled — a report the operator has to remember to run is exactly
 * the failure it exists to catch.
 */
function assertRegistryInvariants(tasks: MaintenanceTask[]): void {
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.slug)) throw new Error(`maintenance registry: duplicate slug "${t.slug}"`);
    seen.add(t.slug);
    if (t.applyFlag && t.dryRunFlag)
      throw new Error(`maintenance registry: "${t.slug}" declares both applyFlag and dryRunFlag`);
    if (t.readOnly && t.applyFlag)
      throw new Error(
        `maintenance registry: "${t.slug}" is readOnly but declares an applyFlag — a read-only task has nothing to apply`,
      );
    if (t.schedulable) {
      if (!isFreeCost(t.cost))
        throw new Error(
          `maintenance registry: schedulable task "${t.slug}" must be free (cost 'sql' or 'io')`,
        );
      if (t.kind !== 'recurring' || t.status !== 'live')
        throw new Error(
          `maintenance registry: schedulable task "${t.slug}" must be live and recurring`,
        );
      if (!t.applyFlag && !t.readOnly)
        throw new Error(
          `maintenance registry: schedulable task "${t.slug}" must be dry-run-by-default (applyFlag) or readOnly`,
        );
    }
  }
}

assertRegistryInvariants(MAINTENANCE_TASKS);
