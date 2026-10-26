/**
 * The boot reconcile's two Phase 6 steps on Postgres:
 *
 *   - upgradeUneditedPrompts: a specialist whose prompt is still an earlier
 *     shipped default gets the current default, through the Studio's prose
 *     versioning (the old text is v1, one revert away), a disabled one too,
 *     and one whose history holds only earlier upgrades; an edited prompt and
 *     an already-current one are left alone; the persona is filtered out even
 *     when given a retired list here; a Studio revert to the old default (or
 *     an edit, then a revert to the original) sticks across a version bump;
 *     a second run does nothing.
 *   - disableRetiredManifestItems: the retired `team-notify` group and the
 *     builtin `team_member_list` / `team_notify` / `my_app_share` rows are
 *     disabled; an operator's own http tool that shares a slug is not.
 *
 * The real retired hashes are checked against git history (manifest.test.ts,
 * and scripts/retired-prompt-hashes.ts for every specialist);
 * here one synthetic old default is added to them, so the brains can be seeded
 * without copying an old prompt into the test.
 * Seeds its own brain rows; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/prompt-upgrade.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const OLD = 'You are the Team Responder. A default from an earlier release.';
// One synthetic earlier default per specialist under test.
const OLD_BY_SLUG: Record<string, string> = {
  'team-responder': OLD,
  diagrammer: 'You are "Draftsman". A default from an earlier release.',
  appsmith: 'You are "Appsmith". A default from an earlier release.',
};

// The running version, bumped by a test (APP_VERSION is read per call).
const version = vi.hoisted(() => ({ app: '0.400.12' }));
vi.mock('@mantle/client-types/version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/client-types/version')>()),
  get APP_VERSION() {
    return version.app;
  },
}));

vi.mock('./manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./manifest')>();
  const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
  return {
    ...actual,
    // The persona gets a retired list and a default here too (the real one
    // has neither), so the test shows the upgrade's persona filter, not a
    // missing list, keeps its prompt.
    MANIFEST_AGENTS: actual.MANIFEST_AGENTS.map((a) =>
      OLD_BY_SLUG[a.slug] || a.isPersona
        ? {
            ...a,
            ...(a.isPersona ? { systemPrompt: 'A persona default from this release.' } : {}),
            retiredPromptSha256: [
              ...(a.retiredPromptSha256 ?? []),
              sha(OLD_BY_SLUG[a.slug] ?? OLD),
            ],
          }
        : a,
    ),
  };
});

type Row = Record<string, unknown>;

describe.skipIf(!URL)('reconcile: unedited prompts and retired items', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let rec: typeof import('./reconcile');
  let current = '';
  const brains = {
    unedited: randomUUID(),
    edited: randomUUID(),
    fresh: randomUUID(),
    reverted: randomUUID(),
    editedBack: randomUUID(),
    upgradedBefore: randomUUID(),
  };
  const EDITED = `${OLD} Always answer in Afrikaans.`;

  const agentOf = async (owner: string, slug = 'team-responder') =>
    (
      await admin<Row[]>`select id, system_prompt from agents
                          where owner_id = ${owner} and slug = ${slug}`
    )[0]!;
  const currentOf = async (slug: string) =>
    (await import('./manifest')).MANIFEST_AGENTS.find((a) => a.slug === slug)!.systemPrompt!;
  const versionsOf = async (agentId: unknown) =>
    admin<Row[]>`select version, body, note from prompt_versions
                  where entity_type = 'agent' and entity_id = ${agentId as string}
                    and field = 'system_prompt' order by version`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    rec = await import('./reconcile');
    current = (await import('./manifest')).MANIFEST_AGENTS.find(
      (a) => a.slug === 'team-responder',
    )!.systemPrompt!;
    const prompts = {
      unedited: OLD,
      edited: EDITED,
      fresh: current,
      reverted: OLD,
      editedBack: OLD,
      upgradedBefore: OLD,
    };
    for (const [k, owner] of Object.entries(brains)) {
      await asSuperuser()`insert into auth.users (id, email, password_hash, role)
                  values (${owner}, ${`pu-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
      await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
      await admin`insert into agents (owner_id, slug, name, model, system_prompt)
                  values (${owner}, 'team-responder', 'Team Responder', 'test/model',
                          ${prompts[k as keyof typeof prompts]})`;
    }
    // A brain an earlier release already upgraded once (from a still older
    // default to OLD): its history is the upgrade's own rows, the note as
    // the fleet holds it, so it keeps following the product.
    const ub = await agentOf(brains.upgradedBefore);
    await admin`insert into prompt_versions (owner_id, entity_type, entity_id, field, version, body, note)
                values (${brains.upgradedBefore}, 'agent', ${ub.id as string}, 'system_prompt', 1,
                        'An even older default.', '(original)'),
                       (${brains.upgradedBefore}, 'agent', ${ub.id as string}, 'system_prompt', 2,
                        ${OLD}, 'Shipped default updated on upgrade to v0.232.295 (the prompt was unedited).')`;
    // The other specialists on the unedited brain: a DISABLED Draftsman still
    // on an old default (upgraded all the same), an Appsmith the owner edited
    // (kept), and the persona holding a retired default's exact text, with
    // a retired list and a default the mock above gave it (the persona's
    // prompt is the operator's overlay: never touched).
    const u0 = brains.unedited;
    await admin`insert into agents (owner_id, slug, name, model, system_prompt, enabled)
                values (${u0}, 'diagrammer', 'Draftsman', 'test/model',
                        ${OLD_BY_SLUG.diagrammer!}, false)`;
    await admin`insert into agents (owner_id, slug, name, model, system_prompt)
                values (${u0}, 'appsmith', 'Appsmith', 'test/model',
                        ${`${OLD_BY_SLUG.appsmith!} Prefer dark themes.`})`;
    await admin`insert into agents (owner_id, slug, name, role, model, system_prompt)
                values (${u0}, 'assistant', 'Assistant', 'responder', 'test/model', ${OLD})`;
    // Retired items: on the unedited brain, the builtin rows and the group; on
    // the edited brain, an operator's own http tool that shares a slug.
    const u = brains.unedited;
    await admin`insert into tool_groups (owner_id, slug, name, tool_slugs)
                values (${u}, 'team-notify', 'Team notifications',
                        ${['team_member_list', 'team_notify']})`;
    // my_app_share: a builtin row an older brain seeded, no handler since N1.
    for (const slug of ['team_member_list', 'team_notify', 'my_app_share']) {
      await admin`insert into tools (owner_id, slug, name, description, handler)
                  values (${u}, ${slug}, ${slug}, 'x', ${JSON.stringify({ kind: 'builtin', ref: slug })}::jsonb)`;
    }
    await admin`insert into tools (owner_id, slug, name, description, handler)
                values (${brains.edited}, 'team_notify', 'My notifier', 'x',
                        ${JSON.stringify({ kind: 'http', url: 'https://example.invalid' })}::jsonb)`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const owners = Object.values(brains);
    await admin`delete from prompt_versions where owner_id in ${admin(owners)}`;
    await admin`delete from tools where owner_id in ${admin(owners)}`;
    await admin`delete from tool_groups where owner_id in ${admin(owners)}`;
    await admin`delete from agents where owner_id in ${admin(owners)}`;
    await admin`delete from spaces where id in ${admin(owners)}`;
    await admin`delete from auth.users where id in ${admin(owners)}`;
    await m.closeDb();
  });

  it('moves an unedited default to the current one, keeping the old as v1', async () => {
    expect((await rec.upgradeUneditedPrompts(brains.unedited)).sort()).toEqual([
      'diagrammer',
      'team-responder',
    ]);
    const a = await agentOf(brains.unedited);
    expect(a.system_prompt).toBe(current);
    const v = await versionsOf(a.id);
    expect(v.map((r) => [r.version, r.body])).toEqual([
      [1, OLD],
      [2, current],
    ]);
    expect(String(v[1]!.note)).toBe(
      'Shipped default updated on upgrade to v0.400.12 (the prompt was unedited).',
    );
    // The disabled Draftsman moved too, the same way.
    const d = await agentOf(brains.unedited, 'diagrammer');
    const draftsman = await currentOf('diagrammer');
    expect(d.system_prompt).toBe(draftsman);
    expect((await versionsOf(d.id)).map((r) => [r.version, r.body])).toEqual([
      [1, OLD_BY_SLUG.diagrammer],
      [2, draftsman],
    ]);
  });

  it("keeps an edited specialist's prompt, and the persona's even with a retired list", async () => {
    const app = await agentOf(brains.unedited, 'appsmith');
    expect(app.system_prompt).toBe(`${OLD_BY_SLUG.appsmith!} Prefer dark themes.`);
    expect(await versionsOf(app.id)).toEqual([]);
    const persona = await agentOf(brains.unedited, 'assistant');
    expect(persona.system_prompt).toBe(OLD);
    expect(await versionsOf(persona.id)).toEqual([]);
  });

  it('keeps an edited prompt, and one that is already current', async () => {
    expect(await rec.upgradeUneditedPrompts(brains.edited)).toEqual([]);
    expect(await rec.upgradeUneditedPrompts(brains.fresh)).toEqual([]);
    const e = await agentOf(brains.edited);
    expect(e.system_prompt).toBe(EDITED);
    expect(await versionsOf(e.id)).toEqual([]);
    expect((await agentOf(brains.fresh)).system_prompt).toBe(current);
  });

  it('a brain whose history is only earlier upgrades still moves', async () => {
    expect(await rec.upgradeUneditedPrompts(brains.upgradedBefore)).toEqual(['team-responder']);
    const a = await agentOf(brains.upgradedBefore);
    expect(a.system_prompt).toBe(current);
    expect((await versionsOf(a.id)).map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it('a Studio revert to the old default sticks across a version bump', async () => {
    const { revertProse } = await import('../studio/prompt-versions');
    const owner = brains.reverted;
    expect(await rec.upgradeUneditedPrompts(owner)).toEqual(['team-responder']);
    const a = await agentOf(owner);
    expect(a.system_prompt).toBe(current);
    // What the Studio's revert route does: the signed-in owner is the author.
    await revertProse({
      ownerId: owner,
      entityType: 'agent',
      entityId: a.id as string,
      field: 'system_prompt',
      toVersion: 1,
      author: owner,
    });
    expect((await agentOf(owner)).system_prompt).toBe(OLD);
    const before = version.app;
    version.app = '0.400.13';
    try {
      expect(await rec.upgradeUneditedPrompts(owner)).toEqual([]);
    } finally {
      version.app = before;
    }
    expect((await agentOf(owner)).system_prompt).toBe(OLD);
    expect((await versionsOf(a.id)).map((r) => [r.version, r.body])).toEqual([
      [1, OLD],
      [2, current],
      [3, OLD],
    ]);
  });

  it('an owner edit, then a revert to the original text, sticks', async () => {
    const { saveProse, revertProse } = await import('../studio/prompt-versions');
    const owner = brains.editedBack;
    const a = await agentOf(owner);
    const at = { ownerId: owner, entityType: 'agent', entityId: a.id as string } as const;
    await saveProse({ ...at, field: 'system_prompt', body: EDITED, author: owner });
    await revertProse({ ...at, field: 'system_prompt', toVersion: 1, author: owner });
    expect((await agentOf(owner)).system_prompt).toBe(OLD);
    expect(await rec.upgradeUneditedPrompts(owner)).toEqual([]);
    expect((await agentOf(owner)).system_prompt).toBe(OLD);
    expect(await versionsOf(a.id)).toHaveLength(3);
  });

  it('a second run changes nothing', async () => {
    expect(await rec.upgradeUneditedPrompts(brains.unedited)).toEqual([]);
    expect(await versionsOf((await agentOf(brains.unedited)).id)).toHaveLength(2);
  });

  it('disables the retired group and builtin tools, not an operator tool', async () => {
    expect((await rec.disableRetiredManifestItems(brains.unedited)).sort()).toEqual([
      'group team-notify',
      'tool my_app_share',
      'tool team_member_list',
      'tool team_notify',
    ]);
    const owners = [brains.unedited, brains.edited];
    const rows = await admin<Row[]>`
      select owner_id, slug, enabled from tools
       where owner_id in ${admin(owners)} order by owner_id, slug`;
    const enabled = Object.fromEntries(rows.map((r) => [`${r.owner_id}:${r.slug}`, r.enabled]));
    expect(enabled[`${brains.unedited}:team_member_list`]).toBe(false);
    expect(enabled[`${brains.unedited}:team_notify`]).toBe(false);
    expect(enabled[`${brains.unedited}:my_app_share`]).toBe(false);
    expect(await rec.disableRetiredManifestItems(brains.edited)).toEqual([]);
    expect(enabled[`${brains.edited}:team_notify`]).toBe(true);
    const [g] = await admin<Row[]>`select enabled from tool_groups
                                    where owner_id = ${brains.unedited} and slug = 'team-notify'`;
    expect(g!.enabled).toBe(false);
    expect(await rec.disableRetiredManifestItems(brains.unedited)).toEqual([]);
  });
});
