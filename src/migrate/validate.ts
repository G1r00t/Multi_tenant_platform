export interface MigrationCounts {
  sunriseBorrowers: number;
  metroBorrowers: number;
  digitalBorrowers: number;
  quarantineBorrowers: number;
  conversations: number;
  payments: number;
  users: number;
  legacyLogs: number;
  assignmentFixes: number;
}

export const EXPECTED_MIGRATION_COUNTS = {
  sunriseBorrowers: 704,
  metroBorrowers: 803,
  digitalBorrowers: 501,
  quarantineBorrowers: 5,
  conversations: 3305,
  payments: 1593,
  users: 18,
  clients: 3,
  legacyLogs: 2512,
  registryTenants: 3,
  assignmentFixesMin: 11,
  totalBorrowers: 2013,
  maxDurationMs: 60_000,
} as const;

const EXPECTED = EXPECTED_MIGRATION_COUNTS;

export async function validateNoPlaintextPii(): Promise<void> {
  const { getMongoClient } = await import('../db/client.js');
  const { CANONICAL_TENANTS, TENANT_SLUGS } = await import('../authz/types.js');
  const { tenantDbName, slugForTenant } = await import('./normalize.js');

  const client = await getMongoClient();
  const plainFields = ['phone', 'aadhaar', 'bankAccount', 'pan', 'email', 'fullName', 'firstName', 'lastName'];
  const errors: string[] = [];

  for (const tenantId of CANONICAL_TENANTS) {
    const db = client.db(tenantDbName(slugForTenant(tenantId), 1));
    for (const field of plainFields) {
      const count = await db.collection('borrowers').countDocuments({ [field]: { $exists: true } });
      if (count > 0) {
        errors.push(`${TENANT_SLUGS[tenantId]}: ${count} borrowers still have plaintext ${field}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Plaintext PII validation failed:\n${errors.join('\n')}`);
  }
}

export async function validateMigrationCounts(counts: MigrationCounts): Promise<void> {
  const errors: string[] = [];

  if (counts.sunriseBorrowers !== EXPECTED.sunriseBorrowers) {
    errors.push(`sunrise borrowers: expected ${EXPECTED.sunriseBorrowers}, got ${counts.sunriseBorrowers}`);
  }
  if (counts.metroBorrowers !== EXPECTED.metroBorrowers) {
    errors.push(`metro borrowers: expected ${EXPECTED.metroBorrowers}, got ${counts.metroBorrowers}`);
  }
  if (counts.digitalBorrowers !== EXPECTED.digitalBorrowers) {
    errors.push(`digital borrowers: expected ${EXPECTED.digitalBorrowers}, got ${counts.digitalBorrowers}`);
  }
  if (counts.quarantineBorrowers !== EXPECTED.quarantineBorrowers) {
    errors.push(`quarantine borrowers: expected ${EXPECTED.quarantineBorrowers}, got ${counts.quarantineBorrowers}`);
  }
  if (counts.conversations !== EXPECTED.conversations) {
    errors.push(`conversations: expected ${EXPECTED.conversations}, got ${counts.conversations}`);
  }
  if (counts.payments !== EXPECTED.payments) {
    errors.push(`payments: expected ${EXPECTED.payments}, got ${counts.payments}`);
  }
  if (counts.users !== EXPECTED.users) {
    errors.push(`users: expected ${EXPECTED.users}, got ${counts.users}`);
  }
  if (counts.legacyLogs !== EXPECTED.legacyLogs) {
    errors.push(`legacy logs: expected ${EXPECTED.legacyLogs}, got ${counts.legacyLogs}`);
  }
  if (counts.assignmentFixes < EXPECTED.assignmentFixesMin) {
    errors.push(`assignment fixes: expected at least ${EXPECTED.assignmentFixesMin}, got ${counts.assignmentFixes}`);
  }

  if (errors.length > 0) {
    throw new Error(`Migration validation failed:\n${errors.join('\n')}`);
  }
}
