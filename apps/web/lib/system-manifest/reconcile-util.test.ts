import { describe, expect, it } from 'vitest';
import { convergeManifestSkills, missingPersonaGroups } from './reconcile-util';

describe('missingPersonaGroups', () => {
  it('returns the manifest groups the agent does not yet hold', () => {
    expect(missingPersonaGroups(['location'], ['location', 'profile'])).toEqual(['profile']);
  });

  it('is empty when the agent already holds every manifest group', () => {
    expect(missingPersonaGroups(['a', 'b', 'c'], ['a', 'b'])).toEqual([]);
  });

  it('only ADDS — never proposes removing an operator-held group not in the manifest', () => {
    // The operator added 'custom-group' and removed default 'email'.
    const result = missingPersonaGroups(
      ['location', 'custom-group'],
      ['location', 'email', 'profile'],
    );
    expect(result).toEqual(['email', 'profile']); // re-adds the removed default + the new one
    expect(result).not.toContain('custom-group'); // never touches operator extras
  });

  it('treats null/undefined current grants as empty', () => {
    expect(missingPersonaGroups(null, ['location'])).toEqual(['location']);
    expect(missingPersonaGroups(undefined, ['location'])).toEqual(['location']);
  });
});

describe('convergeManifestSkills', () => {
  // The manifest owns these slugs; anything else attached is operator-authored.
  const owned = new Set(['tool_grounding', 'chat_writing', 'rich_writing', 'voice_reply']);

  it('drops a manifest-owned skill the agent no longer wants (the rich_writing case)', () => {
    // Persona carried rich_writing; manifest now wants chat_writing instead.
    const next = convergeManifestSkills(
      ['tool_grounding', 'rich_writing'],
      ['tool_grounding', 'chat_writing'],
      owned,
    );
    expect(next).toEqual(['tool_grounding', 'chat_writing']);
    expect(next).not.toContain('rich_writing');
  });

  it('never drops an operator-authored skill (not manifest-owned)', () => {
    const next = convergeManifestSkills(
      ['rich_writing', 'my_custom_skill'],
      ['chat_writing'],
      owned,
    );
    // rich_writing (manifest-owned, unwanted) dropped; custom skill kept; chat_writing added.
    expect(next).toEqual(['my_custom_skill', 'chat_writing']);
  });

  it('adds a newly-wanted manifest skill, keeping order: kept then added', () => {
    const next = convergeManifestSkills(
      ['tool_grounding'],
      ['tool_grounding', 'voice_reply'],
      owned,
    );
    expect(next).toEqual(['tool_grounding', 'voice_reply']);
  });

  it('is a no-op when current already matches wanted', () => {
    const cur = ['tool_grounding', 'chat_writing'];
    expect(convergeManifestSkills(cur, ['tool_grounding', 'chat_writing'], owned)).toEqual(cur);
  });

  it('only attaches wanted skills present in `addable` (row exists + enabled)', () => {
    // voice_reply is wanted but its row is missing/disabled → not attachable yet.
    const next = convergeManifestSkills(
      ['tool_grounding'],
      ['tool_grounding', 'voice_reply'],
      owned,
      ['tool_grounding'], // addable excludes voice_reply
    );
    expect(next).toEqual(['tool_grounding']);
  });

  it('does NOT drop a wanted skill just because it is absent from `addable` (disabled)', () => {
    // chat_writing is wanted + already attached but currently disabled (not addable).
    const next = convergeManifestSkills(
      ['tool_grounding', 'chat_writing'],
      ['tool_grounding', 'chat_writing'],
      owned,
      ['tool_grounding'], // addable excludes chat_writing
    );
    expect(next).toEqual(['tool_grounding', 'chat_writing']);
  });

  it('treats null/undefined current as empty', () => {
    expect(convergeManifestSkills(null, ['chat_writing'], owned)).toEqual(['chat_writing']);
    expect(convergeManifestSkills(undefined, [], owned)).toEqual([]);
  });

  it('converging to an empty wanted set strips all manifest-owned skills, keeps operator ones', () => {
    expect(convergeManifestSkills(['rich_writing', 'custom'], [], owned)).toEqual(['custom']);
  });
});
