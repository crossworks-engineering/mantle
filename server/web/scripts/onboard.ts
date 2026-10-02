/**
 * The terminal onboarding wizard: create the owner and finish first-run setup
 * on a brain with no owner UI anywhere (a headless box driven over MCP).
 *
 * Runs INSIDE the web container; on a box, use the wrapper:
 *
 *   scripts/onboard.sh                       # interactive, every prompt has a default
 *   scripts/onboard.sh --yes --email a@b.c --password-file pw --key-file key
 *
 * Here, directly (dev, or `docker compose exec web ...`):
 *
 *   pnpm -C server/web onboard [flags]
 *
 * Shell access to the box proves ownership, so the setup code is not asked
 * for. The steps are the wizard's own (lib/onboarding-steps.ts), so a run
 * here and a run in a Jackdaw client cannot disagree, and either can finish
 * what the other started: progress is `preferences.onboardingStep`.
 *
 * Secrets (the password, the OpenRouter key) are typed hidden, or read from
 * stdin with --secrets-stdin as `password=...` and `openrouter_key=...`
 * lines. Never as arguments: argv lands in shell history and in `ps`.
 */
import { fileURLToPath } from 'node:url';
import { envDynamic } from '@mantle/config';
import { db, sql, countUsers } from '@mantle/db';
import { ASSISTANT_MODEL_CHOICES, WORKER_MODEL_CHOICES } from '@mantle/client-types/model-choices';
import { PURPOSE_ARCHETYPES } from '@mantle/content-core/onboarding-questions';
import { DEFAULT_PERSONA_NAMES, PERSONA_PRESETS } from '@mantle/content-core/persona-bank';
import { createFirstOwner } from '../lib/auth/first-owner';
import {
  finishOnboarding,
  onboardingState,
  provision,
  runInfraChecks,
  runSanityChecks,
  saveEmbedding,
  saveKey,
  saveModels,
  savePersona,
  saveProfile,
  savePurpose,
  saveStep,
  testKey,
  type SanityCheck,
} from '../lib/onboarding-steps';

// ── the step order: the wizard's own keys, so a GUI client resumes where we stop
export const STEPS = [
  'profile',
  'openrouter',
  'models',
  'voice',
  'embedding',
  'provision',
  'sanity',
  'purpose',
  'personality',
  'telegram',
  'done',
] as const;
export type StepKey = (typeof STEPS)[number];

/** Where a run resumes: the saved step, or the start for anything unknown. */
export function resumeIndex(saved: string | undefined): number {
  const i = STEPS.indexOf(saved as StepKey);
  return i < 0 ? 0 : i;
}

// ── arguments ────────────────────────────────────────────────────────────────

export type Options = {
  yes: boolean;
  secretsStdin: boolean;
  email?: string;
  name?: string;
  timezone?: string;
  locale?: string;
  assistantModel?: string;
  workerModel?: string;
  embeddingModel?: 'large' | 'small';
  archetype?: string;
  purpose?: string;
  persona?: string;
  gender?: 'female' | 'male';
  assistantName?: string;
  help: boolean;
};

const VALUE_FLAGS: Record<string, keyof Options> = {
  '--email': 'email',
  '--name': 'name',
  '--timezone': 'timezone',
  '--locale': 'locale',
  '--assistant-model': 'assistantModel',
  '--worker-model': 'workerModel',
  '--embedding-model': 'embeddingModel',
  '--archetype': 'archetype',
  '--purpose': 'purpose',
  '--persona': 'persona',
  '--gender': 'gender',
  '--assistant-name': 'assistantName',
};

/** Flags that would put a secret in argv. Refused by name, with the way to do it. */
const SECRET_FLAGS = ['--password', '--key', '--openrouter-key', '--api-key', '--setup-code'];

export function parseArgs(argv: string[]): Options {
  const o: Options = { yes: false, secretsStdin: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const [flag, inline] = raw.includes('=')
      ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)]
      : [raw, undefined];
    if (SECRET_FLAGS.includes(flag)) {
      throw new Error(
        `${flag} is refused: secrets never go on the command line (shell history, ps). ` +
          'Type them at the prompt, or pipe password=... and openrouter_key=... lines with --secrets-stdin ' +
          '(scripts/onboard.sh --password-file / --key-file does that for you).',
      );
    }
    if (flag === '--yes' || flag === '-y') o.yes = true;
    else if (flag === '--secrets-stdin') o.secretsStdin = true;
    else if (flag === '--help' || flag === '-h') o.help = true;
    else if (flag in VALUE_FLAGS) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '') throw new Error(`${flag} needs a value.`);
      (o as Record<string, unknown>)[VALUE_FLAGS[flag]!] = value;
    } else {
      throw new Error(`Unknown argument: ${raw} (try --help)`);
    }
  }
  if (o.embeddingModel && o.embeddingModel !== 'large' && o.embeddingModel !== 'small') {
    throw new Error('--embedding-model is large or small.');
  }
  if (o.gender && o.gender !== 'female' && o.gender !== 'male') {
    throw new Error('--gender is female or male.');
  }
  if (o.persona && !PERSONA_PRESETS.some((p) => p.key === o.persona)) {
    throw new Error(`--persona is one of: ${PERSONA_PRESETS.map((p) => p.key).join(', ')}.`);
  }
  // Stdin carries the secrets, so it cannot also answer prompts.
  if (o.secretsStdin) o.yes = true;
  return o;
}

/** `password=...` / `openrouter_key=...` lines. Values are taken verbatim
 *  after the first '=', minus a trailing CR; unknown keys are refused so a
 *  typo cannot silently drop a secret. */
export function parseSecrets(text: string): { password?: string; openrouterKey?: string } {
  const out: { password?: string; openrouterKey?: string } = {};
  for (const line of text.split('\n')) {
    const l = line.replace(/\r$/, '');
    if (!l.trim()) continue;
    const eq = l.indexOf('=');
    const key = eq < 0 ? l.trim() : l.slice(0, eq).trim();
    const value = eq < 0 ? '' : l.slice(eq + 1);
    if (key === 'password') out.password = value;
    else if (key === 'openrouter_key') out.openrouterKey = value;
    else
      throw new Error(`Unknown secret "${key}" on stdin (expected password= or openrouter_key=).`);
  }
  return out;
}

const HELP = `Terminal onboarding: create the owner and finish setup on a headless brain.

  scripts/onboard.sh [flags]            on a box (runs this in the web container)
  pnpm -C server/web onboard [flags]    in a checkout

Every prompt has a default; press Enter to take it. A run stops cleanly at
any point and the next run (or any Jackdaw client) picks up where it left off.

Flags (non-secret values only):
  -y, --yes                 Take every default, never prompt
  --secrets-stdin           Read password=... and openrouter_key=... lines from
                            stdin (implies --yes). Secrets never go in argv.
  --email <addr>            Owner email (only while no account exists)
  --name <text>             What the assistant calls you
  --timezone <tz>           IANA timezone, default: this machine's
  --locale <tag>            Default en-GB
  --assistant-model <id>    Default: the recommended assistant model
  --worker-model <id>       Default: the recommended worker model
  --embedding-model <m>     large (default) or small
  --archetype <key>         ${PURPOSE_ARCHETYPES.map((a) => a.key).join(', ')}
  --purpose <line>          What this brain is for, one line
  --persona <key>           ${PERSONA_PRESETS.map((p) => p.key).join(', ')} (default warm)
  --gender <g>              female (default) or male
  --assistant-name <name>   Default by gender
`;

// ── terminal io ──────────────────────────────────────────────────────────────

const color = process.stdout.isTTY && !envDynamic('NO_COLOR');
const paint = (code: string, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
const ok = (s: string) => console.log(`  ${paint('32', '✓')} ${s}`);
const bad = (s: string) => console.log(`  ${paint('31', '✗')} ${s}`);
const inf = (s: string) => console.log(`  ${paint('34', '•')} ${s}`);
const hd = (s: string) => console.log(`\n${paint('1;36', `━━ ${s}`)}`);

/** One line from the terminal, echoed or hidden. Raw mode, so a hidden value
 *  never reaches the screen or a scrollback. Ctrl-C exits (progress so far is
 *  saved; the next run resumes). */
function readLine(prompt: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          finish();
          console.log('Stopped. Progress so far is saved; run this again to pick up.');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            if (!hidden) process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          buf += ch;
          if (!hidden) process.stdout.write(ch);
        }
      }
    };
    stdin.on('data', onData);
  });
}

type Io = {
  ask(label: string, def: string): Promise<string>;
  secret(label: string): Promise<string>;
  confirm(label: string, def: boolean): Promise<boolean>;
};

function terminalIo(): Io {
  return {
    async ask(label, def) {
      const a = (
        await readLine(`  ${paint('1', label)}${def ? paint('2', ` [${def}]`) : ''} `, false)
      ).trim();
      return a || def;
    },
    secret(label) {
      return readLine(`  ${paint('1', label)} `, true);
    },
    async confirm(label, def) {
      const a = (
        await readLine(`  ${paint('1', label)} ${def ? '[Y/n]' : '[y/N]'} `, false)
      ).trim();
      return a ? /^y/i.test(a) : def;
    },
  };
}

/** --yes: every question takes its default; a secret comes from stdin or is empty. */
function defaultsIo(secrets: { password?: string; openrouterKey?: string }): Io {
  return {
    ask: async (_label, def) => def,
    secret: async (label) =>
      /password/i.test(label) ? (secrets.password ?? '') : (secrets.openrouterKey ?? ''),
    confirm: async (_label, def) => def,
  };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function printChecks(checks: SanityCheck[]): boolean {
  for (const c of checks) (c.ok ? ok : bad)(`${c.label}: ${c.detail}`);
  return checks.every((c) => c.ok);
}

// ── the run ──────────────────────────────────────────────────────────────────

async function ownerRow(): Promise<{ id: string; email: string } | null> {
  const rows = (await db.execute(
    sql`select id, email from auth.users where is_owner order by created_at limit 1`,
  )) as unknown as { id: string; email: string }[];
  return rows[0] ?? null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function ensureOwner(o: Options, io: Io): Promise<{ id: string; email: string }> {
  hd('Owner');
  if ((await countUsers()) > 0) {
    const owner = await ownerRow();
    if (!owner)
      throw new Error('This brain has logins but no owner account. Nothing to onboard here.');
    ok(`Owner account exists: ${owner.email}`);
    return owner;
  }
  inf('No account yet. This creates the owner: the identity every brain item belongs to.');
  let email = (o.email ?? '').trim();
  while (!EMAIL_RE.test(email)) {
    if (o.yes) throw new Error('No owner yet: pass --email <addr> (and the password on stdin).');
    email = (await io.ask('Owner email:', '')).trim();
    if (!EMAIL_RE.test(email)) bad('That is not an email address.');
  }
  let password: string;
  for (;;) {
    password = await io.secret('Password (8+ characters, hidden):');
    if (password.length < 8) {
      if (o.yes) throw new Error('No owner yet: send password=... (8+ characters) on stdin.');
      bad('At least 8 characters.');
      continue;
    }
    if (o.yes) break;
    const again = await io.secret('Password again:');
    if (again === password) break;
    bad('The two did not match. Again.');
  }
  const created = await createFirstOwner(email, password);
  if (!created.ok) throw new Error('An account appeared while this ran. Run onboard again.');
  ok(`Owner created: ${created.email}`);
  return { id: created.id, email: created.email };
}

export async function run(o: Options, io: Io): Promise<number> {
  hd('Stack');
  const infraOk = printChecks(await runInfraChecks(null));
  if (!infraOk && !(await io.confirm('Some checks failed. Continue anyway?', false))) {
    inf('Fix what is flagged (scripts/install.sh --check), then run this again.');
    return 1;
  }

  const owner = await ensureOwner(o, io);
  const state = await onboardingState(owner.id);
  if (state.onboarded) {
    ok('This brain is already onboarded. Change anything later in a Jackdaw client.');
    return 0;
  }
  let at = resumeIndex(state.step);
  if (at > 0) inf(`Picking up at "${STEPS[at]}".`);
  const advance = async (to: StepKey) => {
    at = STEPS.indexOf(to);
    await saveStep(owner.id, to);
  };
  const reached = (k: StepKey) => at <= STEPS.indexOf(k);
  let haveKey = state.savedServices.includes('openrouter');

  if (reached('profile')) {
    hd('Profile');
    const displayName = await io.ask(
      'What should the assistant call you? (optional)',
      o.name ?? '',
    );
    const timezone = await io.ask(
      'Timezone:',
      o.timezone ??
        (state.timezone && state.timezone !== 'UTC'
          ? state.timezone
          : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    );
    const locale = await io.ask('Locale:', o.locale ?? state.locale ?? 'en-GB');
    const r = await saveProfile(owner.id, { timezone, locale, displayName });
    if (!r.ok) throw new Error(r.error ?? 'Could not save the profile.');
    ok('Profile saved');
    await advance('openrouter');
  }

  if (reached('openrouter')) {
    hd('OpenRouter key');
    inf('One key runs chat, models, voice and memory search. Get one at openrouter.ai/keys.');
    for (;;) {
      const typed = (
        await io.secret(
          haveKey
            ? 'OpenRouter key (hidden; Enter keeps the saved one):'
            : 'OpenRouter key (hidden; Enter skips):',
        )
      ).trim();
      if (!typed && haveKey) {
        const t = await testKey(owner.id, 'openrouter');
        (t.ok ? ok : bad)(`Saved key: ${t.message}`);
        if (t.ok || o.yes) break;
        continue;
      }
      if (!typed) {
        inf(
          'Skipped. Without a key the brain cannot be set up yet; add one later and run this again.',
        );
        return o.yes ? 1 : 0;
      }
      const r = await saveKey(owner.id, 'openrouter', typed);
      (r.test.ok ? ok : bad)(r.test.message);
      haveKey = r.saved;
      if (r.test.ok) break;
      if (o.yes) return 1;
    }
    await advance('models');
  }

  if (reached('models')) {
    hd('Models');
    const defA =
      ASSISTANT_MODEL_CHOICES.find((m) => m.recommended)?.id ?? ASSISTANT_MODEL_CHOICES[0]!.id;
    const defW = WORKER_MODEL_CHOICES.find((m) => m.recommended)?.id ?? WORKER_MODEL_CHOICES[0]!.id;
    if (!o.yes) {
      inf(`Assistant models: ${ASSISTANT_MODEL_CHOICES.map((m) => m.id).join(', ')}`);
      inf(`Worker models: ${WORKER_MODEL_CHOICES.map((m) => m.id).join(', ')}`);
    }
    for (;;) {
      const assistantModel = await io.ask('Assistant model:', o.assistantModel ?? defA);
      const workerModel = await io.ask('Worker model:', o.workerModel ?? defW);
      const r = await saveModels(owner.id, { assistantModel, workerModel, route: 'openrouter' });
      if (r.ok) {
        ok(`Assistant ${r.assistantModel}, workers ${r.workerModel}`);
        break;
      }
      bad(r.message);
      if (o.yes) return 1;
    }
    // Voice (a separate xAI key) is optional and set later in a client.
    await advance('embedding');
  }

  if (reached('embedding')) {
    hd('Memory search');
    const choice = await io.ask('Embedding model (large or small):', o.embeddingModel ?? 'large');
    const model = choice === 'small' ? 'text-embedding-3-small' : 'text-embedding-3-large';
    const r = await saveEmbedding(owner.id, { provider: 'openrouter', model });
    (r.configured ? ok : bad)(r.test.message);
    if (!r.configured) inf('Memory search can be set later in a Jackdaw client (Settings).');
    await advance('provision');
  }

  if (reached('provision')) {
    hd('Set up');
    const r = await provision(owner.id);
    ok(`Provisioned${r.assistantAgentId ? ': your assistant is ready' : ''}`);
    await advance('sanity');
  }

  if (reached('sanity')) {
    hd('Check');
    printChecks(await runSanityChecks(owner.id));
    await advance('purpose');
  }

  if (reached('purpose')) {
    hd('Purpose');
    if (!o.yes) inf(`Specialities: ${PURPOSE_ARCHETYPES.map((a) => a.key).join(', ')}`);
    for (;;) {
      const archetype = await io.ask('Speciality:', o.archetype ?? 'personal');
      const purpose = await io.ask(
        'What is this brain for? (one line)',
        o.purpose ?? 'My second brain: notes, journal, tasks, people and memory.',
      );
      const r = await savePurpose(owner.id, archetype, purpose);
      if (r.ok) {
        ok('Purpose saved');
        break;
      }
      bad(r.error ?? 'Could not save.');
      if (o.yes) return 1;
    }
    await advance('personality');
  }

  if (reached('personality')) {
    hd('Personality');
    if (!o.yes) for (const p of PERSONA_PRESETS) inf(`${p.key}: ${p.blurb}`);
    const presetKey = await io.ask('Personality:', o.persona ?? 'warm');
    const preset = PERSONA_PRESETS.find((p) => p.key === presetKey) ?? PERSONA_PRESETS[0]!;
    const g = await io.ask('Voice (female or male):', o.gender ?? 'female');
    const gender = g === 'male' ? 'male' : 'female';
    const assistantName = await io.ask(
      'Assistant name:',
      o.assistantName ?? DEFAULT_PERSONA_NAMES[gender],
    );
    const r = await savePersona(owner.id, {
      presetKey: preset.key,
      assistantName,
      gender,
      temperature: preset.temperature,
    });
    (r.ok ? ok : bad)(r.ok ? `${assistantName}, ${preset.label}` : (r.error ?? 'Could not save.'));
    await advance('telegram');
  }

  if (reached('telegram')) {
    inf('Telegram: pair a bot later in a Jackdaw client.');
    await advance('done');
  }

  hd('Finish');
  const f = await finishOnboarding(owner.id);
  if (!f.ok) {
    bad(f.error ?? 'Could not finish.');
    return 1;
  }
  ok('Onboarded. Sign in from any Jackdaw client, or connect an MCP client.');
  return 0;
}

async function main(): Promise<number> {
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  let io: Io;
  if (o.secretsStdin) {
    io = defaultsIo(parseSecrets(await readAllStdin()));
  } else if (o.yes) {
    io = defaultsIo({});
  } else if (process.stdin.isTTY) {
    io = terminalIo();
  } else {
    console.error('No terminal to prompt on. Use --yes, with --secrets-stdin for the secrets.');
    return 2;
  }
  return run(o, io);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`\nOnboarding stopped: ${(err as Error).message}`);
      console.error('Progress so far is saved; run this again to pick up.');
      process.exit(1);
    });
}
