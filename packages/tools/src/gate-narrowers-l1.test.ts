/**
 * The owner-only and connector narrowers (A5 step 6a, carried L1): the two
 * checks dispatch made outside the gate, now narrowers, so a tool loop's
 * listing and its call read one rule. Their place in the order and their
 * words are pinned here; the listings that read them by
 * turn-listing.test.ts and tool-loop.listing.test.ts, and the calls, word
 * for word, by dispatch-parity and app-broker-parity.
 */
import { describe, expect, it } from 'vitest';
import { type GateCaller, type GatePolicy, type PolicyRef } from '@mantle/db';
import { NARROWERS } from '../../db/src/gate';
import {
  CONNECTOR_NOT_HELD_ERROR,
  CONNECTOR_STALE_MARK_ERROR,
  CONNECTOR_WRITE_ERROR,
  connectorScopeRefusal,
  type ConnectorScopeFacts,
} from './connector-scope';
import { LINK_NO_CONNECTORS } from './external-access';
import { CONNECTOR_FACTS_MISMATCH_ERROR, GATE_NARROWERS } from './gate-narrowers';
import { OWNER_ONLY_ERROR } from './surface';

const caller = (facts?: Record<string, unknown>): GateCaller =>
  ({ actor: null, via: 'turn', ...(facts ? { facts } : {}) }) as GateCaller;
const policy = (fields: Record<string, unknown>): GatePolicy => ({
  effect: 'write',
  scope: 'any',
  fields,
});
const toolRef: PolicyRef = { kind: 'tool', name: 'tree_folders', slug: 'tree_folders' };

describe('the owner-only narrower', () => {
  const ownerOnly = GATE_NARROWERS['owner-only'];

  it('is first, before the credential and surface narrowers', () => {
    expect(NARROWERS[0]).toBe('owner-only');
    expect(NARROWERS[NARROWERS.length - 1]).toBe('connector');
  });

  it('refuses an owner-only tool off the owner surface, in its own words', () => {
    expect(ownerOnly(caller({ ownerSurface: false }), policy({ ownerOnly: true }), toolRef)).toBe(
      OWNER_ONLY_ERROR,
    );
  });

  it('lets it through on the owner surface, or where the caller does not say (MCP)', () => {
    expect(
      ownerOnly(caller({ ownerSurface: true }), policy({ ownerOnly: true }), toolRef),
    ).toBeNull();
    expect(ownerOnly(caller(), policy({ ownerOnly: true }), toolRef)).toBeNull();
  });

  it('never narrows a tool that is not owner-only', () => {
    expect(ownerOnly(caller({ ownerSurface: false }), policy({}), toolRef)).toBeNull();
  });
});

describe('the connector narrower', () => {
  const connector = GATE_NARROWERS.connector;
  const facts = (over: Partial<ConnectorScopeFacts> = {}): ConnectorScopeFacts => ({
    group: 'crm',
    usable: true,
    link: false,
    held: [{ workspaceId: 'w1', write: true }],
    modWs: ['w1'],
    ...over,
  });
  const row = { handler: { kind: 'mcp', group: 'crm', toolName: 'x' } };
  const ref: PolicyRef = { kind: 'runtime-tool', name: 'crm_x', row };
  const mark = (m: string) => policy({ mark: m });

  it('is the connector rule of a workspace scope', () => {
    expect(connectorScopeRefusal(facts({ link: true }), 'read')).toBe(LINK_NO_CONNECTORS);
    expect(connectorScopeRefusal(facts({ held: [] }), 'read')).toBe(CONNECTOR_NOT_HELD_ERROR);
    expect(connectorScopeRefusal(facts(), 'stale')).toBe(CONNECTOR_STALE_MARK_ERROR);
    expect(connectorScopeRefusal(facts(), 'read')).toBeNull();
    expect(connectorScopeRefusal(facts(), 'write')).toBeNull();
    expect(connectorScopeRefusal(facts({ modWs: [] }), 'write')).toBe(CONNECTOR_WRITE_ERROR);
    expect(
      connectorScopeRefusal(facts({ held: [{ workspaceId: 'w1', write: false }] }), 'write'),
    ).toBe(CONNECTOR_WRITE_ERROR);
    // A missing, unbound or disabled group: dispatch answers it, in its words.
    expect(connectorScopeRefusal(facts({ usable: false, held: [] }), 'write')).toBeNull();
  });

  it('reads the caller facts for the row it judges', () => {
    expect(connector(caller({ connector: facts({ modWs: [] }) }), mark('write'), ref)).toBe(
      CONNECTOR_WRITE_ERROR,
    );
    expect(connector(caller({ connector: facts() }), mark('write'), ref)).toBeNull();
    // Facts of another group: refused, fail closed (fix round 1, LOW-5),
    // even where they would allow it.
    for (const other of [facts({ group: 'erp', held: [] }), facts({ group: 'erp' })]) {
      for (const m of ['read', 'write', 'stale']) {
        expect(connector(caller({ connector: other }), mark(m), ref)).toBe(
          CONNECTOR_FACTS_MISMATCH_ERROR,
        );
      }
    }
    // A ref that is no runtime row, a policy with no mark, or no facts (an
    // MCP connection, outside a scope): not judged.
    expect(connector(caller({ connector: facts({ held: [] }) }), mark('read'), toolRef)).toBeNull();
    expect(connector(caller({ connector: facts({ held: [] }) }), policy({}), ref)).toBeNull();
    expect(connector(caller(), mark('write'), ref)).toBeNull();
  });
});
