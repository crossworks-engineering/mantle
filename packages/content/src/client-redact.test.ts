/**
 * The client's view of a page or a note (client logins C2, plan N6): a
 * reference to an item the client may not read never carries its title or
 * its id to the client. Pure: `readable` stands in for the database answer.
 */
import { describe, expect, it } from 'vitest';
import { CLIENT_PRIVATE_LABEL } from '@mantle/client-types/dto/client';
import { docRefIds, noteRefIds, redactClientDoc, redactClientNote } from './client-redact';

const OK = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const OK2 = '44444444-4444-4444-8444-444444444444';
const readable = new Set([OK, OK2]);

const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string, ...marks: unknown[]) => ({
  type: 'text',
  text: t,
  ...(marks.length ? { marks } : {}),
});
const link = (href: string) => ({ type: 'link', attrs: { href } });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const json = (v: unknown) => JSON.stringify(v);

describe('redactClientDoc', () => {
  it('labels a mention chip of a hidden item "Private item" and drops its id', () => {
    const out = redactClientDoc(
      doc(para({ type: 'mention', attrs: { id: TEAM, label: 'Team roadmap', ref: 'node' } })),
      readable,
    );
    expect(out).toEqual(
      doc(
        para({
          type: 'mention',
          attrs: { id: null, label: CLIENT_PRIVATE_LABEL, ref: null, kind: null },
        }),
      ),
    );
  });

  it('labels an entity mention too: entities are never client items', () => {
    const out = json(
      redactClientDoc(
        doc(para({ type: 'mention', attrs: { id: 'ent-1', label: 'Supplier X', ref: 'entity' } })),
        readable,
      ),
    );
    expect(out).not.toContain('Supplier X');
    expect(out).not.toContain('ent-1');
    expect(out).toContain(CLIENT_PRIVATE_LABEL);
  });

  it('turns a link to a hidden item into plain "Private item", once per link', () => {
    const out = redactClientDoc(
      doc(
        para(
          text('See '),
          text('Team ', link(`/n/${TEAM}`), { type: 'bold' }),
          text('roadmap', link(`/n/${TEAM}`)),
          text(' and '),
          text('this', link(`page:${ADMIN}`)),
        ),
      ),
      readable,
    );
    expect(out).toEqual(
      doc(
        para(
          text('See '),
          text(CLIENT_PRIVATE_LABEL, { type: 'bold' }),
          text(' and '),
          text(CLIENT_PRIVATE_LABEL),
        ),
      ),
    );
  });

  it('leaves out an embed of a hidden item, and fills a container it emptied', () => {
    const out = redactClientDoc(
      doc(
        { type: 'image', attrs: { nodeId: TEAM, alt: 'Team chart' } },
        { type: 'childPage', attrs: { pageId: ADMIN, title: 'Admin notes' } },
        { type: 'fileEmbed', attrs: { nodeId: OK, filename: 'shared.pdf' } },
        { type: 'image', attrs: { src: `/api/files/files/${TEAM}?raw=1` } },
        { type: 'image', attrs: { src: 'https://example.invalid/logo.png' } },
        { type: 'blockquote', content: [{ type: 'image', attrs: { drawId: TEAM } }] },
      ),
      readable,
    );
    expect(out).toEqual(
      doc(
        { type: 'fileEmbed', attrs: { nodeId: OK, filename: 'shared.pdf' } },
        { type: 'image', attrs: { src: 'https://example.invalid/logo.png' } },
        { type: 'blockquote', content: [{ type: 'paragraph' }] },
      ),
    );
    expect(json(out)).not.toContain('Team chart');
    expect(json(out)).not.toContain('Admin notes');
  });

  it('keeps every reference to a readable item exactly as it was', () => {
    const input = doc(
      para(
        { type: 'mention', attrs: { id: OK, label: 'Shared plan', ref: 'node' } },
        text('open', link(`/n/${OK2}`)),
        text('site', link('https://example.invalid/')),
      ),
      { type: 'image', attrs: { nodeId: OK } },
      { type: 'childPage', attrs: { pageId: OK2, title: 'Shared child' } },
    );
    const before = json(input);
    expect(redactClientDoc(input, readable)).toEqual(input);
    expect(json(input)).toBe(before); // the input is not changed
  });

  it('reaches references nested in lists, tables, callouts and columns', () => {
    const out = json(
      redactClientDoc(
        doc({
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('Admin title', link(`/n/${ADMIN}`))),
                {
                  type: 'table',
                  content: [
                    {
                      type: 'tableRow',
                      content: [
                        {
                          type: 'tableCell',
                          content: [
                            {
                              type: 'callout',
                              content: [
                                para({
                                  type: 'mention',
                                  attrs: { id: TEAM, label: 'Deep secret', ref: 'node' },
                                }),
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        readable,
      ),
    );
    expect(out).not.toContain('Admin title');
    expect(out).not.toContain('Deep secret');
    expect(out).not.toContain(TEAM);
    expect(out).not.toContain(ADMIN);
  });

  it('collects the ids to ask about', () => {
    expect(
      docRefIds(doc(para(text('x', link(`/n/${TEAM}`))), { type: 'image', attrs: { nodeId: OK } })).sort(),
    ).toEqual([OK, TEAM].sort());
  });
});

describe('redactClientNote', () => {
  it('turns a /n/ link to a hidden item into "Private item"', () => {
    expect(redactClientNote(`Read [Team roadmap](/n/${TEAM}) first.`, readable)).toBe(
      `Read ${CLIENT_PRIVATE_LABEL} first.`,
    );
  });

  it('handles every internal form: mention, page, media, draw, a title, angle brackets', () => {
    const md = [
      `[Pat Lee](mention:node:${TEAM})`,
      `[Plan](page:${ADMIN} "Admin plan")`,
      `![Chart](media:${TEAM})`,
      `![Sketch](draw:${ADMIN})`,
      `[Spec](</n/${TEAM}>)`,
      `[Who](mention:entity:ent-9)`,
    ].join('\n\n');
    const out = redactClientNote(md, readable);
    for (const s of ['Pat Lee', 'Plan', 'Admin plan', 'Chart', 'Sketch', 'Spec', 'Who', TEAM, ADMIN]) {
      expect(out).not.toContain(s);
    }
    expect(out.split(CLIENT_PRIVATE_LABEL).length - 1).toBe(4);
  });

  it('keeps readable and external links untouched', () => {
    const md = `[Shared](/n/${OK}) and ![pic](media:${OK2}) and [site](https://example.invalid)`;
    expect(redactClientNote(md, readable)).toBe(md);
  });

  it('falls back to the document path for a form the line pass misses', () => {
    const md = `See [the [team] roadmap][r] now.\n\n[r]: /n/${TEAM}\n`;
    const out = redactClientNote(md, readable);
    expect(out).not.toContain('roadmap');
    expect(out).not.toContain(TEAM);
    expect(out).toContain(CLIENT_PRIVATE_LABEL);
    expect(noteRefIds(out)).toEqual([]);
  });
});
