/**
 * config_models_check: the model check over MCP, through the bridge the web
 * process installs. Read-only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelCheckReport } from '@mantle/client-types';
import { config_models_check } from './builtins-model-check';
import { MODEL_CHECK_UNAVAILABLE, registerModelCheckProvider } from './model-check-bridge';

const ctx = { ownerId: 'owner-1' } as never;

const REPORT: ModelCheckReport = {
  appVersion: '1.2.3',
  notOk: 1,
  rows: [
    {
      kind: 'worker',
      name: 'summarizer',
      status: 'ok',
      required: true,
      box: { provider: 'openrouter', model: 'a/b' },
      default: { provider: 'openrouter', model: 'a/b' },
    },
    {
      kind: 'agent',
      name: 'coder',
      status: 'drift',
      box: { provider: 'openrouter', model: 'c/d' },
      default: { provider: 'openrouter', model: 'e/f' },
    },
  ],
};

afterEach(() => registerModelCheckProvider(null));

describe('config_models_check', () => {
  it('refuses where no web process installed the check', async () => {
    const r = await config_models_check.handler({}, ctx);
    expect(r).toEqual({ ok: false, error: MODEL_CHECK_UNAVAILABLE });
  });

  it("answers the box's report for the caller's brain", async () => {
    const fn = vi.fn(async () => REPORT);
    registerModelCheckProvider(fn);
    const r = await config_models_check.handler({}, ctx);
    expect(fn).toHaveBeenCalledWith('owner-1');
    expect(r).toEqual({ ok: true, output: REPORT });
  });

  it('only_not_ok keeps the rows not ok, and the count', async () => {
    registerModelCheckProvider(async () => REPORT);
    const r = await config_models_check.handler({ only_not_ok: true }, ctx);
    expect(r).toEqual({ ok: true, output: { ...REPORT, rows: [REPORT.rows[1]] } });
  });

  it('is a read on the settings area that spends nothing', () => {
    expect(config_models_check.mcpOnly).toBe(true);
    expect(config_models_check.policy).toMatchObject({
      effect: 'read',
      spends: 'none',
      scope: { area: 'settings', systemWhole: true },
    });
  });
});
