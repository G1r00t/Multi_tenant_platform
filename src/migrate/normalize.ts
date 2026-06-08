import {
  CANONICAL_TENANTS,
  type CanonicalTenantId,
  TENANT_SLUGS,
} from '../authz/types.js';

const NORMALIZE_MAP: Record<string, CanonicalTenantId | 'quarantine'> = {
  client_sunrise_001: 'client_sunrise_001',
  client_sunrise_01: 'client_sunrise_001',
  client_sunrise_001_test: 'client_sunrise_001',
  sunrise_001: 'client_sunrise_001',
  client_metro_002: 'client_metro_002',
  client_metro_02: 'client_metro_002',
  client_metro: 'client_metro_002',
  client_digital_003: 'client_digital_003',
  client_digital_3: 'client_digital_003',
  client_digital_004: 'quarantine',
};

export function resolveClientId(raw: string | null | undefined): CanonicalTenantId | 'quarantine' {
  if (raw == null || raw === '') return 'quarantine';
  const mapped = NORMALIZE_MAP[raw];
  if (mapped) return mapped;
  if ((CANONICAL_TENANTS as readonly string[]).includes(raw)) {
    return raw as CanonicalTenantId;
  }
  return 'quarantine';
}

export function tenantDbName(slug: string, version = 1): string {
  return `tenant_${slug}__v${version}`;
}

export function slugForTenant(clientId: CanonicalTenantId): string {
  return TENANT_SLUGS[clientId];
}

export interface SeedBorrower {
  _id: string;
  borrowerId: string;
  clientId: string | null;
  assignedTo: string | null;
  [key: string]: unknown;
}

export interface NormalizedBorrower {
  record: Record<string, unknown>;
  resolvedTenant: CanonicalTenantId | 'quarantine';
  originalClientId: string | null;
}

export function normalizeBorrower(borrower: SeedBorrower): NormalizedBorrower {
  const resolvedTenant = resolveClientId(borrower.clientId);
  const { clientId: _removed, ...rest } = borrower;
  const record: Record<string, unknown> = { ...rest };

  if (resolvedTenant !== 'quarantine') {
    delete record.clientId;
  } else {
    record.clientId = borrower.clientId;
  }

  return {
    record,
    resolvedTenant,
    originalClientId: borrower.clientId,
  };
}
