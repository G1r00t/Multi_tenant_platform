import type { CanonicalTenantId } from '../authz/types.js';

const REFERENCE_PREFIXES: Record<string, CanonicalTenantId> = {
  'PAY-client_s': 'client_sunrise_001',
  'PAY-client_m': 'client_metro_002',
  'PAY-client_d': 'client_digital_003',
};

export function parsePaymentReference(reference: string): CanonicalTenantId | null {
  for (const [prefix, clientId] of Object.entries(REFERENCE_PREFIXES)) {
    if (reference.startsWith(prefix)) {
      return clientId;
    }
  }
  return null;
}
