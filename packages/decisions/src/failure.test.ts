import { describe, expect, it } from 'vitest';
import { ModelPolicyError, ProviderHttpError } from '@mantle/std';
import { DECISION_FAILURE_REASONS, DecisionCutError, decisionFailureClass } from './failure';

const http = (status: number, body = '') =>
  new ProviderHttpError({ provider: 'openrouter', status, body, message: `x ${status}` });

describe('decisionFailureClass', () => {
  it('a 404 under zdr names the privacy route, permanent, and never the provider text', () => {
    const c = decisionFailureClass(
      http(404, 'No endpoints found matching your data policy'),
      'zdr',
    );
    expect(c).toEqual({
      code: 'privacy_route',
      permanent: true,
      reason: DECISION_FAILURE_REASONS.privacy_route,
    });
    expect(c.reason).not.toMatch(/endpoints found/);
  });

  it('a 404 under no_training is the plain model code', () => {
    expect(decisionFailureClass(http(404), 'no_training').code).toBe('model');
  });

  it('keeps the classifier for account and transport errors', () => {
    expect(decisionFailureClass(http(401), 'zdr')).toMatchObject({ code: 'auth', permanent: true });
    expect(decisionFailureClass(http(402), 'zdr')).toMatchObject({
      code: 'quota',
      permanent: true,
    });
    expect(decisionFailureClass(http(503), 'zdr')).toMatchObject({
      code: 'server',
      permanent: false,
    });
    const abort = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(decisionFailureClass(abort, 'zdr').code).toBe('timeout');
  });

  it('a box-policy refusal is the policy code', () => {
    const e = new ModelPolicyError('blocked', { rule: 'model_deny', provider: 'p', model: 'm' });
    expect(decisionFailureClass(e, 'zdr')).toMatchObject({ code: 'policy', permanent: true });
  });

  it('a suspected cut and an unusable answer have their own transient codes', () => {
    expect(decisionFailureClass(new DecisionCutError(16_384), 'zdr')).toMatchObject({
      code: 'cut',
      permanent: false,
    });
    const bad = new Error("openrouter-decision: no usable answer for question 'q'");
    expect(decisionFailureClass(bad, 'zdr')).toEqual({
      code: 'answer',
      permanent: false,
      reason: DECISION_FAILURE_REASONS.answer,
    });
  });
});
