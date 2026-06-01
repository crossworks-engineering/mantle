/**
 * Integrity-probe fixtures — the synthetic content each probe inserts.
 *
 * Every builder reuses the *canonical* create path for its type (the same
 * `createNote` / `upsertFile` / … the real UI calls), so the probe exercises
 * the production write path, not a re-implementation. Each fixture is scoped
 * by two tags — `integrity-probe` (broad) and `integrity-probe-<run>` (this
 * run) — so cleanup is a tag sweep.
 *
 * Content is deliberately distinctive (invented proper nouns like
 * "Vorthelm Dynamics", "Quintus Bramblewick") so the entity reconciler creates
 * fresh entities rather than merging probe data into the real graph. The
 * post-run cleanup removes them regardless.
 *
 * File-type fixtures read real bytes from `fixtures/files/` (checked in
 * separately). A fixture whose file is absent reports `missing` — not a
 * failure — so the suite runs before the sample files are in place.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  createNote,
  updateNote,
  createTodo,
  updateTodo,
  createEvent,
  updateEvent,
  createContact,
  updateContact,
  createPage,
  commitPage,
} from '@mantle/content';
import { ensureFilesRootBranch, upsertFile, FILES_ROOT_LABEL } from '@mantle/files';
import { db, nodes, emails, emailAccounts } from '@mantle/db';
import { and, eq } from 'drizzle-orm';
import { createSecret, updateSecret } from '@/lib/secrets';

export type BuildResult = { nodeId: string } | { missing: true; reason: string };

export type BuildCtx = {
  ownerId: string;
  /** [PROBE_BASE_TAG, probeRunTag(runId)] — applied to every fixture node. */
  tags: string[];
  /** 8-hex run id, used to make filenames/titles unique per run. */
  runId: string;
};

export type FixtureBuilder = (ctx: BuildCtx) => Promise<BuildResult>;

/** Directory holding checked-in sample files for the file-type fixtures.
 *  Resolved against the runtime cwd, which differs by entry point: the Next web
 *  app (where the probe API route runs) starts with cwd = `apps/web`, whereas a
 *  repo-root script has cwd = the repo root. The old single `apps/web/…` form
 *  doubled to `apps/web/apps/web/…` under the web server and made EVERY
 *  file-matrix fixture report MISSING. Probe both layouts and pick the one that
 *  exists. */
const FILES_DIR = (() => {
  const rel = 'lib/integrity/fixtures/files';
  const fromAppWeb = path.join(process.cwd(), rel); // cwd = apps/web (next dev / next start)
  const fromRepoRoot = path.join(process.cwd(), 'apps/web', rel); // cwd = repo root (scripts)
  return existsSync(fromAppWeb) ? fromAppWeb : existsSync(fromRepoRoot) ? fromRepoRoot : fromAppWeb;
})();

// ─── content-pipeline builders (no external bytes) ──────────────────────────

export const buildNote: FixtureBuilder = async ({ ownerId, tags }) => {
  const row = await createNote(ownerId, {
    title: 'Integrity probe — Vorthelm gantry note',
    content:
      'Quintus Bramblewick is rebuilding the Vorthelm Dynamics print gantry. ' +
      'He plans to swap the leadscrews for MGN12 linear rails by the Thelby ' +
      'milestone, and wants the firmware reflashed afterwards. This note exists ' +
      'only to verify the brain ingests a plain note end to end.',
    tags,
  });
  return { nodeId: row.id };
};

export const buildPage: FixtureBuilder = async ({ ownerId, tags }) => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Vorthelm Dynamics — gantry rebuild plan' }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text:
              'Quintus Bramblewick owns the Vorthelm Dynamics workshop in Thelby. ' +
              'The plan: replace the print gantry leadscrews with MGN12 rails, then ' +
              'recalibrate. This page verifies the pages → doc_text → extractor path.',
          },
        ],
      },
    ],
  } as Record<string, unknown>;
  const page = await createPage(ownerId, {
    title: 'Integrity probe — Vorthelm rebuild page',
    doc,
    tags,
  });
  return { nodeId: page.id };
};

export const buildTodo: FixtureBuilder = async ({ ownerId, tags }) => {
  const row = await createTodo(ownerId, {
    title: 'Integrity probe — reflash Vorthelm firmware',
    body:
      'Quintus Bramblewick must reflash the Vorthelm Dynamics gantry controller ' +
      'after the MGN12 rail swap. Verifies the task ingest path.',
    tags,
  });
  return { nodeId: row.id };
};

export const buildEvent: FixtureBuilder = async ({ ownerId, tags }) => {
  const startsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const row = await createEvent(ownerId, {
    title: 'Integrity probe — Vorthelm gantry review',
    startsAt,
    body:
      'Review the Vorthelm Dynamics gantry rebuild with Quintus Bramblewick in ' +
      'Thelby. Verifies the event ingest path.',
    tags,
  });
  return { nodeId: row.id };
};

export const buildContact: FixtureBuilder = async ({ ownerId, tags, runId }) => {
  const row = await createContact(ownerId, {
    firstName: 'Quintus',
    lastName: 'Bramblewick',
    company: 'Vorthelm Dynamics',
    email: `quintus.${runId}@vorthelm-probe.invalid`,
    description:
      'Workshop owner at Vorthelm Dynamics in Thelby; runs the gantry rebuild. ' +
      'Synthetic contact used to verify the contact ingest path.',
    tags,
  });
  return { nodeId: row.id };
};

export const buildSecret: FixtureBuilder = async ({ ownerId, tags }) => {
  const row = await createSecret(ownerId, {
    title: 'Integrity probe — Vorthelm workshop wifi',
    description:
      'Wifi credentials for the Vorthelm Dynamics workshop in Thelby. The sealed ' +
      'payload must never reach the LLM — only this metadata should be indexed.',
    kind: 'password',
    tags,
    note: 'Sealed body: the extractor must not read this. SSID VorthelmNet.',
    fields: [],
  });
  return { nodeId: row.id };
};

// ─── email (inbox) builder ──────────────────────────────────────────────────
//
// Email body comes from the `emails` table (subject + body_text), which FKs a
// real `email_accounts` row. We keep one reusable throwaway account, scoped by
// a distinctive address so cleanup can find it. Inserting node + emails row in
// one transaction means the node_ingested trigger fires once, on commit, with
// the body already present.

/** Distinctive address for the reusable probe email account (cleanup key). */
export const PROBE_EMAIL_ADDRESS = 'integrity-probe@mantle.invalid';

async function ensureProbeEmailAccount(ownerId: string): Promise<string> {
  const [existing] = await db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.userId, ownerId), eq(emailAccounts.address, PROBE_EMAIL_ADDRESS)))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(emailAccounts)
    .values({
      userId: ownerId,
      provider: 'imap',
      address: PROBE_EMAIL_ADDRESS,
      displayName: 'Integrity Probe',
      branchPath: 'inbox.integrity',
      // Synthetic scaffold only — the email fixture inserts the node + emails
      // row directly, so this account is never meant to IMAP-sync. Keep it
      // disabled so the email-sync scheduler skips it instead of failing to
      // connect (no imap_host) on every cycle.
      enabled: false,
    })
    .returning({ id: emailAccounts.id });
  if (!row) throw new Error('ensureProbeEmailAccount: insert returned no row');
  return row.id;
}

export const buildEmail: FixtureBuilder = async ({ ownerId, tags, runId }) => {
  const accountId = await ensureProbeEmailAccount(ownerId);
  const internalDate = new Date();
  const nodeId = await db.transaction(async (tx) => {
    const [node] = await tx
      .insert(nodes)
      .values({
        ownerId,
        type: 'email',
        title: 'Integrity probe — Vorthelm gantry quote',
        path: 'inbox.integrity',
        tags,
        data: {
          fromAddr: 'quintus@vorthelm-probe.invalid',
          fromName: 'Quintus Bramblewick',
          internalDate: internalDate.toISOString(),
        },
      })
      .returning({ id: nodes.id });
    if (!node) throw new Error('buildEmail: node insert returned no row');
    await tx.insert(emails).values({
      nodeId: node.id,
      accountId,
      providerMsgId: `probe-${runId}`,
      fromAddr: 'quintus@vorthelm-probe.invalid',
      fromName: 'Quintus Bramblewick',
      toAddrs: ['jason@schoeman.me'],
      subject: 'Vorthelm gantry quote',
      bodyText:
        'Hi Jason — Quintus Bramblewick here from Vorthelm Dynamics in Thelby. Attaching the ' +
        'MGN12 rail quote for the gantry rebuild; the Borrowdale heated chamber is a separate ' +
        'line item. This synthetic email verifies the inbox ingest path. Regards.',
      internalDate,
    });
    return node.id;
  });
  return { nodeId };
};

// ─── file-pipeline builders (real bytes) ────────────────────────────────────

/** Create a file fixture from a checked-in sample under `fixtures/files/`. */
function fileFixture(sampleName: string): FixtureBuilder {
  return async ({ ownerId, tags, runId }) => {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(FILES_DIR, sampleName));
    } catch {
      return { missing: true, reason: `sample file not found: ${sampleName}` };
    }
    await ensureFilesRootBranch(ownerId);
    const ext = sampleName.includes('.') ? sampleName.slice(sampleName.lastIndexOf('.')) : '';
    const base = sampleName.replace(/\.[^.]+$/, '');
    const row = await upsertFile({
      ownerId,
      parentPath: FILES_ROOT_LABEL,
      filename: `probe-${base}-${runId}${ext}`,
      bytes,
      overwrite: false,
    });
    // upsertFile doesn't accept tags; stamp the probe tags on the node so
    // cleanup's tag sweep finds it.
    await tagNode(ownerId, row.id, tags);
    return { nodeId: row.id };
  };
}

/** An inline text file — no checked-in sample needed; exercises the text path. */
export const buildTextFile: FixtureBuilder = async ({ ownerId, tags, runId }) => {
  const bytes = Buffer.from(
    'Vorthelm Dynamics gantry rebuild — field notes.\n\n' +
      'Quintus Bramblewick swapped the leadscrews for MGN12 rails in Thelby and ' +
      'reflashed the controller. This plain-text file verifies the file ingest ' +
      'path (text inlined into data.content).\n',
    'utf8',
  );
  await ensureFilesRootBranch(ownerId);
  const row = await upsertFile({
    ownerId,
    parentPath: FILES_ROOT_LABEL,
    filename: `probe-notes-${runId}.txt`,
    bytes,
    overwrite: false,
  });
  await tagNode(ownerId, row.id, tags);
  return { nodeId: row.id };
};

// In-process parsers (always available, no external service):
export const buildPdfText: FixtureBuilder = fileFixture('sample-text.pdf'); // pdf-parse
export const buildPdfScanned: FixtureBuilder = fileFixture('sample-scanned.pdf'); // pdf-parse → no text layer
export const buildDocx: FixtureBuilder = fileFixture('sample.docx'); // mammoth
export const buildXlsx: FixtureBuilder = fileFixture('sample.xlsx'); // sheetjs
export const buildCsv: FixtureBuilder = fileFixture('sample.csv'); // utf8
export const buildJson: FixtureBuilder = fileFixture('sample.json'); // utf8
export const buildMd: FixtureBuilder = fileFixture('sample.md'); // utf8

// Tika fallback (only indexes if the Tika docker service is up, else skips):
export const buildPptx: FixtureBuilder = fileFixture('sample.pptx');
export const buildOdt: FixtureBuilder = fileFixture('sample.odt');
export const buildEpub: FixtureBuilder = fileFixture('sample.epub');
export const buildRtf: FixtureBuilder = fileFixture('sample.rtf');

// Vision path (only indexes if the vision worker is wired, else skips):
export const buildImage: FixtureBuilder = fileFixture('sample-image.png');
export const buildPhoto: FixtureBuilder = fileFixture('sample-photo.jpg');

// No parser at all → the correct outcome is a skip:
export const buildSvg: FixtureBuilder = fileFixture('sample.svg');
export const buildXml: FixtureBuilder = fileFixture('sample.xml');
export const buildAudio: FixtureBuilder = fileFixture('sample-audio.mp3');

// ─── update builders (trigger re-extraction) ────────────────────────────────
//
// Each mutates an extractor-visible field so the content fn clears the prior
// summary/embedding and re-fires node_ingested. Used by the update sub-test to
// verify the edit re-extracts (and rebuilds chunks/edges idempotently).

export type FixtureUpdater = (ctx: BuildCtx, nodeId: string) => Promise<void>;

export const updateNoteFixture: FixtureUpdater = async ({ ownerId }, nodeId) => {
  await updateNote(ownerId, nodeId, {
    content:
      'REVISED note — Quintus Bramblewick added a Borrowdale heated chamber to the Vorthelm ' +
      'Dynamics gantry rebuild in Thelby after the MGN12 rail swap. Re-extraction should ' +
      're-summarise and rebuild facts/entities without duplicating edges.',
  });
};

export const updateTodoFixture: FixtureUpdater = async ({ ownerId }, nodeId) => {
  await updateTodo(ownerId, nodeId, {
    body: 'UPDATED: reflash, THEN fit the Borrowdale heated chamber on the Vorthelm gantry.',
  });
};

export const updateEventFixture: FixtureUpdater = async ({ ownerId }, nodeId) => {
  await updateEvent(ownerId, nodeId, {
    body: 'UPDATED agenda: gantry review now also covers the Borrowdale heated chamber.',
  });
};

export const updateContactFixture: FixtureUpdater = async ({ ownerId }, nodeId) => {
  await updateContact(ownerId, nodeId, {
    description:
      'UPDATED: Quintus Bramblewick now also leads Vorthelm Dynamics procurement in Thelby.',
  });
};

export const updateSecretFixture: FixtureUpdater = async ({ ownerId }, nodeId) => {
  await updateSecret(ownerId, nodeId, {
    description:
      'UPDATED metadata: Vorthelm Dynamics workshop wifi, now also covers the Borrowdale annex.',
  });
};

export const updatePageFixture: FixtureUpdater = async ({ ownerId }, nodeId) => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text:
              'UPDATED — Quintus Bramblewick added a Borrowdale heated chamber to the Vorthelm ' +
              'Dynamics gantry rebuild in Thelby. Re-extraction should re-summarise this page.',
          },
        ],
      },
    ],
  } as Record<string, unknown>;
  await commitPage(ownerId, nodeId, doc);
};

export const updateTextFileFixture: FixtureUpdater = async ({ ownerId, runId }, nodeId) => {
  void nodeId;
  const bytes = Buffer.from(
    'Vorthelm Dynamics gantry rebuild — field notes (REVISED).\n\n' +
      'Quintus Bramblewick fitted a Borrowdale heated chamber in Thelby after the rail swap. ' +
      'This revision verifies that overwriting a file re-extracts it.\n',
    'utf8',
  );
  await ensureFilesRootBranch(ownerId);
  await upsertFile({
    ownerId,
    parentPath: FILES_ROOT_LABEL,
    filename: `probe-notes-${runId}.txt`,
    bytes,
    overwrite: true,
  });
};

// ─── helper ────────────────────────────────────────────────────────────────

/** Stamp tags onto an already-created node (for builders whose create fn
 *  doesn't take tags, e.g. `upsertFile`). Merges, deduped + lowercased. */
async function tagNode(ownerId: string, nodeId: string, tags: string[]): Promise<void> {
  const [row] = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  const merged = Array.from(
    new Set([...(row?.tags ?? []), ...tags.map((t) => t.toLowerCase())]),
  ).slice(0, 20);
  await db.update(nodes).set({ tags: merged }).where(eq(nodes.id, nodeId));
}
