/**
 * What the host's bridge sends the db broker for each request of an app. A kind
 * it does not know is never a write: an older host once sent anything that was
 * not a query as an exec.
 */
import { describe, expect, it } from 'vitest';
import { dbBrokerBody, type BridgeReq } from './app-bridge-protocol';

const req = (r: Record<string, unknown>) => ({ v: 1, id: 'r1', ...r }) as unknown as BridgeReq;

describe('dbBrokerBody', () => {
  it('sends a query and an exec as it always did', () => {
    expect(dbBrokerBody(req({ kind: 'db.query', sql: 'SELECT 1' }))).toEqual({
      op: 'query',
      sql: 'SELECT 1',
      params: [],
    });
    expect(dbBrokerBody(req({ kind: 'db.exec', sql: 'DELETE FROM t', params: [1] }))).toEqual({
      op: 'exec',
      sql: 'DELETE FROM t',
      params: [1],
    });
  });

  it('sends a batch with its statements and guard', () => {
    const statements = [{ sql: 'INSERT INTO t VALUES (1)' }];
    const guard = { sql: 'SELECT 1', params: [] };
    expect(dbBrokerBody(req({ kind: 'db.batch', statements, guard }))).toEqual({
      op: 'batch',
      statements,
      guard,
    });
  });

  it('sends nothing for a kind it does not know', () => {
    expect(dbBrokerBody(req({ kind: 'db.merge', sql: 'DELETE FROM t' }))).toBeNull();
    expect(dbBrokerBody(req({ kind: 'hub.get' }))).toBeNull();
  });
});
