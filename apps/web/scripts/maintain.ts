/**
 * `pnpm maintain` — the general maintenance runner. One terminal entrypoint
 * over the maintenance task registry (lib/maintenance/registry.ts), replacing
 * the sprawl of per-script pnpm aliases with a uniform surface:
 *
 *   pnpm maintain                      # list live tasks, grouped by kind
 *   pnpm maintain list --all           # include retired backfills
 *   pnpm maintain info <slug>          # full detail: flags, env, cost, notes
 *   pnpm maintain <slug> [flags…]      # run it (flags pass through)
 *   pnpm maintain <slug> --apply       # generic --apply → the script's own
 *                                      # live flag (e.g. entities-dedupe --go)
 *
 * Safety rails (see docs/maintenance-runner.md):
 *   - live runs of model-spending tasks (cost llm/embedding) need --yes
 *   - retired backfills need --force-retired
 *   - missing requiresEnv vars fail fast before the script spawns
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  MAINTENANCE_TASKS,
  getTask,
  isLiveRun,
  type MaintenanceTask,
  type TaskKind,
} from '../lib/maintenance/registry';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const KIND_LABELS: Record<TaskKind, string> = {
  recurring: 'Recurring hygiene',
  remedy: 'Remedies (run when a monitor flags drift)',
  ops: 'Ops (deliberate events)',
  backfill: 'Retired backfills (historical — need --force-retired)',
};

function defaultMode(t: MaintenanceTask): string {
  if (t.applyFlag) return `dry-run (${t.applyFlag} applies)`;
  if (t.dryRunFlag) return `LIVE (${t.dryRunFlag} previews)`;
  return 'LIVE on invoke';
}

function list(includeRetired: boolean): void {
  const kinds: TaskKind[] = ['recurring', 'remedy', 'ops', 'backfill'];
  for (const kind of kinds) {
    const tasks = MAINTENANCE_TASKS.filter(
      (t) => t.kind === kind && (includeRetired || t.status === 'live'),
    );
    if (tasks.length === 0) continue;
    console.log(`\n${KIND_LABELS[kind]}`);
    for (const t of tasks) {
      const spend = t.cost === 'llm' || t.cost === 'embedding' ? ` 💸${t.cost}` : '';
      console.log(`  ${t.slug.padEnd(28)} ${t.title}${spend}`);
      console.log(`  ${''.padEnd(28)} default: ${defaultMode(t)}`);
    }
  }
  console.log(
    includeRetired
      ? '\nRun one: pnpm maintain <slug> [flags…]   Detail: pnpm maintain info <slug>'
      : '\nRun one: pnpm maintain <slug> [flags…]   Detail: pnpm maintain info <slug>   All incl. retired: pnpm maintain list --all',
  );
}

function info(slug: string): void {
  const t = getTask(slug);
  if (!t) return unknownSlug(slug);
  console.log(`${t.slug} — ${t.title}`);
  console.log(`  kind: ${t.kind}   status: ${t.status}   cost: ${t.cost}`);
  console.log(`  script: ${t.cwd}/${t.script}`);
  console.log(`  default: ${defaultMode(t)}`);
  if (t.positionalArgs?.length) console.log(`  positional args: ${t.positionalArgs.join(' ')}`);
  if (t.extraFlags?.length) console.log(`  flags: ${t.extraFlags.join('  ')}`);
  if (t.requiresEnv?.length) console.log(`  requires env: ${t.requiresEnv.join(', ')}`);
  console.log(`  schedulable (phase-2 cron): ${t.schedulable ? 'yes' : 'no'}`);
  console.log(`\n  ${t.description}`);
  if (t.notes) console.log(`\n  ⚠ ${t.notes}`);
}

function unknownSlug(slug: string): void {
  console.error(`maintain: unknown task "${slug}". Run \`pnpm maintain list --all\` to see slugs.`);
  process.exit(1);
}

function run(slug: string, rawArgs: string[]): void {
  const t = getTask(slug);
  if (!t) return unknownSlug(slug);

  let args = [...rawArgs];

  // Consume runner-level flags before pass-through.
  const yes = args.includes('--yes');
  const forceRetired = args.includes('--force-retired');
  args = args.filter((a) => a !== '--yes' && a !== '--force-retired');

  // Generic --apply → the script's own live flag.
  if (args.includes('--apply') && t.applyFlag && t.applyFlag !== '--apply') {
    args = args.map((a) => (a === '--apply' ? t.applyFlag! : a));
  } else if (args.includes('--apply') && !t.applyFlag) {
    console.error(
      t.dryRunFlag
        ? `maintain: ${slug} is live by default (${t.dryRunFlag} previews) — drop --apply.`
        : `maintain: ${slug} has no dry-run mode; it runs live on invoke — drop --apply.`,
    );
    process.exit(1);
  }

  if (t.status === 'retired' && !forceRetired) {
    console.error(
      `maintain: "${slug}" is a retired backfill (${t.title}). It's kept for reference, not casual re-runs.\n` +
        `         If you're sure it applies to this environment, add --force-retired.`,
    );
    process.exit(1);
  }

  const live = isLiveRun(t, args);
  if (live && (t.cost === 'llm' || t.cost === 'embedding') && !yes) {
    console.error(
      `maintain: a live run of "${slug}" spends real ${t.cost} calls. Re-run with --yes to confirm.\n` +
        `         (Preview first: ${t.applyFlag ? `omit ${t.applyFlag}` : `pass ${t.dryRunFlag ?? '(no dry-run mode)'}`}.)`,
    );
    process.exit(1);
  }

  const missingEnv = (t.requiresEnv ?? []).filter((k) => !process.env[k]);
  if (missingEnv.length) {
    console.error(`maintain: "${slug}" needs env var(s) not set: ${missingEnv.join(', ')}`);
    process.exit(1);
  }

  const cwd = join(REPO_ROOT, t.cwd);
  console.log(
    `maintain: ${slug} (${live ? 'LIVE' : 'dry-run'}) → tsx ${t.script}${args.length ? ' ' + args.join(' ') : ''}`,
  );
  const res = spawnSync('pnpm', ['exec', 'tsx', t.script, ...args], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'list') {
  list(rest.includes('--all'));
} else if (cmd === 'info') {
  if (!rest[0]) {
    console.error('maintain: usage — pnpm maintain info <slug>');
    process.exit(1);
  }
  info(rest[0]);
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(
    'pnpm maintain [list [--all] | info <slug> | <slug> [flags…]]\n' +
      'Runner flags: --apply (generic live switch)  --yes (confirm model spend)  --force-retired',
  );
} else {
  run(cmd, rest);
}
