/**
 * Re-embed every stored vector with a chosen embedding model.
 *
 * Use case: you switched MANTLE_EMBEDDING_MODEL (or an agent's per-row
 * embedding_model setting). The text content didn't change, but the
 * vectors are now in the wrong space relative to what the responder
 * will use at query time. This script re-runs `embed()` over every
 * row in `nodes` / `facts` / `entities` and writes the new vectors
 * back.
 *
 * Skips the expensive chat-model extraction — we already have the
 * stored summary + fact content + entity name. Only the embedding
 * API gets called.
 *
 * As of the embedding-worker arc the real work lives in
 * `@mantle/embeddings#runReembed` so the workers form's "Rebuild
 * Index" button shares the exact same logic. This script is the CLI
 * surface around that helper — keeps the original ergonomics
 * (--dry-run, --tables=…, --types=…, --limit=…, --batch-size=…) but
 * doesn't duplicate the table-walk code.
 *
 * Usage:
 *   pnpm re-embed --dry-run
 *   pnpm re-embed
 *   pnpm re-embed --model=google/gemini-embedding-2-preview
 *   pnpm re-embed --tables=nodes
 *   pnpm re-embed --types=file,note --limit=200
 *   pnpm re-embed --batch-size=20
 *
 * Idempotency: re-running with the same model hits the embedding_cache
 * for every row and writes the same vectors back — free + safe.
 * Re-running with a different model burns embedding API calls.
 */

import postgres from 'postgres';
import {
  DEFAULT_EMBEDDING_MODEL,
  runReembed,
  type ReembedOpts,
} from '@mantle/embeddings';

const USER_ID = process.env.ALLOWED_USER_ID;
if (!USER_ID) {
  console.error('re-embed: ALLOWED_USER_ID must be set');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('re-embed: DATABASE_URL must be set');
  process.exit(1);
}

type ParsedArgs = ReembedOpts & {
  model: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    model: DEFAULT_EMBEDDING_MODEL,
    tables: ['nodes', 'facts', 'entities'],
    types: undefined,
    limit: undefined,
    batchSize: 50,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--model=')) {
      out.model = arg.slice('--model='.length).trim();
    } else if (arg.startsWith('--tables=')) {
      out.tables = arg
        .slice('--tables='.length)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is 'nodes' | 'facts' | 'entities' =>
          s === 'nodes' || s === 'facts' || s === 'entities',
        );
    } else if (arg.startsWith('--types=')) {
      out.types = arg
        .slice('--types='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isNaN(n)) out.limit = n;
    } else if (arg.startsWith('--batch-size=')) {
      const n = parseInt(arg.slice('--batch-size='.length), 10);
      if (!Number.isNaN(n) && n > 0) out.batchSize = n;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('[re-embed] settings:', {
    model: args.model,
    tables: args.tables ?? '(all)',
    types: args.types ?? '(all)',
    limit: args.limit ?? '(no cap)',
    batchSize: args.batchSize ?? 50,
    dryRun: args.dryRun ?? false,
  });
  if (args.model !== DEFAULT_EMBEDDING_MODEL) {
    console.log(
      `[re-embed] model differs from current default ('${DEFAULT_EMBEDDING_MODEL}'). ` +
        `Make sure your embedding AI worker (/settings/ai-workers/embedding) or ` +
        `MANTLE_EMBEDDING_MODEL points at '${args.model}' — otherwise retrieval will mix spaces.`,
    );
  }

  const result = await runReembed(USER_ID!, {
    ...args,
    onProgress: (event) => {
      if (event.kind === 'table_start') {
        console.log(
          `[re-embed] ${event.table}: ${event.rows} rows, ${event.chars} chars`,
        );
      } else if (event.kind === 'table_done') {
        console.log(
          `[re-embed] ${event.table}: wrote ${event.written} in ${event.durationMs}ms`,
        );
      }
    },
  });

  console.log(
    `[re-embed] ${result.dryRun ? 'would touch' : 'touched'} ${result.totalRows} rows ` +
      `(${result.totalChars} chars · ~$${result.estimatedUsdMax.toFixed(4)} if cache cold; ` +
      `free if cache warm). Written: ${result.totalWritten}. ` +
      `Total: ${result.durationMs}ms.`,
  );

  // Close the postgres pool drizzle keeps open.
  const pool = postgres(DATABASE_URL!, { max: 1 });
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('[re-embed] fatal:', err);
  process.exit(1);
});
