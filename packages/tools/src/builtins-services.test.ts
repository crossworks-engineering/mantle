/**
 * service_list and service_set: Settings > Services over MCP, through the
 * services bridge the web process installs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServicesView } from '@mantle/client-types';
import { service_list, service_set } from './builtins-services';
import { registerServicesProvider, SERVICES_UNAVAILABLE } from './services-bridge';

const ctx = { ownerId: 'owner-1' } as never;

const VIEW: ServicesView = {
  services: [
    {
      name: 'sync',
      state: 'off',
      container: null,
      health: null,
      description: {
        title: 'Sync',
        what: 'w',
        usedBy: 'u',
        whenOff: 'Email and Contacts hide.',
        keeps: 'k',
        downloadMb: 150,
        memory: 'up to 512 MB',
        memoryMaxMb: 512,
        note: null,
      },
    },
  ],
  switching: { available: true, reason: null },
  box: {
    memTotalBytes: null,
    memAvailableBytes: null,
    diskFreeBytes: null,
    core: false,
    smallBox: false,
  },
  run: null,
} as ServicesView;

afterEach(() => registerServicesProvider(null));

describe('service_list / service_set', () => {
  it('refuse clearly in a process without the provider', async () => {
    expect(await service_list.handler({}, ctx)).toEqual({ ok: false, error: SERVICES_UNAVAILABLE });
    expect(await service_set.handler({ name: 'sync', enable: true }, ctx)).toEqual({
      ok: false,
      error: SERVICES_UNAVAILABLE,
    });
  });

  it('lists each service with its state and what stops while it is off', async () => {
    registerServicesProvider({ view: async () => VIEW, set: async () => ({ ok: true }) });
    const r = await service_list.handler({}, ctx);
    expect(r).toMatchObject({
      ok: true,
      output: {
        services: [
          { name: 'sync', title: 'Sync', state: 'off', when_off: 'Email and Contacts hide.' },
        ],
        switching: { available: true },
      },
    });
  });

  it('asks for the switch, and passes a refusal on', async () => {
    const set = vi.fn(async () => ({ ok: true as const }));
    registerServicesProvider({ view: async () => VIEW, set });
    expect(await service_set.handler({ name: 'sync', enable: true }, ctx)).toMatchObject({
      ok: true,
      output: { requested: { name: 'sync', enable: true } },
    });
    expect(set).toHaveBeenCalledWith('sync', true);
    registerServicesProvider({
      view: async () => VIEW,
      set: async () => ({ ok: false as const, error: 'An update is in progress.' }),
    });
    expect(await service_set.handler({ name: 'sync', enable: false }, ctx)).toEqual({
      ok: false,
      error: 'An update is in progress.',
    });
  });

  it('refuses a name that is no service, and names the ones there are', async () => {
    registerServicesProvider({ view: async () => VIEW, set: async () => ({ ok: true }) });
    const r = await service_set.handler({ name: 'mail', enable: true }, ctx);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('sync');
  });
});
