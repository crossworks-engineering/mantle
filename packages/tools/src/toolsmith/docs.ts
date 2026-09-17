/**
 * Per-group integration state: stored API docs and the usage skill.
 *
 * Split out of builtins-toolsmith.ts; bodies moved verbatim.
 */

import { and, eq } from 'drizzle-orm';
import { db, skills } from '@mantle/db';
import {
  apiSkillSlugForGroup,
  getGroupIntegration,
  readApiDocsFile,
  setGroupIntegration,
  upsertApiDocsFile,
  API_DOCS_MAX_CHARS,
} from '../integration';
import { type BuiltinToolDef, type ToolHandlerResult } from '../types';
import { str } from '../coerce';
import { errorMessage } from '@mantle/std';
import { SLUG_RE, URL_RE } from './common';

const DEFAULT_DOCS_PAGE = 20_000;

const MAX_DOCS_PAGE = 60_000;

/** Resolve a group for a docs/skill call, with a teaching error when it's not
 *  there and a warning when it isn't an integration yet. */
async function groupForIntegrationWrite(
  ownerId: string,
  slug: string,
): Promise<
  | { ok: true; group: NonNullable<Awaited<ReturnType<typeof getGroupIntegration>>> }
  | { ok: false; error: string }
> {
  if (!SLUG_RE.test(slug)) {
    return { ok: false, error: 'group_slug must be lowercase letters/digits/dash/underscore' };
  }
  const group = await getGroupIntegration(ownerId, slug);
  if (!group) {
    return {
      ok: false,
      error: `tool group '${slug}' not found — list them with tool_group_list, or create it with tool_group_ensure (pass service/base_url/secret_ref to make it an integration) and then retry`,
    };
  }
  return { ok: true, group };
}

export const api_docs_set: BuiltinToolDef = {
  slug: 'api_docs_set',
  name: "Store an integration's API docs",
  description:
    "Store (or REPLACE) an integration group's API documentation as a markdown file on this brain and point the group at it. Returns the stored size. Do this right after `web_fetch`ing a service's docs, before authoring: the next pass — any agent, months later — then reads `api_docs_get` instead of re-fetching a page that may have moved or gone behind auth. The stored copy is indexed, so every agent's `search_nodes` can find it. Keep the endpoint reference, auth scheme, parameters, and an example response; drop the marketing pages. Pass source_url so provenance is recorded.",
  inputSchema: {
    type: 'object',
    properties: {
      group_slug: {
        type: 'string',
        description: 'integration group these docs belong to, e.g. weather-tools',
      },
      markdown: {
        type: 'string',
        description:
          "the documentation itself, as markdown — endpoints, auth, parameters, an example response. Replaces the whole file, so include everything you still want (read the old copy first with `api_docs_get` when you're extending)",
      },
      source_url: {
        type: 'string',
        description:
          'where it came from, e.g. https://openweathermap.org/api/one-call-3 — recorded in the file header so a later reader can refresh it',
      },
    },
    required: ['group_slug', 'markdown'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const groupSlug = str(input.group_slug).trim();
    const resolved = await groupForIntegrationWrite(ctx.ownerId, groupSlug);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { group } = resolved;
    const markdown = str(input.markdown);
    if (markdown.trim().length < 40) {
      return {
        ok: false,
        error:
          'markdown is empty or too short to be documentation — pass the endpoint reference you read (web_fetch the docs first, following offset for long pages)',
      };
    }
    const sourceUrl = str(input.source_url).trim();
    if (sourceUrl && !URL_RE.test(sourceUrl)) {
      return {
        ok: false,
        error: 'source_url must start with http(s):// — omit it if you have none',
      };
    }

    const warnings: string[] = [];
    // A group with no integration yet still gets its docs — recording the
    // service from the slug beats refusing and losing the fetched page. Say so.
    const service = group.integration?.service ?? groupSlug;
    if (!group.integration) {
      warnings.push(
        `group '${groupSlug}' had no integration binding — recorded service '${service}'. Set the real service, base_url and secret_ref with tool_group_ensure, or tools authored into this group inherit no credential`,
      );
    }
    if (markdown.length > API_DOCS_MAX_CHARS) {
      warnings.push(
        `docs were clipped to fit the stored file — keep the endpoint reference and drop prose if anything important is missing`,
      );
    }

    try {
      const stored = await upsertApiDocsFile({
        ownerId: ctx.ownerId,
        groupSlug,
        markdown,
        service,
        ...(sourceUrl ? { sourceUrl } : {}),
      });
      await setGroupIntegration(ctx.ownerId, groupSlug, {
        service,
        docsNodeId: stored.nodeId,
        docsUpdatedAt: stored.capturedAt,
        ...(sourceUrl ? { docsSourceUrl: sourceUrl } : {}),
      });
      ctx.step?.setOutput({ groupSlug, file: stored.filename, chars: stored.chars });
      return {
        ok: true,
        output: {
          group_slug: groupSlug,
          file: `files/api-docs/${stored.filename}`,
          chars: stored.chars,
          stored: true,
          warnings,
          next: 'Author calls with group_slug so they inherit the base URL + credential, then distil what you learned into the usage skill with api_skill_set.',
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const api_docs_get: BuiltinToolDef = {
  slug: 'api_docs_get',
  readOnly: true,
  name: "Read an integration's stored API docs",
  description:
    "Read back the API documentation stored on an integration group — the markdown `api_docs_set` saved, in slices (pass offset to continue). **Read this FIRST when adding a call to an existing integration**: it's this brain's captured copy, so it costs nothing and can't have moved. Use `web_fetch` only when a group has no stored docs or they don't cover the endpoint you need — then `api_docs_set` the refreshed copy back. Returns has_docs false (not an error) when nothing is stored, plus where the copy came from and when it was captured, so you can judge staleness.",
  inputSchema: {
    type: 'object',
    properties: {
      group_slug: {
        type: 'string',
        description: 'integration group whose docs to read, e.g. weather-tools',
      },
      offset: {
        type: 'number',
        description: 'character offset to resume from when the previous slice was truncated',
        default: 0,
        minimum: 0,
      },
      max_chars: {
        type: 'number',
        description: 'size of the slice to return',
        default: DEFAULT_DOCS_PAGE,
        minimum: 1_000,
        maximum: MAX_DOCS_PAGE,
      },
    },
    required: ['group_slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const groupSlug = str(input.group_slug).trim();
    const resolved = await groupForIntegrationWrite(ctx.ownerId, groupSlug);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { group } = resolved;
    const meta = group.integration;
    const noDocs = (note: string): ToolHandlerResult => ({
      ok: true,
      output: {
        group_slug: groupSlug,
        has_docs: false,
        note,
        next: "web_fetch the service's documentation, then store it with api_docs_set so the next pass doesn't have to.",
      },
    });
    if (!meta?.docsNodeId)
      return noDocs('no documentation has been stored for this integration yet');

    const file = await readApiDocsFile({ ownerId: ctx.ownerId, nodeId: meta.docsNodeId });
    if (!file) {
      return noDocs(
        'the stored docs file is gone (deleted from Files) — the group still points at it',
      );
    }
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const cap = Math.min(
      MAX_DOCS_PAGE,
      Math.max(1_000, Math.floor(Number(input.max_chars) || DEFAULT_DOCS_PAGE)),
    );
    const slice = file.text.slice(offset, offset + cap);
    ctx.step?.setMeta({ groupSlug, totalChars: file.text.length, offset });
    return {
      ok: true,
      output: {
        group_slug: groupSlug,
        has_docs: true,
        service: meta.service,
        base_url: meta.baseUrl ?? null,
        secret_ref: meta.secretRef ?? null,
        source_url: meta.docsSourceUrl ?? null,
        captured_at: meta.docsUpdatedAt ?? null,
        file: `files/api-docs/${file.filename}`,
        text: slice,
        offset,
        total_chars: file.text.length,
        truncated: offset + cap < file.text.length,
      },
    };
  },
};

/** Usage-skill body bounds. The skill ships in the system prompt of EVERY agent
 *  granted the group, on every turn — a long one is a permanent tax, so the cap
 *  is a hard refusal and the soft bound is a warning. */
const MAX_SKILL_BODY_CHARS = 6_000;

const SOFT_SKILL_WORDS = 320;

/**
 * The ONLY skill-authoring tool in the codebase — and its narrow scope is the
 * safety property, not a convenience. An agent must never be able to edit
 * persona/manifest behaviour, so this tool:
 *
 *   - derives the slug (`api-<group-slug>`) from the group; the model cannot
 *     name the row it writes,
 *   - refuses a group with no integration binding, so it only ever touches an
 *     API integration's own skill,
 *   - refuses when a row with that slug exists but ISN'T already linked to this
 *     integration — that row belongs to the operator (or the manifest), and
 *     overwriting it is exactly the escalation this guard exists to prevent.
 *
 * Hence no `slug` parameter and no update-by-id path: there is nothing else it
 * can reach. (Mutation → gated behind MANTLE_MCP_TOOLSMITH_WRITE on MCP.)
 */
export const api_skill_set: BuiltinToolDef = {
  slug: 'api_skill_set',
  name: "Write an integration's usage skill",
  description:
    'Write (or replace) the short USAGE skill that travels with an integration group: distilled judgment — which endpoint answers which question, unit and date conventions, how to chain two calls, how to read the response. Every agent granted the group gets this in its context on every turn, so keep it tight and never paste the reference docs in (those live in `api_docs_set`; this is what you learned USING them). Do it last, after the calls test green. Creates/updates one skill per group and links it, so calling twice revises rather than forking.',
  inputSchema: {
    type: 'object',
    properties: {
      group_slug: {
        type: 'string',
        description: 'integration group this skill belongs to, e.g. weather-tools',
      },
      body: {
        type: 'string',
        description:
          'the skill in markdown, ~150–250 words: when to reach for each tool, the conventions a caller gets wrong (units, timezones, id lookups), and per-tool notes where one call needs special handling',
      },
      name: {
        type: 'string',
        description:
          'display name for the skill, e.g. "Weather API usage" — defaults to the group name plus "usage"',
      },
    },
    required: ['group_slug', 'body'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const groupSlug = str(input.group_slug).trim();
    const resolved = await groupForIntegrationWrite(ctx.ownerId, groupSlug);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { group } = resolved;
    // Integration-only by construction: no binding, no skill. Keeps this tool
    // categorically unable to author a general-purpose behaviour pack.
    if (!group.integration) {
      return {
        ok: false,
        error: `tool group '${groupSlug}' is not an integration — this tool only writes an API integration's own usage skill. Bind it first with tool_group_ensure (service, base_url, secret_ref, auth_template); a general behaviour skill is the owner's to write in Settings → Skills`,
      };
    }
    const body = str(input.body).trim();
    if (body.length < 80) {
      return {
        ok: false,
        error:
          'body is too short to be useful know-how — say which tool answers which question and the conventions a caller gets wrong (units, timezones, id lookups)',
      };
    }
    if (body.length > MAX_SKILL_BODY_CHARS) {
      return {
        ok: false,
        error: `body is ${body.length} characters — this ships in every granted agent's prompt on every turn, so trim it to the judgment (the reference belongs in api_docs_set)`,
      };
    }
    const warnings: string[] = [];
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words > SOFT_SKILL_WORDS) {
      warnings.push(
        `the skill is ${words} words — it rides in every granted agent's prompt on every turn; cut anything a reader could look up in the stored docs`,
      );
    }
    if (group.toolSlugs.length === 0) {
      warnings.push(
        `group '${groupSlug}' has no tools yet — write the skill AFTER authoring and testing the calls, or it describes usage of nothing`,
      );
    }
    if (!group.integration.docsNodeId) {
      warnings.push(
        `no API documentation is stored on this group — api_docs_set it too, so the next pass can extend the integration without re-fetching the vendor's site`,
      );
    }

    // The slug is DERIVED, never model-supplied: one skill per group, and no way
    // to name a different row.
    const skillSlug = apiSkillSlugForGroup(groupSlug);
    const name = str(input.name).trim() || `${group.name} usage`;
    const description = `How to use the ${group.integration.service} integration's tools — written by Toolsmith from the stored API docs.`;
    const [existing] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.ownerId, ctx.ownerId), eq(skills.slug, skillSlug)))
      .limit(1);
    // A row under this slug that this integration doesn't already point at is
    // someone else's (operator-authored, or a manifest skill). Refuse rather
    // than overwrite — an agent must not be able to rewrite behaviour it doesn't
    // own, and silently clobbering a persona skill is the worst version of that.
    if (existing && group.integration.skillSlug !== skillSlug) {
      return {
        ok: false,
        error: `a skill '${skillSlug}' already exists but isn't linked to this integration — it belongs to the owner (or ships with the product), so I won't overwrite it. Ask the owner to rename or remove it in Settings → Skills, then retry`,
      };
    }
    if (existing) {
      await db
        .update(skills)
        .set({ name, description, instructions: body, updatedAt: new Date() })
        .where(eq(skills.id, existing.id));
    } else {
      await db.insert(skills).values({
        ownerId: ctx.ownerId,
        slug: skillSlug,
        name,
        description,
        instructions: body,
        enabled: true,
      });
    }
    await setGroupIntegration(ctx.ownerId, groupSlug, { skillSlug });
    ctx.step?.setOutput({ groupSlug, skillSlug, words });
    return {
      ok: true,
      output: {
        group_slug: groupSlug,
        skill_slug: skillSlug,
        created: !existing,
        words,
        warnings,
        note: `Every agent granted '${groupSlug}' now carries this skill in its context — no separate attach step.`,
      },
    };
  },
};

/* ─────────────────────────── recipe tools ────────────────────────── */
