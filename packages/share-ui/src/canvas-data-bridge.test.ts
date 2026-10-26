import { describe, expect, it } from 'vitest';
import { CANVAS_DATA_VALUE_MAX_BYTES } from '@mantle/content-core/canvas-data';
import { acceptsDataMessage, canvasDataReply, readCanvasDataMessage } from './canvas-data-bridge';

const ok = (m: unknown) => {
  const r = readCanvasDataMessage(m);
  if (!r.ok) throw new Error(r.rejection.error);
  return r.req;
};
const no = (m: unknown) => {
  const r = readCanvasDataMessage(m);
  if (r.ok) throw new Error(`taken: ${JSON.stringify(r.req)}`);
  return r.rejection;
};

describe('the host reads a frame data message as hostile', () => {
  it('makes a request to its own canvas only: the message names no canvas and no login', () => {
    const req = ok({
      v: 1,
      kind: 'data',
      id: 3,
      op: 'set',
      bucket: 'mine',
      key: 'vote',
      json: '"yes"',
      // What a hostile canvas might add: never read.
      canvas: '00000000-0000-4000-8000-000000000000',
      presentId: 'x',
      login: 'someone',
      url: 'https://evil.example/',
    });
    expect(req).toEqual({
      id: 3,
      op: 'set',
      method: 'PUT',
      path: '/data',
      body: '{"bucket":"mine","key":"vote","value":"yes"}',
    });
  });

  it('builds each operation', () => {
    expect(ok({ id: 1, op: 'info' }).path).toBe('/data?info=1');
    expect(ok({ id: 1, op: 'get', bucket: 'shared', key: 'a/b' }).path).toBe(
      '/data?bucket=shared&key=a%2Fb',
    );
    expect(ok({ id: 1, op: 'delete', bucket: 'mine', key: 'k' })).toMatchObject({
      method: 'DELETE',
      path: '/data?bucket=mine&key=k',
    });
    expect(ok({ id: 1, op: 'list', bucket: 'mine', everyone: true }).path).toBe(
      '/data?bucket=mine&everyone=1',
    );
    // everyone means nothing for shared.
    expect(ok({ id: 1, op: 'list', bucket: 'shared', everyone: true }).path).toBe(
      '/data?bucket=shared',
    );
  });

  it('refuses an unknown operation, bucket or key, and a bad id', () => {
    expect(no({ id: 1, op: 'drop', bucket: 'shared', key: 'k' }).error).toMatch(/operation/);
    expect(no({ id: 1, op: '__proto__' }).error).toMatch(/operation/);
    expect(no({ id: 1, op: 'get', bucket: 'everyone', key: 'k' }).error).toMatch(/bucket/);
    expect(no({ id: 1, op: 'get', bucket: 'shared', key: '../x' }).error).toMatch(/key/);
    expect(no({ id: 1, op: 'get', bucket: 'shared', key: 'a&bucket=mine' }).error).toMatch(/key/);
    expect(no({ id: 1, op: 'get', bucket: 'shared', key: { toString: () => 'k' } }).error).toMatch(
      /key/,
    );
    expect(no({ id: 1, op: 'list', bucket: 'mine', everyone: 'yes' }).error).toMatch(/everyone/);
    for (const id of [0, -1, 1.5, '1', null, Number.MAX_VALUE]) {
      expect(no({ id, op: 'info' }).id).toBeNull();
    }
    expect(no(null).id).toBeNull();
    expect(no('get').id).toBeNull();
    expect(no([1]).id).toBeNull();
  });

  it('takes a value only as JSON text within the cap', () => {
    expect(no({ id: 1, op: 'set', bucket: 'shared', key: 'k', json: { a: 1 } }).error).toMatch(
      /JSON/,
    );
    expect(no({ id: 1, op: 'set', bucket: 'shared', key: 'k', json: '{nope' }).error).toMatch(
      /JSON/,
    );
    expect(no({ id: 1, op: 'set', bucket: 'shared', key: 'k' }).error).toMatch(/JSON/);
    const big = JSON.stringify('x'.repeat(CANVAS_DATA_VALUE_MAX_BYTES));
    expect(no({ id: 1, op: 'set', bucket: 'shared', key: 'k', json: big }).error).toMatch(/KB/);
    // The body carries the canonical text, never the frame's own string.
    expect(ok({ id: 1, op: 'set', bucket: 'shared', key: 'k', json: ' { "a" : 1 } ' }).body).toBe(
      '{"bucket":"shared","key":"k","value":{"a":1}}',
    );
  });
});

describe('the host takes a data message only from the proven document of this load', () => {
  const state = { proven: true, nonce: 'abc123' };
  const msg = { v: 1, kind: 'data', id: 1, op: 'info' };

  it('takes one with the nonce', () => {
    expect(acceptsDataMessage({ ...msg, n: 'abc123' }, state)).toBe(true);
  });

  it('ignores the right shape with no nonce, a wrong one, or one of another type', () => {
    for (const n of [
      undefined,
      null,
      '',
      'abc124',
      'ABC123',
      ['abc123'],
      { toString: () => 'abc123' },
    ]) {
      expect(acceptsDataMessage({ ...msg, n }, state), String(n)).toBe(false);
    }
  });

  it('ignores every message before the proof, after a take-down, or with no nonce to hold', () => {
    expect(acceptsDataMessage({ ...msg, n: 'abc123' }, { proven: false, nonce: 'abc123' })).toBe(
      false,
    );
    expect(acceptsDataMessage({ ...msg, n: null }, { proven: true, nonce: null })).toBe(false);
    expect(acceptsDataMessage({ ...msg, n: '' }, { proven: true, nonce: '' })).toBe(false);
    expect(acceptsDataMessage(null, state)).toBe(false);
  });
});

describe('moderation and clear', () => {
  const by = '00000000-0000-4000-8000-000000000001';
  it("removes another viewer's mine entry by its id, and clears with all=1", () => {
    expect(ok({ id: 1, op: 'delete', bucket: 'mine', key: 'v', by })).toMatchObject({
      method: 'DELETE',
      path: `/data?bucket=mine&key=v&by=${by}`,
    });
    expect(ok({ id: 1, op: 'delete', bucket: 'mine', key: 'v', by: null }).path).toBe(
      '/data?bucket=mine&key=v',
    );
    expect(ok({ id: 1, op: 'clear', bucket: 'x', key: '../', by: 'y' })).toEqual({
      id: 1,
      op: 'clear',
      method: 'DELETE',
      path: '/data?all=1',
    });
  });

  it('refuses a by that is not a login id, or on shared', () => {
    for (const bad of [
      'me',
      `${by}&all=1`,
      'ABCDEF00-0000-4000-8000-000000000001',
      7,
      { id: by },
    ]) {
      expect(no({ id: 1, op: 'delete', bucket: 'mine', key: 'v', by: bad }).error).toMatch(/by/);
    }
    expect(no({ id: 1, op: 'delete', bucket: 'shared', key: 'v', by }).error).toMatch(/by/);
  });

  it('passes what clear returns', () => {
    expect(canvasDataReply('clear', 200, { removed: 3 })).toEqual({
      ok: true,
      result: { removed: 3 },
    });
  });
});

describe('the frame is told the answer', () => {
  it('passes what each operation returns', () => {
    expect(canvasDataReply('get', 200, { entry: { key: 'k', value: 1 } })).toEqual({
      ok: true,
      result: { key: 'k', value: 1 },
    });
    expect(canvasDataReply('get', 200, { entry: null })).toEqual({ ok: true, result: null });
    expect(canvasDataReply('list', 200, { entries: 'x' })).toEqual({ ok: true, result: [] });
    expect(canvasDataReply('delete', 200, { deleted: true })).toEqual({
      ok: true,
      result: { deleted: true },
    });
  });

  it('says a refusal in plain words', () => {
    expect(canvasDataReply('set', 403, { error: 'only Write' })).toEqual({
      ok: false,
      error: 'only Write',
    });
    expect(canvasDataReply('get', 404, {})).toEqual({
      ok: false,
      error: 'this canvas is not available',
    });
    expect(canvasDataReply('set', 500, null)).toEqual({
      ok: false,
      error: 'the canvas data store failed (500)',
    });
  });
});
