/**
 * The Sync sidecar's Microsoft parts that need no network (Sync service plan
 * M3): the drive listing's lines, the choice of what a drive run fetches,
 * re-links and removes, the selections, the branch names, the Outlook
 * message mapping and the choice of the account that sends.
 */
import { describe, expect, it } from 'vitest';
import {
  FILE_MAX_BYTES,
  goneIds,
  parseLsjsonLine,
  pickHash,
  planItem,
  type MapRow,
  type Plan,
} from './files';
import { driveLabel, inSelections, itemPathOf, msBranchPath } from './microsoft';
import { normalize } from './outlook';
import { outlookSenderFor } from './send';
import type { MsAccount } from './state';

const plan = (): Plan => ({ fetch: [], relink: [], seen: new Set(), oversize: 0 });

describe("rclone lsjson's lines", () => {
  it('reads a file with its id and QuickXorHash, and skips the array lines', () => {
    expect(parseLsjsonLine('[')).toBeNull();
    expect(parseLsjsonLine(']')).toBeNull();
    expect(parseLsjsonLine('')).toBeNull();
    const item = parseLsjsonLine(
      '{"Path":"Reports/2026/q1.xlsx","Name":"q1.xlsx","Size":1200,"ModTime":"2026-11-01T10:00:00Z","IsDir":false,"ID":"01ABC","Hashes":{"quickxor":"qx=="}},',
    );
    expect(item).toEqual({
      id: '01ABC',
      path: '/Reports/2026/q1.xlsx',
      name: 'q1.xlsx',
      size: 1200,
      modTime: '2026-11-01T10:00:00Z',
      hash: 'quickxor:qx==',
    });
  });

  it('skips a folder, stands a path in for a missing id, and flags a broken line', () => {
    expect(parseLsjsonLine('{"Path":"a","Name":"a","IsDir":true}')).toBeNull();
    const item = parseLsjsonLine('{"Path":"a.txt","Name":"a.txt","Size":3}');
    expect(item).toMatchObject({ id: 'path:/a.txt', hash: null });
    expect(parseLsjsonLine('{"Path":')).toBe('bad');
    expect(parseLsjsonLine('{"Size":3}')).toBe('bad');
  });

  it('picks QuickXorHash first, then SHA-1', () => {
    expect(pickHash({ sha1: 's', quickxor: 'q' })).toBe('quickxor:q');
    expect(pickHash({ sha1: 's' })).toBe('sha1:s');
    expect(pickHash({})).toBeNull();
    expect(pickHash(undefined)).toBeNull();
  });
});

describe('what a drive run does with each file', () => {
  const file = (id: string, size: number, hash: string | null, path = `/${id}`) => ({
    id,
    path,
    name: id,
    size,
    modTime: null,
    hash,
  });

  it('leaves an unchanged file, fetches a changed or new one', () => {
    const map = new Map<string, MapRow>([
      ['a', { itemId: 'a', hash: 'quickxor:1', size: 5, modTime: null }],
    ]);
    const p = plan();
    planItem(p, map, { selections: [] }, file('a', 5, 'quickxor:1'));
    planItem(p, map, { selections: [] }, file('b', 5, 'quickxor:2'));
    expect(p.fetch.map((f) => f.id)).toEqual(['b']);
    planItem(p, map, { selections: [] }, file('a', 6, 'quickxor:9'));
    expect(p.fetch.map((f) => f.id)).toEqual(['b', 'a']);
  });

  it('re-links a copied old file only when its size matches and it has not changed since', () => {
    const old = '2026-11-01T10:00:00Z';
    const map = new Map<string, MapRow>([
      ['same', { itemId: 'same', hash: null, size: 10, modTime: old }],
      ['resized', { itemId: 'resized', hash: null, size: 10, modTime: old }],
      ['edited', { itemId: 'edited', hash: null, size: 10, modTime: old }],
      ['notime', { itemId: 'notime', hash: null, size: 10, modTime: null }],
    ]);
    const p = plan();
    const at = (id: string, size: number, modTime: string | null) => ({
      ...file(id, size, 'quickxor:x'),
      modTime,
    });
    planItem(p, map, { selections: [] }, at('same', 10, '2026-11-01T09:59:00Z'));
    planItem(p, map, { selections: [] }, at('resized', 11, '2026-11-01T09:59:00Z'));
    planItem(p, map, { selections: [] }, at('edited', 10, '2026-11-17T08:00:00Z'));
    planItem(p, map, { selections: [] }, at('notime', 10, null));
    expect(p.relink.map((f) => f.id)).toEqual(['same']);
    expect(p.fetch.map((f) => f.id)).toEqual(['resized', 'edited', 'notime']);
  });

  it('removes only what the listing did not keep: gone, or out of the selections', () => {
    const map = new Map<string, MapRow>([
      ['in', { itemId: 'in', hash: 'h', size: 1, modTime: null }],
      ['out', { itemId: 'out', hash: 'h', size: 1, modTime: null }],
      ['gone', { itemId: 'gone', hash: 'h', size: 1, modTime: null }],
    ]);
    const p = plan();
    const drive = { selections: [{ itemId: 'f1', path: '/Keep', isFolder: true }] };
    planItem(p, map, drive, file('in', 1, 'h', '/Keep/in'));
    planItem(p, map, drive, file('out', 1, 'h', '/Other/out'));
    expect(goneIds(map, p.seen).sort()).toEqual(['gone', 'out']);
  });

  it('skips a file over the cap and keeps its old copy', () => {
    const map = new Map<string, MapRow>([
      ['big', { itemId: 'big', hash: 'h', size: 1, modTime: null }],
    ]);
    const p = plan();
    planItem(p, map, { selections: [] }, file('big', FILE_MAX_BYTES + 1, 'h2'));
    expect(p.fetch).toEqual([]);
    expect(p.oversize).toBe(1);
    expect(goneIds(map, p.seen)).toEqual([]);
  });
});

describe('selections', () => {
  const sel = [
    { itemId: 'F', path: '/Reports', isFolder: true },
    { itemId: 'X', path: '/plan.docx', isFolder: false },
  ];
  it('none chosen is the whole drive', () => {
    expect(inSelections([], 'a', '/any/thing')).toBe(true);
  });
  it('a folder holds itself and below, not a look-alike name', () => {
    expect(inSelections(sel, 'a', '/Reports/2026/q1.xlsx')).toBe(true);
    expect(inSelections(sel, 'a', '/Reports')).toBe(true);
    expect(inSelections(sel, 'a', '/Reports-old/q1.xlsx')).toBe(false);
  });
  it('a file matches by id or by path', () => {
    expect(inSelections(sel, 'X', '/renamed.docx')).toBe(true);
    expect(inSelections(sel, 'z', '/plan.docx')).toBe(true);
    expect(inSelections(sel, 'z', '/other.docx')).toBe(false);
  });
  it("reads an item's path after the drive root", () => {
    expect(
      itemPathOf({
        id: '1',
        name: 'q 1.xlsx',
        parentReference: { path: '/drive/root:/My%20Reports' },
      }),
    ).toBe('/My Reports/q 1.xlsx');
    expect(itemPathOf({ id: '1', name: 'a', parentReference: { path: '/drive/root:' } })).toBe(
      '/a',
    );
    expect(itemPathOf({ id: '1', name: 'a' })).toBeNull();
  });
});

describe('branch names', () => {
  it('keep the old account branch form', () => {
    expect(msBranchPath('Jo.Doe@Example.com')).toMatch(/^microsoft\.jo_doe_[0-9a-f]{4}$/);
    expect(msBranchPath('@example.com')).toMatch(/^microsoft\.account_[0-9a-f]{4}$/);
    // A long name still makes a label the brain takes (at most 64).
    const long = msBranchPath(`${'a'.repeat(80)}@example.com`).split('.')[1]!;
    expect(long.length).toBeLessThanOrEqual(64);
  });
  it('give each drive an ltree label', () => {
    expect(driveLabel('Shared Documents', 'b!x')).toMatch(/^shared_documents_[0-9a-f]{4}$/);
    expect(driveLabel('***', 'id')).toMatch(/^drive_[0-9a-f]{4}$/);
  });
});

describe('an Outlook message', () => {
  it('maps to the wire shape: lowercase addresses, the Message-ID without brackets', () => {
    const n = normalize({
      id: 'AAMk1',
      internetMessageId: '<abc@mail.example>',
      conversationId: 'conv',
      subject: 'Quote',
      from: { emailAddress: { address: 'Kim@Friends.TEST', name: 'Kim' } },
      toRecipients: [{ emailAddress: { address: 'Me@Example.com' } }],
      receivedDateTime: '2026-11-18T08:00:00Z',
      flag: { flagStatus: 'flagged' },
      internetMessageHeaders: [
        { name: 'In-Reply-To', value: '<prev@mail.example>' },
        { name: 'X-Mantle-Client-Code', value: '1' },
      ],
    });
    expect(n).toMatchObject({
      providerMsgId: 'AAMk1',
      rfcMessageId: 'abc@mail.example',
      fromAddr: 'kim@friends.test',
      fromName: 'Kim',
      toAddrs: ['me@example.com'],
      folder: 'Inbox',
      isStarred: true,
      inReplyTo: '<prev@mail.example>',
      clientCodeHeader: true,
    });
  });
});

describe('the Outlook account that sends', () => {
  const ms = (upn: string, over: Partial<MsAccount> = {}): MsAccount => ({
    id: upn,
    upn,
    displayName: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    scopes: ['Mail.Send'],
    branchPath: 'microsoft.x_0000',
    mail: true,
    mailboxId: 'm',
    ...over,
  });
  it('needs its mail on and Mail.Send granted', () => {
    expect(outlookSenderFor([ms('a@x.test', { mail: false })])).toBeNull();
    expect(outlookSenderFor([ms('a@x.test', { scopes: [] })])).toBeNull();
    expect(outlookSenderFor([ms('a@x.test')])?.upn).toBe('a@x.test');
  });
  it('matches `from` without case, and answers none for another address', () => {
    expect(outlookSenderFor([ms('a@x.test'), ms('B@x.test')], 'b@X.test')?.upn).toBe('B@x.test');
    expect(outlookSenderFor([ms('a@x.test')], 'c@x.test')).toBeNull();
  });
});
