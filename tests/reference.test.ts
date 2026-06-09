import { describe, expect, it } from 'vitest';
import { parsePaymentReference } from '../src/webhooks/reference.js';

describe('payment reference parser', () => {
  it('maps sunrise prefix to tenant', () => {
    expect(parsePaymentReference('PAY-client_s-eef188fd')).toBe('client_sunrise_001');
  });

  it('maps metro prefix to tenant', () => {
    expect(parsePaymentReference('PAY-client_m-6ad74500')).toBe('client_metro_002');
  });

  it('maps digital prefix to tenant', () => {
    expect(parsePaymentReference('PAY-client_d-a2294ccc')).toBe('client_digital_003');
  });

  it('returns null for unknown prefix', () => {
    expect(parsePaymentReference('PAY-unknown-abc')).toBeNull();
  });
});
