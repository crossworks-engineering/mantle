/**
 * `update_persona` — lets a conversational agent adjust its OWN persona
 * when the user explicitly asks it to change how it behaves ("be more
 * professional", "call me Jay", "stop using bullet lists").
 *
 * This is the explicit-instruction counterpart to the reflector (which
 * learns passively, on a timer). A tool buys three things the reflector
 * can't: the change lands this turn (not 10 min later), it's deterministic
 * (direct request → direct write), and it can SUPERSEDE a contradicting
 * note instead of stacking on it.
 *
 * Self-scoping: writes to whichever agent is running the turn (resolved
 * via ctx.agent.slug + ctx.ownerId). This sidesteps the responder-vs-
 * assistant persona split — the agent edits the notes it actually reads.
 *
 * Scoped resolution, never a full rewrite: supersede/remove only touch
 * the notes the model named. Notes are soft-retired (kept for audit),
 * never deleted — persona has no source underneath it, so edits must be
 * reversible. The pure logic lives in @mantle/db/persona-notes.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  db,
  agents,
  activeNotes,
  onFullSystemRoute,
  applyPersonaUpdate,
  noteRef,
  type PersonaNote,
  type PersonaUpdate,
} from '@mantle/db';
import { notesTargetOf, writeLearnedEntries } from '@mantle/content';
import { areaSystem } from './admin-gate';
import { restampHeartbeatMakers } from './heartbeat-maker';
import { toolMaker } from './secret-ref-gate';
import { reconcileMeta, ruleReconcilerFor } from './rule-reconciler';
import type { BuiltinToolDef } from './types';
import { replayAsker } from './builtins-replay';
import { CS } from './client-sourced-rule';

/** update_persona outside the anchor's own thread. */
export const UPDATE_PERSONA_ANCHOR_ONLY =
  "update_persona writes what you learned in the brain owner's own chat, and this turn is not it: keep the preference in mind for this conversation only, and don't record it.";

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

const update_persona: BuiltinToolDef = {
  slug: 'update_persona',
  policy: {
    matrix: { none: 'names no item' },
    effect: 'write',
    spends: 'ownerKey',
    startsModelWork: true,
    scope: { area: 'assistants' },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    clientSourced: CS.free("the owner's persona notes; team and client turns load none"),
  },
  name: 'Update persona',
  description:
    "Adjust how YOU (the assistant) behave with this user — style, tone, how you address them — ONLY when they explicitly ask for a durable change ('be more professional', 'call me Jay', 'stop using bullet lists'). " +
    'When the new preference contradicts a persona note already in your context, pass its [ref] in `supersede_refs` so the stale note is retired rather than left to conflict; `remove_refs` drops a behaviour without replacing it. ' +
    'NOT for facts about the user or their world (remembered automatically), and NOT for one-off requests ("just for this reply, be brief") — only changes that should persist across conversations. Acknowledge the change in your reply.',
  inputSchema: {
    type: 'object',
    properties: {
      add: {
        type: 'object',
        description: 'A new persona note to adopt.',
        properties: {
          kind: {
            type: 'string',
            enum: ['style', 'relationship', 'correction'],
            description:
              'style = voice/tone/format; relationship = how you and the user relate (names, in-jokes); correction = fixing a standing mistake.',
          },
          content: {
            type: 'string',
            description:
              'One declarative sentence describing the behaviour, e.g. "Prefers a professional, formal tone with no emoji."',
          },
        },
        required: ['kind', 'content'],
      },
      supersede_refs: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The [ref] tags of existing persona notes the new note replaces. They get retired (kept for audit, hidden from future turns).',
      },
      remove_refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'The [ref] tags of existing persona notes to retire without a replacement.',
      },
      reason: {
        type: 'string',
        description: 'Optional short note on why, for the audit trail.',
      },
    },
  },
  handler: async (input, ctx) => {
    const slug = ctx.agent?.slug;
    if (!slug) {
      return {
        ok: false,
        error: 'update_persona can only run inside an agent turn (no agent context).',
      };
    }
    // Persona notes (and their learned Journal lane) are learned from the
    // anchor's own thread and ride only there: another user's turn, or a
    // turn that answers nobody, does not write them. Same asker rule as
    // replay.
    if (replayAsker(ctx.ownerId, ctx.surface) !== ctx.ownerId) {
      return { ok: false, error: UPDATE_PERSONA_ANCHOR_ONLY };
    }

    const addRaw = input.add;
    let add: PersonaUpdate['add'];
    if (addRaw && typeof addRaw === 'object') {
      const kind = (addRaw as Record<string, unknown>).kind;
      const content = (addRaw as Record<string, unknown>).content;
      if (
        (kind === 'style' || kind === 'relationship' || kind === 'correction') &&
        typeof content === 'string' &&
        content.trim().length > 0
      ) {
        add = { kind, content };
      }
    }

    const update: PersonaUpdate = {
      add,
      supersedeRefs: asStringArray(input.supersede_refs),
      removeRefs: asStringArray(input.remove_refs),
    };

    if (!update.add && (update.removeRefs ?? []).length === 0) {
      return {
        ok: false,
        error: 'Nothing to do — provide `add` (a new note) and/or `remove_refs` (notes to retire).',
      };
    }

    // The agent row is a system table: read and
    // written after the assistants area check. The Journal entries this
    // writes, and the older rules it retires, are items: in the scope.
    const [row] = await areaSystem('assistants', () =>
      db
        .select({
          id: agents.id,
          personaNotes: agents.personaNotes,
          memoryConfig: agents.memoryConfig,
        })
        .from(agents)
        .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, slug)))
        .limit(1),
    );
    if (!row) {
      return { ok: false, error: `agent '${slug}' not found for this owner` };
    }

    // memory_config.notes_target = 'journal': this agent's notes live in the
    // Journal now. An explicit request is a standing preference (always on);
    // retiring an old one is a Journal edit, which the Journal tools do.
    if (notesTargetOf(row.memoryConfig) === 'journal') {
      if (!update.add) {
        return {
          ok: false,
          error:
            'Your notes live in the Journal: change or remove the entry with journal_update / journal_delete.',
        };
      }
      const { written, reconcile } = await writeLearnedEntries(
        ctx.ownerId,
        slug,
        [{ ...update.add, scope: 'general' }],
        'update_persona',
        { reconcile: ruleReconcilerFor(ctx.ownerId) },
      );
      // Persona refs mean nothing in the Journal. The new entry is written
      // (a correction must land). With rule_reconcile live, an older rule it
      // repeats or changes is retired here; anything else the model retires
      // with the Journal tools, and it is told so rather than told "done".
      // Live: `retires` lists the rules that were retired, no more.
      const retired = reconcile?.mode === 'live' ? reconcile.retires.length : 0;
      const ignoredRefs = [...(update.supersedeRefs ?? []), ...(update.removeRefs ?? [])];
      const staleRefs = ignoredRefs.length > 0;
      ctx.step?.setMeta({
        agent: slug,
        target: 'journal',
        written: written.length,
        ...(staleRefs ? { refs_ignored: ignoredRefs } : {}),
        ...(reconcile ? { rule_reconcile: reconcileMeta(reconcile) } : {}),
      });
      return {
        ok: true,
        output: {
          journal: written[0] ?? null,
          ...(retired > 0
            ? {
                retired: reconcile!.retires.map((r) => r.older),
              }
            : {}),
          ...(staleRefs
            ? {
                not_retired:
                  retired > 0
                    ? 'The older rules listed in `retired` were superseded automatically. supersede_refs / remove_refs are persona-note refs and do not apply in the Journal; retire anything else with journal_list, then journal_delete / journal_update.'
                    : 'supersede_refs / remove_refs are persona-note refs and do not apply in the Journal. Find the entry this replaces with journal_list, then remove or rewrite it with journal_delete / journal_update.',
              }
            : {}),
        },
      };
    }

    const current = (row.personaNotes ?? []) as PersonaNote[];
    const result = applyPersonaUpdate(current, update, new Date().toISOString(), randomUUID());

    if (!result.added && result.retired.length === 0) {
      // Refs named but nothing matched an active note — tell the model
      // plainly rather than silently succeeding.
      return {
        ok: false,
        error:
          'No matching active persona notes to change. Check the [ref] tags against the notes shown in your context.',
      };
    }

    await areaSystem('assistants', async () => {
      // The persona notes are part of what the assistant runs (its
      // prompt): not the narrow login's (access-matrix.ts
      // NARROW_NEVER_UPDATE_TABLE), the full-route spot skill-text.
      await onFullSystemRoute('skill-text', () =>
        db
          .update(agents)
          .set({ personaNotes: result.notes, updatedAt: new Date() })
          .where(eq(agents.id, row.id)),
      );
      // The persona notes are in this agent's prompt, which its heartbeats
      // run: a login other than the anchor writing them makes those
      // heartbeats its own (heartbeat-maker.ts).
      await restampHeartbeatMakers(ctx.ownerId, toolMaker(ctx.ownerId), { agentSlug: slug });
    });

    ctx.step?.setMeta({
      agent: slug,
      added_kind: result.added?.kind ?? null,
      retired: result.retired,
      reason: typeof input.reason === 'string' ? input.reason : undefined,
    });
    ctx.step?.setOutput({
      added: !!result.added,
      retired_count: result.retired.length,
      active_note_count: activeNotes(result.notes).length,
    });

    return {
      ok: true,
      output: {
        added: result.added
          ? { ref: noteRef(result.added), kind: result.added.kind, content: result.added.content }
          : null,
        retired: result.retired,
        active_note_count: activeNotes(result.notes).length,
      },
    };
  },
};

export const PERSONA_TOOLS: BuiltinToolDef[] = [update_persona];

/** Canonical slug list — granted to conversational agents at boot so
 *  "be more professional" works without manual operator setup. Keep the
 *  auto-grant in sync with this rather than hardcoding the string. */
export const PERSONA_TOOL_SLUGS: readonly string[] = PERSONA_TOOLS.map((t) => t.slug);
