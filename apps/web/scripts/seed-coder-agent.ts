/**
 * Seed a dedicated "coder" agent — a power-user operator with FULL terminal
 * access (run_terminal) + file/search tools, on a smart model (Opus 4.7).
 *
 * Reached via Saskia delegation ("ask the coder to restart the web server")
 * — this script also adds `coder` to the responder's memory_config.delegate_to
 * so that path works immediately. You can also bump its role/priority to talk
 * to it directly on /assistant.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:coder
 *
 * Idempotent: upserts the agent by (owner, slug='coder') and only appends to
 * the responder's delegate_to if missing.
 *
 * SAFETY: the terminal tool is unrestricted by design. It's granted here ONLY
 * to this dedicated agent, NOT to the responder/assistant that ingest untrusted
 * email/Telegram — keep it that way (prompt-injection footgun otherwise).
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, agents, apiKeys, skills, type AgentMemoryConfig } from '@mantle/db';
import { seedBuiltinTools } from '@mantle/tools';

const USER_ID = process.env.ALLOWED_USER_ID;
if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

const MODEL = process.env.CODER_MODEL || 'anthropic/claude-opus-4.7';

const TOOL_SLUGS = [
  'run_terminal',
  'file_create',
  'file_read',
  'file_get',
  'file_list',
  'folder_list',
  'folder_get_by_path',
  'search_nodes',
  'node_read',
  'tree_list',
];

const SYSTEM_PROMPT = `You are "Coder" — a senior engineer operating Jason's self-hosted Mantle server.

You have a real terminal (run_terminal) and file tools. You can run git, pnpm, builds, database migrations, inspect and edit code, and restart services. Commands run via bash in the configured working directory (MANTLE_TERMINAL_CWD, the mantle repo) unless you pass an explicit cwd.

How you work:
- Do what the operator asks directly — they are the sole, technical user. Don't refuse safe requests or add approval friction.
- Show your work: state the command you're about to run and why, run it, then read the output and react.
- Verify before declaring done — typecheck / run tests / check exit codes where it makes sense.
- For risky or destructive actions, say plainly what it will do, then execute it (you're trusted), and report the result.
- Keep replies tight: what you ran, what came back, what's next.`;

const SKILL_SLUG = 'mantle-ops';
const MANTLE_OPS_INSTRUCTIONS = `# Mantle ops — operating manual

You operate **Mantle**, a single-user self-hosted "AI-queryable life tree"
(Next.js 15 + one Postgres + MinIO) from the repo at \`$MANTLE_TERMINAL_CWD\`
(default ~/Projects/mantle). You have a real terminal (\`run_terminal\`) and file tools.

## Read the source of truth before non-trivial work
The authoritative knowledge is in the repo — read it with the terminal, don't guess:
- \`README.md\` — setup, scripts, layout.
- \`docs/architecture.md\` — the whole system (processes, the \`nodes\` table, pipelines, MCP).
- \`docs/memory.md\` — the 6-layer brain.
- \`docs/observability.md\` + \`docs/data-flow-tracing.md\` — tracing + verifying ingest (\`scripts/trace-node.sh <node-id>\`).
- \`docs/ai-workers.md\`, \`docs/files.md\`, \`docs/file-ingestion.md\`, \`docs/heartbeats.md\` — subsystems.
e.g. \`cat docs/architecture.md\`, \`ls docs\`, \`git -C . log --oneline -20\`.

## Workflow conventions (important)
- Work in a **git worktree**, then **ff-merge into \`main\`**; **push only when asked**. The dev stack runs from \`main\`.
- **Verify before declaring done**: \`pnpm typecheck\` and \`pnpm test\`; for DB changes \`pnpm db:migrate\`.
- After editing any \`packages/*\` or adding a dependency, the running stack (\`tsx --watch\`) won't reload it — **restart \`apps/agent\`** (and the relevant worker) for changes to take effect.
- A new migration = a \`.sql\` file in \`packages/db/migrations/\` **plus** an entry in \`meta/_journal.json\`, or Drizzle silently skips it.
- Postgres-first: prefer a table / SQL over new infrastructure.

## Useful commands
- \`pnpm up\` (infra + dev), \`pnpm dev\`, \`pnpm typecheck\`, \`pnpm test\`, \`pnpm db:migrate\`, \`pnpm db:studio\`.
- Read-only DB: \`docker exec mantle_pg psql -U postgres -d postgres -c "<sql>"\`.
- Trace one node end-to-end: \`scripts/trace-node.sh <node-id>\`.

## Discipline
State the command and why, run it, read stdout/stderr/exit code, then react. Verify your work.
This is a live single-user server — be precise; narrate destructive actions, then do what the operator asked.`;

async function resolveOpenRouterKeyId(): Promise<string> {
  const rows = await db
    .select({ id: apiKeys.id, label: apiKeys.label })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, USER_ID!), eq(apiKeys.service, 'openrouter')));
  if (rows.length === 0) {
    throw new Error("No 'openrouter' API key found. Add one at /settings/keys first.");
  }
  const preferred = rows.find((r) => r.label === 'default') ?? rows[0]!;
  return preferred.id;
}

async function main() {
  // Make sure the builtin tool rows (incl. run_terminal) exist for this owner
  // so the grant resolves even before the next agent boot.
  const seeded = await seedBuiltinTools(USER_ID!);
  console.log(`[coder] tools seeded: +${seeded.inserted} / ~${seeded.updated}`);

  const apiKeyId = await resolveOpenRouterKeyId();

  // Upsert the ops skill (knowledge) — kept separate from the agent's persona.
  const skillDesc = 'How the Mantle system works + the operating workflow for the coder agent.';
  await db
    .insert(skills)
    .values({
      ownerId: USER_ID!,
      slug: SKILL_SLUG,
      name: 'Mantle ops',
      description: skillDesc,
      instructions: MANTLE_OPS_INSTRUCTIONS,
      toolSlugs: [],
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [skills.ownerId, skills.slug],
      set: { name: 'Mantle ops', description: skillDesc, instructions: MANTLE_OPS_INSTRUCTIONS, enabled: true, updatedAt: new Date() },
    });
  console.log(`[coder] skill upserted: ${SKILL_SLUG}`);

  const values = {
    ownerId: USER_ID!,
    slug: 'coder',
    name: 'Coder',
    description: 'Power-user engineer/operator with full terminal + file access.',
    role: 'custom' as const,
    model: MODEL,
    apiKeyId,
    systemPrompt: SYSTEM_PROMPT,
    toolSlugs: TOOL_SLUGS,
    skillSlugs: [SKILL_SLUG],
    params: { temperature: 0.2 },
    priority: 100,
    enabled: true,
  };

  await db
    .insert(agents)
    .values(values)
    .onConflictDoUpdate({
      target: [agents.ownerId, agents.slug],
      set: {
        name: values.name,
        description: values.description,
        model: values.model,
        apiKeyId: values.apiKeyId,
        systemPrompt: values.systemPrompt,
        toolSlugs: values.toolSlugs,
        skillSlugs: values.skillSlugs,
        enabled: true,
        updatedAt: new Date(),
      },
    });
  console.log(`[coder] agent upserted (model=${MODEL}, ${TOOL_SLUGS.length} tools incl. run_terminal)`);

  // Wire delegation: add 'coder' to the top responder's delegate_to so
  // "ask the coder to ..." works via invoke_agent.
  const [responder] = await db
    .select({ id: agents.id, slug: agents.slug, memoryConfig: agents.memoryConfig })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.role, 'responder'), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority))
    .limit(1);
  if (responder) {
    const mc = (responder.memoryConfig ?? {}) as AgentMemoryConfig & { delegate_to?: string[] };
    const current = Array.isArray(mc.delegate_to) ? mc.delegate_to : [];
    if (!current.includes('coder')) {
      await db
        .update(agents)
        .set({ memoryConfig: { ...mc, delegate_to: [...current, 'coder'] }, updatedAt: new Date() })
        .where(eq(agents.id, responder.id));
      console.log(`[coder] added 'coder' to ${responder.slug}.delegate_to → delegation enabled`);
    } else {
      console.log(`[coder] ${responder.slug} already delegates to 'coder'`);
    }
  } else {
    console.log("[coder] no enabled responder found — skip delegation wiring (talk to 'coder' directly)");
  }

  console.log('[coder] done. Restart apps/agent so run_terminal is registered in the running process.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[coder] failed:', err);
  process.exit(1);
});
