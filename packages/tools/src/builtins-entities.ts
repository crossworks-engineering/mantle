/**
 * Builtins: entity_* and graph_path — the knowledge graph.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 */

import {
  searchEntities,
  entityNeighbors,
  entityFacts,
  entityMentions,
  graphPath,
} from '@mantle/search';
import { type BuiltinToolDef } from './types';
import { str, strOpt, numOpt as num, boolOpt as bool } from './coerce';
import { strArr } from './builtins-common';

export const entity_search: BuiltinToolDef = {
  slug: 'entity_search',
  readOnly: true,
  name: 'Search entities',
  description:
    'Resolve a name or alias to entities the user has accumulated (people, projects, places, orgs, events). Returns hits with similarity scores. Use this when the user mentions someone or something by name and you need their internal id.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'name or alias to resolve' },
      kind: {
        type: 'string',
        description: 'optional kind filter',
        enum: ['person', 'project', 'place', 'org', 'event'],
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Max results to return.',
      },
    },
    required: ['q'],
  },
  handler: async (input, ctx) => {
    const q = str(input.q);
    if (!q) return { ok: false, error: 'q required' };
    const rows = await searchEntities({
      ownerId: ctx.ownerId,
      q,
      kind: strOpt(input.kind),
      limit: num(input.limit, 10),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

export const entity_neighbors: BuiltinToolDef = {
  slug: 'entity_neighbors',
  readOnly: true,
  name: 'Walk entity neighbors',
  description:
    "Given an entity id, return connected entities one hop away (in both directions by default). Use after entity_search to expand context, e.g. 'who works with Sarah?' or 'what projects mention Lister?'.",
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        format: 'uuid',
        description: "The entity's id (UUID) — from `entity_search`.",
      },
      relation: {
        type: 'string',
        description: "only follow edges with this relation verb, e.g. 'employed_by'; omit for all",
      },
      direction: {
        type: 'string',
        enum: ['in', 'out', 'both'],
        default: 'both',
        description:
          "'out' = edges where this entity is the subject, 'in' = where it is the object",
      },
      current_only: {
        type: 'boolean',
        default: false,
        description:
          'only relationships still current — exclude ones that have ended (superseded edges)',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 25,
        description:
          "Max results to return. On 'both' the budget splits per direction, so odd values can return one extra row.",
      },
    },
    required: ['entity_id'],
  },
  handler: async (input, ctx) => {
    const entityId = str(input.entity_id);
    if (!entityId) return { ok: false, error: 'entity_id required' };
    const rows = await entityNeighbors({
      ownerId: ctx.ownerId,
      entityId,
      relation: strOpt(input.relation),
      direction: (strOpt(input.direction) ?? 'both') as 'in' | 'out' | 'both',
      currentOnly: bool(input.current_only),
      limit: num(input.limit, 25),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

export const graph_path: BuiltinToolDef = {
  slug: 'graph_path',
  readOnly: true,
  name: 'Walk the entity graph (multi-hop)',
  description:
    "Multi-hop traversal of the knowledge graph — the relationships BETWEEN entities (e.g. 'Sarah works_at Lister', 'Lister supplies Acme'). Use for connection questions one hop can't answer: 'how is Sarah connected to Acme?' (pass from_id + to_id → shortest path) or 'what's within 2 hops of Lister?' (pass from_id only → reachable neighbourhood). Get ids from entity_search first. `relations` filters which verbs to follow; `directed:true` follows subject→object only (default treats edges as undirected for connectivity). For a single hop use entity_neighbors instead.",
  inputSchema: {
    type: 'object',
    properties: {
      from_id: { type: 'string', format: 'uuid', description: 'Start entity id.' },
      to_id: {
        type: 'string',
        format: 'uuid',
        description: 'Optional target entity id — returns shortest path(s) to it.',
      },
      max_depth: {
        type: 'integer',
        minimum: 1,
        maximum: 6,
        default: 3,
        description: 'How many hops out to traverse.',
      },
      relations: {
        type: 'array',
        items: { type: 'string' },
        description: "Only follow these relation verbs, e.g. ['employed_by','owns'].",
      },
      directed: {
        type: 'boolean',
        default: false,
        description:
          'Follow edges subject→object only. Default false treats edges as undirected — the right setting for "how are X and Y connected" questions.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Max results to return.',
      },
    },
    required: ['from_id'],
  },
  handler: async (input, ctx) => {
    const fromId = str(input.from_id);
    if (!fromId) return { ok: false, error: 'from_id required' };
    const rows = await graphPath({
      ownerId: ctx.ownerId,
      fromId,
      toId: strOpt(input.to_id),
      maxDepth: num(input.max_depth, 3),
      relations: strArr(input.relations),
      directed: bool(input.directed),
      limit: num(input.limit, 50),
    });
    ctx.step?.setMeta({ count: rows.length, reached: !!input.to_id && rows.length > 0 });
    return {
      ok: true,
      output: rows.map((r) => ({
        entity: { id: r.entity.id, name: r.entity.name, kind: r.entity.kind },
        depth: r.depth,
        path: r.path,
      })),
    };
  },
};

export const entity_facts: BuiltinToolDef = {
  slug: 'entity_facts',
  readOnly: true,
  name: 'List entity facts',
  description:
    'All facts the user has accumulated about a specific entity (what they KNOW about that person/place/thing). Returns currently-valid facts by default; set include_retired=true to see superseded history. ' +
    'Get the entity id from `entity_search` first. For content nodes (emails, notes, files) that MENTION the entity use `entity_mentions`; to walk to connected entities use `entity_neighbors`.',
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        format: 'uuid',
        description: "The entity's id (UUID) — from `entity_search`.",
      },
      include_retired: {
        type: 'boolean',
        default: false,
        description: 'also return superseded facts (the history), not just currently-valid ones',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 50,
        description: 'Max results to return.',
      },
    },
    required: ['entity_id'],
  },
  handler: async (input, ctx) => {
    const entityId = str(input.entity_id);
    if (!entityId) return { ok: false, error: 'entity_id required' };
    const rows = await entityFacts({
      ownerId: ctx.ownerId,
      entityId,
      includeRetired: bool(input.include_retired),
      limit: num(input.limit, 50),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

export const entity_mentions: BuiltinToolDef = {
  slug: 'entity_mentions',
  readOnly: true,
  name: 'List entity mentions',
  description:
    'Content nodes (files, notes, emails, …) that mention a given entity, newest first. Returns title + per-node summary so the model can decide which to dig into. ' +
    'Get the entity id from `entity_search` first. For distilled facts ABOUT the entity (what the user knows) use `entity_facts`; to walk to connected entities use `entity_neighbors`.',
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        format: 'uuid',
        description: "The entity's id (UUID) — from `entity_search`.",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 25,
        description: 'Max results to return.',
      },
    },
    required: ['entity_id'],
  },
  handler: async (input, ctx) => {
    const entityId = str(input.entity_id);
    if (!entityId) return { ok: false, error: 'entity_id required' };
    const rows = await entityMentions({
      ownerId: ctx.ownerId,
      entityId,
      limit: num(input.limit, 25),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

/** The knowledge graph: entity lookup, neighbours, paths, facts, mentions. */
export const ENTITY_TOOLS: readonly BuiltinToolDef[] = [
  entity_search,
  entity_neighbors,
  graph_path,
  entity_facts,
  entity_mentions,
];
