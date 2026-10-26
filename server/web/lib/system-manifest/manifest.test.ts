import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_DELEGATE_SLUGS,
  MANIFEST_AGENTS,
  MANIFEST_SKILLS,
  MANIFEST_TOOL_GROUPS,
  MANIFEST_HTTP_TOOLS,
  MANIFEST_HTTP_TOOL_SLUGS,
  MANIFEST_HEARTBEATS,
  MANIFEST_WORKERS,
  KNOWN_TOOL_SLUGS,
  KNOWN_TOOL_GROUP_SLUGS,
  DELEGATE_SLUGS,
  PERSONA_SLUG,
  RETIRED_BUILTIN_TOOL_SLUGS,
  RETIRED_TOOL_GROUP_SLUGS,
  type ManifestAgent,
} from './manifest';
import {
  builtinPolicy,
  BUILTIN_TOOLS,
  knownFlowForGroup,
  buildHttpRequest,
  collectParamNames,
  collectSecretRefs,
} from '@mantle/tools';
import {
  DEFAULT_WORKER_SLUG,
  WORKER_MODEL_INHERIT,
  WORKER_SYSTEM_PROMPT,
  WORKER_TOOL_GROUP_SLUGS,
} from '@mantle/runs';

/**
 * Manifest drift guard (modeled on packages/voice/.../catalog-consistency.test.ts).
 * A typo'd or dangling slug — a skill that bundles a tool with no row, an agent
 * that references a skill that doesn't exist, a delegate target that isn't an
 * agent — fails CI here, instead of degrading silently at runtime. This is how
 * we keep the vital links honest as new tools/skills are added.
 */
describe('system manifest integrity', () => {
  const skillSlugs = new Set(MANIFEST_SKILLS.map((s) => s.slug));
  const agentSlugs = new Set(MANIFEST_AGENTS.map((a) => a.slug));
  const groupTools = new Map(MANIFEST_TOOL_GROUPS.map((g) => [g.slug, g.toolSlugs]));

  /** P6: an agent's effective tool set is exactly the union of its granted
   *  groups' tools — the sole grant mechanism. */
  const effectiveTools = (agent: ManifestAgent): Set<string> => {
    const set = new Set<string>();
    for (const g of agent.toolGroupSlugs ?? []) for (const t of groupTools.get(g) ?? []) set.add(t);
    return set;
  };

  it('has no duplicate slugs', () => {
    expect(MANIFEST_SKILLS.length).toBe(skillSlugs.size);
    expect(MANIFEST_AGENTS.length).toBe(agentSlugs.size);
    const workerKinds = MANIFEST_WORKERS.map((w) => w.kind);
    expect(new Set(workerKinds).size).toBe(workerKinds.length);
  });

  it('every heartbeat references a real skill, a real tool group, and is uniquely slugged', () => {
    const slugs = MANIFEST_HEARTBEATS.map((h) => h.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const h of MANIFEST_HEARTBEATS) {
      expect(skillSlugs.has(h.skillSlug), `${h.slug} → skill ${h.skillSlug}`).toBe(true);
      expect(groupTools.has(h.requiresToolGroup), `${h.slug} → group ${h.requiresToolGroup}`).toBe(
        true,
      );
    }
  });

  it('the persona holds every tool group its heartbeats need', () => {
    // A heartbeat fires as the persona. Without the group it burns a turn and
    // fails on the first tool call, which reads as a model fault, not a grant
    // fault. `brain-health` shipped granted to NOBODY for exactly this reason.
    const persona = MANIFEST_AGENTS.find((a) => a.isPersona)!;
    for (const h of MANIFEST_HEARTBEATS) {
      expect(
        (persona.toolGroupSlugs ?? []).includes(h.requiresToolGroup),
        `persona must hold '${h.requiresToolGroup}' for heartbeat '${h.slug}'`,
      ).toBe(true);
    }
  });

  it('every skill a default heartbeat binds declares its state shape', () => {
    // A heartbeat's `state` is its running memory between fires, and the
    // create form pre-fills "Initial state" from the bound skill's
    // defaultState. Ship the skill without one and the operator stares at a
    // bare `{}` with no clue what shape belongs there — which is exactly what
    // happened when brain_health_check first moved into the manifest.
    // Declaring `{}` explicitly is a valid answer; forgetting is not.
    for (const h of MANIFEST_HEARTBEATS) {
      const skill = MANIFEST_SKILLS.find((sk) => sk.slug === h.skillSlug)!;
      expect(
        Object.prototype.hasOwnProperty.call(skill, 'defaultState'),
        `skill '${skill.slug}' backs heartbeat '${h.slug}' and must declare defaultState (even {})`,
      ).toBe(true);
    }
  });

  it('no heartbeat fires more often than daily, and every one jitters', () => {
    // Scheduled spend the user never asked for. A tight interval multiplied
    // across a fleet is the runaway-cost shape; jitter stops every brain in the
    // fleet hitting the provider on the same second.
    for (const h of MANIFEST_HEARTBEATS) {
      expect(h.everyMinutes, `${h.slug} interval`).toBeGreaterThanOrEqual(1440);
      expect(h.jitterMinutes, `${h.slug} jitter`).toBeGreaterThan(0);
    }
  });

  it('every tool group bundles only known builtin tools, with unique slugs', () => {
    const groupSlugs = MANIFEST_TOOL_GROUPS.map((g) => g.slug);
    expect(new Set(groupSlugs).size, 'duplicate tool-group slug').toBe(groupSlugs.length);
    for (const group of MANIFEST_TOOL_GROUPS) {
      const unknown = group.toolSlugs.filter((t) => !KNOWN_TOOL_SLUGS.has(t));
      expect(unknown, `tool group '${group.slug}' references unknown tools`).toEqual([]);
      expect(group.toolSlugs.length, `tool group '${group.slug}' is empty`).toBeGreaterThan(0);
    }
  });

  it('every agent is authored as pure tool groups (P6) and references only known groups/skills', () => {
    for (const agent of MANIFEST_AGENTS) {
      // P6: grants are GROUPS only — there is no direct tool_slugs field on a
      // manifest agent anymore (enforced by the type; the column was dropped in
      // migration 0083). Every agent must grant at least one group to act.
      const groups = agent.toolGroupSlugs ?? [];
      expect(
        groups.length,
        `agent '${agent.slug}' grants no tool groups — cannot act`,
      ).toBeGreaterThan(0);

      const unknownGroups = groups.filter((g) => !KNOWN_TOOL_GROUP_SLUGS.has(g));
      expect(unknownGroups, `agent '${agent.slug}' references unknown tool groups`).toEqual([]);

      // Effective set (the group union) resolves to known builtins only.
      const unknownTools = [...effectiveTools(agent)].filter((t) => !KNOWN_TOOL_SLUGS.has(t));
      expect(unknownTools, `agent '${agent.slug}' effective set has unknown tools`).toEqual([]);

      const unknownSkills = agent.skillSlugs.filter((s) => !skillSlugs.has(s));
      expect(unknownSkills, `agent '${agent.slug}' references unknown skills`).toEqual([]);
    }
  });

  it('exactly one persona, and every delegate target is a real specialist agent', () => {
    expect(MANIFEST_AGENTS.filter((a) => a.isPersona)).toHaveLength(1);
    expect(agentSlugs.has(PERSONA_SLUG)).toBe(true);
    for (const slug of DELEGATE_SLUGS) {
      expect(agentSlugs.has(slug), `delegate target '${slug}' is not a manifest agent`).toBe(true);
      // the persona must not delegate to itself
      expect(slug).not.toBe(PERSONA_SLUG);
    }
  });

  it('the surface specialists hold their surface tools (via their groups)', () => {
    // No surface pre-selects an agent anymore (the responder delegates), but
    // the delegation targets must still be able to do the work handed to them.
    const pagesAgent = MANIFEST_AGENTS.find((a) => a.slug === 'pages')!;
    expect(effectiveTools(pagesAgent).has('page_create')).toBe(true);
    const tablesAgent = MANIFEST_AGENTS.find((a) => a.slug === 'tables')!;
    expect(effectiveTools(tablesAgent).has('table_from_text')).toBe(true);
  });

  it("every tool in the 'runs' group is banned as a queue item (no run recursion)", () => {
    // Audit 2026-07-21: run_audit shipped granted-but-unbanned, letting a
    // queue item rubber-stamp the audit gate headlessly. Any tool granted via
    // the runs group must also be banned as a run item (its policy).
    const runsGroup = MANIFEST_TOOL_GROUPS.find((g) => g.slug === 'runs');
    expect(runsGroup, "manifest has a 'runs' tool group").toBeDefined();
    for (const slug of runsGroup!.toolSlugs) {
      expect(builtinPolicy(slug)?.recipe?.runItem, `'${slug}' must be banned as a run item`).toBe(
        'banned',
      );
    }
  });

  it('every grantable builtin lives in at least one tool group (P6 — groups are total)', () => {
    const inAGroup = new Set(MANIFEST_TOOL_GROUPS.flatMap((g) => g.toolSlugs));
    // Every static builtin must be grantable via some group. (Runtime-only
    // affordances like heartbeat_* are registered outside BUILTIN_TOOLS and are
    // injected per-turn, never granted — so they're correctly absent here.)
    // mcpOnly builtins are NOT grantable by construction (see the mcpOnly
    // block below) — they are the owner's operator surface, reachable over MCP
    // and never through a tool group.
    const orphans = BUILTIN_TOOLS.filter((t) => !t.mcpOnly)
      .map((t) => t.slug)
      .filter((s) => !inAGroup.has(s));
    expect(orphans, 'these builtins are grantable but belong to no group').toEqual([]);
  });

  it('the persona delegates page/table work — holds no page_*/table_* authoring, but can delegate (P5/P6)', () => {
    const persona = MANIFEST_AGENTS.find((a) => a.isPersona)!;
    const grant = effectiveTools(persona);
    expect(grant.has('run_terminal'), 'run_terminal stays out').toBe(false);
    expect(
      grant.has('sandbox_exec'),
      'sandbox_exec stays out (coder-only, like the terminal)',
    ).toBe(false);
    // Hybrid (2026-07-18 delegation review): the persona holds the LIGHT
    // slices directly — create/draft/one-block page edits, table reads +
    // single-row writes — while heavy authoring stays delegated.
    expect(grant.has('page_create'), 'persona creates pages directly (pages-draft)').toBe(true);
    expect(grant.has('page_update_draft'), 'persona writes page DRAFTS directly').toBe(true);
    expect(grant.has('page_block_update'), 'persona does one-block fixes directly').toBe(true);
    expect(grant.has('table_sql'), 'persona answers from tables (tables-read)').toBe(true);
    expect(grant.has('table_row_add'), 'persona logs single rows directly (tables-rows)').toBe(
      true,
    );
    expect(
      grant.has('page_update'),
      'live-overwrite stays with Pages (persona is draft-only)',
    ).toBe(false);
    expect(grant.has('page_blocks_apply'), 'multi-block surgery stays with Pages').toBe(false);
    expect(grant.has('page_split'), 'structural splits stay with Pages').toBe(false);
    expect(grant.has('page_delete'), 'page delete is delegated to the Pages specialist').toBe(
      false,
    );
    expect(
      grant.has('table_from_text'),
      'grid building is delegated to the Ledger specialist',
    ).toBe(false);
    expect(grant.has('table_column_add'), 'schema work stays with Ledger').toBe(false);
    expect(grant.has('table_row_delete'), 'row deletes stay deliberate-only').toBe(false);
    expect(grant.has('contact_delete'), 'destructive contact delete is deliberate-only').toBe(
      false,
    );
    expect(grant.has('journal_delete'), 'destructive journal delete is deliberate-only').toBe(
      false,
    );
    expect(grant.has('invoke_agent'), 'persona must be able to delegate').toBe(true);
    expect(grant.has('page_share'), 'persona keeps page sharing').toBe(true);
    // Files: the persona CAN rename/update (non-destructive — closes the audit
    // gap where it couldn't anonymise a file), but holds no destructive file op.
    expect(grant.has('file_rename'), 'persona can rename files').toBe(true);
    expect(grant.has('folder_rename'), 'persona can rename folders').toBe(true);
    expect(grant.has('folder_describe'), 'persona can update folder descriptions').toBe(true);
    expect(grant.has('file_delete'), 'no destructive file delete exists/granted').toBe(false);
    // …and the Pages specialist DOES own page authoring (so delegation has a target).
    const pages = MANIFEST_AGENTS.find((a) => a.slug === 'pages')!;
    expect(effectiveTools(pages).has('page_create'), 'Pages agent authors pages').toBe(true);
  });

  it('the team responder is read-only + one hand-off, with the documented exclusions', () => {
    // The team-responder serves EXTERNAL members — its security boundary is that
    // team-read grants brain reads and nothing that writes, deletes, sends, or
    // bulk-exports. Its one hand-off (owner decision 2026-10-26) is
    // invoke_agent, to the workspace delegates only, which run with the
    // member's own rights (the delegation gateway). This guard fails CI if a
    // future edit re-adds a dangerous slug to its groups.
    const team = MANIFEST_AGENTS.find((a) => a.slug === 'team-responder')!;
    const grant = effectiveTools(team);
    expect(grant.has('invoke_agent'), 'it hands work to the workspace delegates').toBe(true);
    expect(team.memoryConfig?.delegate_to).toEqual([...WORKSPACE_DELEGATE_SLUGS]);
    // Everything else it holds is team-read's own.
    const own = effectiveTools({
      ...team,
      toolGroupSlugs: (team.toolGroupSlugs ?? []).filter((g) => g !== 'delegation'),
    });
    // No write at all since W7b: team_request_create was retired (a member
    // changes what it may edit, in its own scope).
    expect(grant.has('team_request_create'), 'no write tool').toBe(false);
    // Deliberate exclusions (see team-read group description).
    for (const forbidden of [
      'export_node', // bulk exfiltration ease
      'replay_window', // replays the OWNER's private conversations
      'invoke_agent', // no delegation of its own groups' (the `delegation` group alone)
      'run_terminal',
      'sandbox_exec',
      'email_send',
      'telegram_send',
      'page_share',
      'note_create', // no writes of any kind…
      'page_create',
      'table_create',
      'task_create', // members file requests via team_request_create, not raw tasks
      'contact_delete',
      'journal_delete',
    ]) {
      expect(own.has(forbidden), `team-read must NOT grant ${forbidden}`).toBe(false);
      if (forbidden !== 'invoke_agent') expect(grant.has(forbidden), forbidden).toBe(false);
    }
    // The private-corpus reads ARE in the group but gated at runtime by the
    // teamPrivateReads switch (run-team-turn.ts). They must stay present here so
    // the switch has something to gate — a regression that DROPS them would
    // silently make the switch a no-op.
    for (const gated of ['email_get', 'email_list', 'journal_get', 'journal_list']) {
      expect(grant.has(gated), `${gated} stays in team-read (runtime-gated, not removed)`).toBe(
        true,
      );
    }
    // Baseline brain-knowledge reads are always present.
    for (const read of ['search_chunks', 'read_section', 'file_read', 'page_get', 'table_query']) {
      expect(grant.has(read), `team member keeps ${read}`).toBe(true);
    }
  });

  it('no group or agent carries a level; the member-facing groups are not adminOnly, with a pinned tool list', async () => {
    // W8c: a level no longer says who may hold a group. What keeps a group's
    // tools to the Admin workspace is adminOnly (a turn outside Admin drops
    // it), so the Team assistant's own groups stay off that list, and what
    // they hold changes only on purpose, here.
    const { MANIFEST_ADMIN_ONLY_GROUPS } = await import('./manifest');
    for (const g of MANIFEST_TOOL_GROUPS) expect('level' in g, g.slug).toBe(false);
    for (const a of MANIFEST_AGENTS) expect('level' in a, a.slug).toBe(false);
    expect(MANIFEST_ADMIN_ONLY_GROUPS).not.toContain('team-read');
    expect(MANIFEST_ADMIN_ONLY_GROUPS).not.toContain('formulas-eval');
    expect(MANIFEST_ADMIN_ONLY_GROUPS).toContain('team-read-admin');
    expect(groupTools.get('formulas-eval')).toEqual([
      'formula_list',
      'formula_get',
      'formula_evaluate',
    ]);
    expect(groupTools.get('team-read')).toEqual([
      'search_nodes',
      'search_chunks',
      'read_section',
      'tree_list',
      'node_read',
      'folder_list',
      'folder_get_by_path',
      'file_list',
      'file_get',
      'file_read',
      'show_image',
      'note_list',
      'note_get',
      'page_list',
      'page_get',
      'page_blocks_list',
      'page_block_get',
      'table_list',
      'table_get',
      'table_schema',
      'table_query',
      'table_sql',
      'table_rows_list',
      'table_row_get',
      'table_aggregate',
      'app_db_list',
      'app_db_query',
      'summarize_text',
      'read_result',
    ]);
    // The reads a workspace other than Admin may never make stay in the
    // adminOnly group.
    const memberFacing = new Set([
      ...groupTools.get('team-read')!,
      ...groupTools.get('formulas-eval')!,
    ]);
    for (const slug of groupTools.get('team-read-admin')!) {
      expect(memberFacing.has(slug), `${slug} must not be in a member-facing group`).toBe(false);
    }
  });

  it('team-responder ships its adminOnly companion, which the Team assistant never gets back', async () => {
    // W8c: no level to lower. As the assistant of a workspace other than
    // Admin, reconcile never re-adds team-read-admin (groupsForAgent) and the
    // run drops it, so it keeps exactly its member-facing groups.
    const { MANIFEST_ADMIN_ONLY_GROUPS } = await import('./manifest');
    const { groupsForAgent } = await import('./reconcile-util');
    const team = MANIFEST_AGENTS.find((a) => a.slug === 'team-responder')!;
    const groups = team.toolGroupSlugs ?? [];
    const adminOnly = new Set(MANIFEST_ADMIN_ONLY_GROUPS);
    expect(groups.filter((g) => !adminOnly.has(g))).toEqual([
      'team-read',
      'formulas-eval',
      'delegation',
    ]);
    expect(groups.filter((g) => adminOnly.has(g))).toEqual(['team-read-admin']);
    expect(groupsForAgent(groups, { workspace: 'other', role: team.role }, adminOnly)).toEqual([
      'team-read',
      'formulas-eval',
      'delegation',
    ]);
  });

  it('every workspace assistant holds the content-kind groups: Present read and write, no delete, no spend, none adminOnly', async () => {
    const { ASSISTANT_CONTENT_KIND_GROUPS, MANIFEST_ADMIN_ONLY_GROUPS, PERSONA_TOOL_GROUP_SLUGS } =
      await import('./manifest');
    expect([...ASSISTANT_CONTENT_KIND_GROUPS]).toEqual(['present-read', 'present']);
    const adminOnly = new Set(MANIFEST_ADMIN_ONLY_GROUPS);
    for (const g of ASSISTANT_CONTENT_KIND_GROUPS) {
      // The persona holds them (a fresh brain's onboarding), and the
      // reconcile may add them to another workspace's assistant.
      expect(PERSONA_TOOL_GROUP_SLUGS, g).toContain(g);
      expect(adminOnly.has(g), `${g} is adminOnly`).toBe(false);
      for (const slug of groupTools.get(g) ?? []) {
        const policy = builtinPolicy(slug);
        expect(policy, slug).toBeDefined();
        // Rights come from the turn's login; the deliberate parts stay off:
        // a delete (present-admin) and a tool that spends (circuit_verify).
        expect(policy!.spends, `${slug} spends`).toBe('none');
        expect(
          policy!.matrix && 'action' in policy!.matrix ? policy!.matrix.action : null,
        ).not.toBe('delete');
      }
    }
    // As pages keep page-admin off the persona, present-admin and circuits stay off.
    expect(PERSONA_TOOL_GROUP_SLUGS).not.toContain('present-admin');
    expect(PERSONA_TOOL_GROUP_SLUGS).not.toContain('page-admin');
    expect(PERSONA_TOOL_GROUP_SLUGS).not.toContain('circuits');
  });

  it('the client chat is retired: no client agent or group ships, its tools are disabled (W5c)', () => {
    expect(MANIFEST_AGENTS.find((a) => a.slug === 'client-responder')).toBeUndefined();
    expect(MANIFEST_TOOL_GROUPS.find((g) => g.slug === 'client-read')).toBeUndefined();
    expect(RETIRED_TOOL_GROUP_SLUGS).toContain('client-read');
    const builtins = new Set(BUILTIN_TOOLS.map((t) => t.slug));
    for (const slug of [
      'client_shared_list',
      'client_shared_search',
      'client_shared_open',
      'client_request_create',
    ]) {
      expect(RETIRED_BUILTIN_TOOL_SLUGS, slug).toContain(slug);
      expect(builtins.has(slug), slug).toBe(false);
    }
  });

  it('seeded HTTP tools are well-formed, declare every placeholder, and use a vault ref', () => {
    const slugs = MANIFEST_HTTP_TOOLS.map((t) => t.slug);
    expect(new Set(slugs).size, 'duplicate HTTP tool slug').toBe(slugs.length);
    expect(MANIFEST_HTTP_TOOL_SLUGS).toEqual(slugs);
    for (const tool of MANIFEST_HTTP_TOOLS) {
      expect(tool.handler.kind, `${tool.slug} must be an http handler`).toBe('http');
      expect(tool.handler.url, `${tool.slug} url`).toMatch(/^https?:\/\//);
      expect(tool.description.trim().length, `${tool.slug} description`).toBeGreaterThan(0);
      const props = new Set(Object.keys((tool.inputSchema.properties as object) ?? {}));
      // Every {param} placeholder must be a declared input (else the model can
      // never fill it) — the same check the Toolsmith create path warns on.
      for (const p of collectParamNames(tool.handler)) {
        expect(props.has(p), `${tool.slug}: placeholder {${p}} is not in input_schema`).toBe(true);
      }
      // Auth rides a vault ref, never an inline key.
      expect(
        collectSecretRefs(tool.handler).length,
        `${tool.slug} must reference a vault key`,
      ).toBeGreaterThan(0);
    }
  });

  it('every seeded HTTP tool is bundled by at least one tool group (grantable)', () => {
    const inAGroup = new Set(MANIFEST_TOOL_GROUPS.flatMap((g) => g.toolSlugs));
    const orphans = MANIFEST_HTTP_TOOL_SLUGS.filter((s) => !inAGroup.has(s));
    expect(orphans, 'these HTTP tools belong to no group').toEqual([]);
  });

  it('mapbox_directions templates profile + coords into the path without corrupting the separators', () => {
    const tool = MANIFEST_HTTP_TOOLS.find((t) => t.slug === 'mapbox_directions')!;
    const req = buildHttpRequest(
      tool.handler,
      {
        profile: 'driving',
        from_longitude: 18.4241,
        from_latitude: -33.9249,
        to_longitude: 18.45,
        to_latitude: -33.9,
      },
      new Map([['mapbox/default', 'pk.TEST-KEY']]),
    );
    // The `,`/`;` separators must survive as literals (numbers URL-encode to
    // themselves) — a corrupted path is the classic failure mode here.
    expect(req.url).toContain('/directions/v5/mapbox/driving/18.4241,-33.9249;18.45,-33.9');
    expect(req.url).toContain('geometries=polyline'); // precision 5 → drops into the static path overlay
    expect(req.url).toContain('overview=simplified');
    expect(req.url).toContain('steps=true');
    expect(req.url).toContain('access_token=pk.TEST-KEY');
  });

  it('the persona holds the location group + skills (geo awareness + navigation ship on by default)', () => {
    const persona = MANIFEST_AGENTS.find((a) => a.isPersona)!;
    expect(persona.toolGroupSlugs ?? []).toContain('location');
    expect(persona.skillSlugs).toContain('location_awareness');
    expect(persona.skillSlugs).toContain('navigation');
    const grant = effectiveTools(persona);
    expect(grant.has('location_nearby')).toBe(true);
    expect(grant.has('mapbox_reverse_geocode')).toBe(true);
    // Routing: the directions HTTP tool + the route_map renderer come with the
    // location group, so the persona can find AND plot a route out of the box.
    expect(grant.has('mapbox_directions')).toBe(true);
    expect(grant.has('route_map')).toBe(true);
  });

  it('the persona can set the timezone (travel time-awareness ships on by default)', () => {
    const persona = MANIFEST_AGENTS.find((a) => a.isPersona)!;
    expect(persona.toolGroupSlugs ?? []).toContain('profile');
    expect(effectiveTools(persona).has('set_timezone')).toBe(true);
  });

  it('every skill has a non-empty instruction body', () => {
    for (const skill of MANIFEST_SKILLS) {
      expect(
        skill.instructions?.trim().length,
        `skill '${skill.slug}' has no instructions`,
      ).toBeGreaterThan(0);
    }
  });

  it('the tool_grounding skill teaches passage-first retrieval (search_chunks)', () => {
    // Guards the retrieval policy that stops the responder brute-forcing whole-file
    // reads instead of querying the chunk index. If someone drops this line, the
    // skill silently reverts to the old "search then read whole files" behaviour.
    const grounding = MANIFEST_SKILLS.find((s) => s.slug === 'tool_grounding');
    expect(grounding, 'tool_grounding skill missing from manifest').toBeDefined();
    expect(grounding!.instructions).toContain('search_chunks');
  });

  it('the writing_style skill carries the no-em-dash house style, attached to every prose agent', () => {
    // Guards the house-style rule: prose the model follows, not an output filter.
    // Dropping the rule text or detaching the skill silently reverts the fleet
    // to em-dash prose on the next reconcile.
    const style = MANIFEST_SKILLS.find((s) => s.slug === 'writing_style');
    expect(style, 'writing_style skill missing from manifest').toBeDefined();
    expect(style!.instructions).toContain('em dash');
    // The rule must keep its carve-out: range en dashes are correct and stay.
    expect(style!.instructions).toContain('2020–2024');
    for (const slug of ['assistant', 'pages', 'tables', 'team-responder']) {
      const agent = MANIFEST_AGENTS.find((a) => a.slug === slug);
      expect(agent, `agent '${slug}' missing from manifest`).toBeDefined();
      expect(agent!.skillSlugs, `agent '${slug}' does not attach writing_style`).toContain(
        'writing_style',
      );
    }
  });

  it('the page_editing skill teaches the restyle playbook (batched, insert-before TL;DR, wrap)', () => {
    // Guards the prose that turns "make this page presentable" into an actual
    // sequence: without it, agents have the dialect but no idea what a
    // presentable page looks like or how to get there safely.
    const editing = MANIFEST_SKILLS.find((s) => s.slug === 'page_editing');
    expect(editing, 'page_editing skill missing from manifest').toBeDefined();
    expect(editing!.instructions).toContain('restyle playbook');
    // The whole restyle lands as one atomic batch, not block-by-block surgery.
    expect(editing!.instructions).toContain('page_blocks_apply');
    // A top-of-page TL;DR goes in with the real insert-before tool. The old
    // update-then-re-insert workaround predates it and must stay retired.
    expect(editing!.instructions).toContain('page_block_insert_before');
    expect(editing!.instructions).not.toContain(
      "re-insert that block's original content immediately after it",
    );
    // Restyles fold existing blocks into containers with the wrap op, never
    // by re-emitting their content.
    expect(editing!.instructions).toContain("'wrap' op");
  });

  it("a retired prompt hash is never the agent's current default (no upgrade loop)", () => {
    const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
    for (const a of MANIFEST_AGENTS.filter((x) => !x.isPersona)) {
      const retired = a.retiredPromptSha256 ?? [];
      for (const h of retired) expect(h, a.slug).toMatch(/^[0-9a-f]{64}$/);
      expect(new Set(retired).size, `${a.slug}: duplicate retired hash`).toBe(retired.length);
      expect(retired, a.slug).not.toContain(sha(a.systemPrompt!));
    }
    // The persona's prompt is the operator's overlay: never upgraded.
    expect(MANIFEST_AGENTS.find((a) => a.isPersona)!.retiredPromptSha256).toBeUndefined();
  });

  // Owner decision 2026-10-26: every specialist lists ALL of its earlier
  // shipped defaults (prompts.ts history, and the pre-manifest seed scripts),
  // so an untouched old prompt follows the product on every box. Pinned so a
  // list is not dropped by accident; a prompt rewrite adds one to its count.
  it('every specialist carries its earlier shipped defaults', () => {
    const counts = Object.fromEntries(
      MANIFEST_AGENTS.filter((a) => !a.isPersona).map((a) => [
        a.slug,
        a.retiredPromptSha256?.length ?? 0,
      ]),
    );
    expect(counts).toMatchObject({
      pages: 15,
      tables: 5,
      diagrammer: 3,
      presenter: 0,
      remy: 3,
      researcher: 3,
      curator: 2,
      mathematician: 0,
      reader: 0,
      toolsmith: 5,
      coder: 2,
      appsmith: 4,
      'team-responder': 4,
      [DEFAULT_WORKER_SLUG]: 0,
    });
  });

  // The hashes must be the defaults that actually shipped, or the upgrade
  // silently never fires. Checked against the commits that shipped them when
  // the history is there (a shallow CI clone skips it). Every specialist's
  // list is checked by `pnpm -C server/web prompts:retired --check`, which
  // reads all of prompts.ts's history and the seed scripts (too slow for here).
  it('the retired team-responder hashes are the defaults git shipped', () => {
    const shipped: [string, string][] = [
      // 2026-07-05, the 1:1 portal chat
      ['0f4b2246f72b9136e2374930b72fd04a79880da3', 'apps/web'],
      // 2026-07-17, the forum
      ['5dc930df4bca33f1c7025b25f296857ffc24d9ef', 'apps/web'],
      // v0.239.95, the member chat with team_request_create (retired in W7b)
      ['c71f3636a', 'server/web'],
      // v0.232.295, the Phase 6 member-chat default, before W6b reworded it
      ['88ec82984', 'server/web'],
      // v0.400.11, read-only with no hand-off (before workspace delegation)
      ['e600bec62', 'server/web'],
    ];
    const src = ([sha, dir]: [string, string]): string | null => {
      try {
        return execSync(`git show ${sha}:${dir}/lib/system-manifest/prompts.ts`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 1e8,
        });
      } catch {
        return null;
      }
    };
    const sources = shipped.map(src);
    if (sources.some((x) => x === null)) return; // no history here
    const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
    const hashes = sources.map((text) => {
      const file = text!;
      const start = file.indexOf("'team-responder': `") + "'team-responder': `".length;
      let raw = '';
      for (let i = start; file.charAt(i) !== '`'; i++) {
        raw += file.charAt(i) === '\\' ? file.charAt(i) + file.charAt(++i) : file.charAt(i);
      }
      // The template literal's own escapes (\` only), as the compiler reads them.
      return sha(raw.replace(/\\`/g, '`'));
    });
    const def = MANIFEST_AGENTS.find((a) => a.slug === 'team-responder')!;
    expect([...def.retiredPromptSha256!].sort()).toEqual([...hashes].sort());
  });

  it('the team responder prompt is about member chat: no forum, no portal', () => {
    const p = MANIFEST_AGENTS.find((a) => a.slug === 'team-responder')!.systemPrompt!;
    expect(p).not.toMatch(/forum|topic|1:1|portal|team code/i);
    expect(p).toMatch(/member login/);
    // Retired in W7b: the responder files no request any more.
    expect(p).not.toMatch(/team_request_create/);
    expect(p).not.toMatch(/\u2014/); // house style: no em dashes
  });

  it('the workspace delegates: Draftsman, Presenter and Appsmith, shipped delegates with no adminOnly group', async () => {
    // Owner decision 2026-10-26. The gateway's one list (@mantle/tools),
    // re-exported here: a change to it is a change of who a workspace
    // assistant may hand work to, made here on purpose.
    const { MANIFEST_ADMIN_ONLY_GROUPS, WORKSPACE_DELEGATION_GROUP } = await import('./manifest');
    expect([...WORKSPACE_DELEGATE_SLUGS]).toEqual(['diagrammer', 'presenter', 'appsmith']);
    expect(WORKSPACE_DELEGATE_SLUGS).not.toContain('toolsmith');
    for (const slug of WORKSPACE_DELEGATE_SLUGS) {
      const a = MANIFEST_AGENTS.find((x) => x.slug === slug);
      expect(a?.isDelegate, `${slug} is a shipped delegate`).toBe(true);
      for (const g of a!.toolGroupSlugs ?? []) {
        expect(MANIFEST_ADMIN_ONLY_GROUPS, `${slug} holds no adminOnly group (${g})`).not.toContain(
          g,
        );
      }
    }
    // The group granted with them holds invoke_agent alone, and runs outside Admin.
    expect(WORKSPACE_DELEGATION_GROUP).toBe('delegation');
    expect(groupTools.get('delegation')).toEqual(['invoke_agent']);
    expect(MANIFEST_ADMIN_ONLY_GROUPS).not.toContain('delegation');
  });

  it('every specialist agent has a system prompt; the persona has none (persona-bank)', () => {
    for (const agent of MANIFEST_AGENTS) {
      if (agent.isPersona) {
        expect(
          agent.systemPrompt,
          `persona '${agent.slug}' should not carry a manifest prompt`,
        ).toBeUndefined();
      } else {
        expect(
          agent.systemPrompt?.trim().length,
          `agent '${agent.slug}' has no system prompt`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('ships the default runner-queue worker agent, single-sourced from @mantle/runs (WP-E)', () => {
    const worker = MANIFEST_AGENTS.find((a) => a.slug === DEFAULT_WORKER_SLUG);
    expect(worker, 'the worker template must live in the manifest').toBeDefined();
    // role 'worker': never chattable, instantiated per run item.
    expect(worker!.role).toBe('worker');
    // model = the inherit sentinel (run on the responder's route at execution).
    expect(worker!.model).toBe(WORKER_MODEL_INHERIT);
    // Constants come from ONE source (the engine's worker.ts), not re-typed.
    expect(worker!.systemPrompt).toBe(WORKER_SYSTEM_PROMPT);
    expect(worker!.toolGroupSlugs).toEqual([...WORKER_TOOL_GROUP_SLUGS]);
    // Its tool groups must be real manifest groups (memory-core).
    for (const g of worker!.toolGroupSlugs ?? []) {
      expect(KNOWN_TOOL_GROUP_SLUGS.has(g), `worker group '${g}' is a manifest group`).toBe(true);
    }
    // Propose-don't-mutate: never a delegate, no persona.
    expect(worker!.isDelegate ?? false).toBe(false);
    expect(worker!.isPersona ?? false).toBe(false);
    // Not a delegation target (workers are invoked by the run engine, never via
    // invoke_agent), so it must NOT appear in the persona's delegate set.
    expect(DELEGATE_SLUGS).not.toContain(DEFAULT_WORKER_SLUG);
  });

  it('has the required always-on memory workers', () => {
    const required = MANIFEST_WORKERS.filter((w) => w.required).map((w) => w.kind);
    for (const kind of ['extractor', 'summarizer', 'reflector', 'document']) {
      expect(required, `worker '${kind}' must be required`).toContain(kind);
    }
  });
});

/**
 * `mcpOnly` builtins are the OWNER's operator surface — the approval queue, the
 * runner panels, the Telegram inbox, the file/note deletes. They live in the
 * builtin registry so the MCP transports run one tested implementation, and
 * that is exactly what makes this guard necessary: a builtin is the thing a
 * tool group grants. An agent holding `pending_approve` would approve its own
 * gated call, which is the gate the pending row exists to impose.
 *
 * KNOWN_TOOL_SLUGS is the set a manifest group may name, so filtering these out
 * of it makes a group that names one fail the drift test above rather than ship.
 */
describe('every manifest tool group has a flow (A5 step 6d)', () => {
  // The deferred catalog lists a granted tool under its group's flow
  // (selection/flows.ts TOOL_FLOWS); a group no flow holds gets a line of
  // its own, as an owner's connector does. A group the manifest ships is
  // named in a flow, so a new one cannot land outside them unnoticed
  // (gateway survey finding 14: app-data-mcp was missing).
  it('names each manifest group in TOOL_FLOWS', () => {
    expect(
      MANIFEST_TOOL_GROUPS.filter((g) => knownFlowForGroup(g.slug) === null).map((g) => g.slug),
    ).toEqual([]);
  });
});

describe('mcpOnly builtins are not grantable', () => {
  const mcpOnly = BUILTIN_TOOLS.filter((t) => t.mcpOnly).map((t) => t.slug);

  it('there are some — the flag has not been silently dropped', () => {
    expect(mcpOnly.length).toBeGreaterThan(0);
  });

  it('none of them is a slug the manifest may reference', () => {
    const leaked = mcpOnly.filter((slug) => KNOWN_TOOL_SLUGS.has(slug));
    expect(leaked, `mcpOnly builtins a manifest group could name: ${leaked.join(', ')}`).toEqual(
      [],
    );
  });

  it('no manifest tool group actually bundles one', () => {
    const bundled = MANIFEST_TOOL_GROUPS.flatMap((g) =>
      g.toolSlugs.filter((slug) => mcpOnly.includes(slug)).map((slug) => `${g.slug}: ${slug}`),
    );
    expect(bundled).toEqual([]);
  });
});

describe('adminOnly tool groups (workspaces W4b)', () => {
  it('the manifest list names manifest groups, and migration 0254 backfilled the same slugs', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { MANIFEST_ADMIN_ONLY_GROUPS } = await import('./manifest');
    const groupSlugs = new Set(MANIFEST_TOOL_GROUPS.map((g) => g.slug));
    const { RETIRED_TOOL_GROUP_SLUGS } = await import('./manifest');
    for (const slug of MANIFEST_ADMIN_ONLY_GROUPS) {
      expect(groupSlugs.has(slug) || RETIRED_TOOL_GROUP_SLUGS.includes(slug), slug).toBe(true);
    }
    const sqlText = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'packages',
        'db',
        'migrations',
        '0254_workspaces_turns.sql',
      ),
      'utf8',
    );
    const list = sqlText.match(/WHERE "slug" IN \(([^)]*)\)/)![1]!;
    const migrated = [...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect([...migrated].sort()).toEqual([...MANIFEST_ADMIN_ONLY_GROUPS].sort());
    // The Team assistant's own groups are never adminOnly.
    for (const slug of ['team-read', 'formulas-eval']) {
      expect(MANIFEST_ADMIN_ONLY_GROUPS).not.toContain(slug);
    }
  });
});

describe('the manifest stays data (A5 step 6d fix round 1)', () => {
  it('its data modules read the runtime only through its leaf data modules', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['./manifest.ts', './reconcile-util.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      const runtime = [...text.matchAll(/from '(@mantle\/runtime[^']*)'/g)].map((m) => m[1]);
      for (const spec of runtime) {
        expect(['@mantle/runtime/slugs', '@mantle/runtime/heartbeats/specs'], file).toContain(spec);
      }
    }
  });
});
