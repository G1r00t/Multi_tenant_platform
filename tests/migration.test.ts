import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { SYSTEM_DB } from '../src/db/router.js';
import { invalidateRegistryCache } from '../src/registry/index.js';
import { CANONICAL_TENANTS } from '../src/authz/types.js';
import { runMigration } from '../src/migrate/run.js';
import { tenantDbName, slugForTenant } from '../src/migrate/normalize.js';
import { EXPECTED_MIGRATION_COUNTS } from '../src/migrate/validate.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';

const mongoUp = await isMongoAvailable();

const SAMPLE_BORROWER_ID = '709dc7f4-65f0-4791-b4a7-367092ba16da';
const PLAINTEXT_PII_FIELDS = ['phone', 'aadhaar', 'pan', 'bankAccount'] as const;

interface MigrationSnapshot {
  sunriseBorrowers: number;
  metroBorrowers: number;
  digitalBorrowers: number;
  quarantineBorrowers: number;
  conversations: number;
  payments: number;
  users: number;
  clients: number;
  legacyLogs: number;
  migrationFixes: number;
  registryTenants: number;
  plaintextPiiFields: number;
}

async function readMigrationSnapshot(): Promise<MigrationSnapshot> {
  const client = await getMongoClient();
  const system = client.db(SYSTEM_DB);

  let conversations = 0;
  let payments = 0;
  let plaintextPiiFields = 0;

  for (const tenantId of CANONICAL_TENANTS) {
    const db = client.db(tenantDbName(slugForTenant(tenantId), 1));
    conversations += await db.collection('conversations').countDocuments();
    payments += await db.collection('payments').countDocuments();
    for (const field of PLAINTEXT_PII_FIELDS) {
      plaintextPiiFields += await db.collection('borrowers').countDocuments({ [field]: { $exists: true } });
    }
  }

  return {
    sunriseBorrowers: await client.db(tenantDbName('sunrise', 1)).collection('borrowers').countDocuments(),
    metroBorrowers: await client.db(tenantDbName('metro', 1)).collection('borrowers').countDocuments(),
    digitalBorrowers: await client.db(tenantDbName('digital', 1)).collection('borrowers').countDocuments(),
    quarantineBorrowers: await system.collection('quarantine_borrowers').countDocuments(),
    conversations,
    payments,
    users: await system.collection('users').countDocuments(),
    clients: await system.collection('clients').countDocuments(),
    legacyLogs: await system.collection('legacy_access_logs').countDocuments(),
    migrationFixes: await system.collection('migration_log').countDocuments(),
    registryTenants: await system.collection('tenant_registry').countDocuments(),
    plaintextPiiFields,
  };
}

function expectSnapshotMatchesExpected(snapshot: MigrationSnapshot): void {
  expect(snapshot.sunriseBorrowers).toBe(EXPECTED_MIGRATION_COUNTS.sunriseBorrowers);
  expect(snapshot.metroBorrowers).toBe(EXPECTED_MIGRATION_COUNTS.metroBorrowers);
  expect(snapshot.digitalBorrowers).toBe(EXPECTED_MIGRATION_COUNTS.digitalBorrowers);
  expect(snapshot.quarantineBorrowers).toBe(EXPECTED_MIGRATION_COUNTS.quarantineBorrowers);
  expect(snapshot.conversations).toBe(EXPECTED_MIGRATION_COUNTS.conversations);
  expect(snapshot.payments).toBe(EXPECTED_MIGRATION_COUNTS.payments);
  expect(snapshot.users).toBe(EXPECTED_MIGRATION_COUNTS.users);
  expect(snapshot.clients).toBe(EXPECTED_MIGRATION_COUNTS.clients);
  expect(snapshot.legacyLogs).toBe(EXPECTED_MIGRATION_COUNTS.legacyLogs);
  expect(snapshot.registryTenants).toBe(EXPECTED_MIGRATION_COUNTS.registryTenants);
  expect(snapshot.migrationFixes).toBeGreaterThanOrEqual(EXPECTED_MIGRATION_COUNTS.assignmentFixesMin);
  expect(snapshot.plaintextPiiFields).toBe(0);

  const totalBorrowers =
    snapshot.sunriseBorrowers +
    snapshot.metroBorrowers +
    snapshot.digitalBorrowers +
    snapshot.quarantineBorrowers;
  expect(totalBorrowers).toBe(EXPECTED_MIGRATION_COUNTS.totalBorrowers);
}

describe.sequential.skipIf(!mongoUp)('migration (spec 3.5)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
  });

  afterAll(async () => {
    invalidateRegistryCache();
    await closeMongoClient();
  });

  it('completes within 60 seconds', async () => {
    const started = Date.now();
    await runMigration();
    invalidateRegistryCache();

    expect(Date.now() - started).toBeLessThan(EXPECTED_MIGRATION_COUNTS.maxDurationMs);

    const snapshot = await readMigrationSnapshot();
    expectSnapshotMatchesExpected(snapshot);
  }, 90_000);

  it('preserves every seed borrower (none silently dropped)', async () => {
    const seedPath = process.env.SEED_DATA_PATH ?? './seed-data';
    const seedBorrowers = JSON.parse(
      await readFile(path.join(seedPath, 'borrowers.json'), 'utf8'),
    ) as unknown[];

    expect(seedBorrowers).toHaveLength(EXPECTED_MIGRATION_COUNTS.totalBorrowers);

    const client = await getMongoClient();
    const system = client.db(SYSTEM_DB);
    const tenantIds = new Set<string>();

    for (const tenantId of CANONICAL_TENANTS) {
      const db = client.db(tenantDbName(slugForTenant(tenantId), 1));
      const ids = await db.collection('borrowers').distinct('borrowerId');
      for (const id of ids) tenantIds.add(String(id));
    }

    const quarantineIds = await system.collection('quarantine_borrowers').distinct('borrowerId');
    for (const id of quarantineIds) tenantIds.add(String(id));

    expect(tenantIds.size).toBe(EXPECTED_MIGRATION_COUNTS.totalBorrowers);

    const sample = await client
      .db(tenantDbName('sunrise', 1))
      .collection('borrowers')
      .findOne(
        { borrowerId: SAMPLE_BORROWER_ID },
        {
          projection: {
            borrowerId: 1,
            firstName: 1,
            firstNameToken: 1,
            fullName: 1,
            fullNameToken: 1,
            email: 1,
            emailToken: 1,
            phoneToken: 1,
            phone: 1,
            panToken: 1,
            pan: 1,
          },
        },
      );

    expect(sample).toBeTruthy();
    expect(sample!.firstName).toBeUndefined();
    expect(sample!.firstNameToken).toBeTruthy();
    expect(sample!.fullName).toBeUndefined();
    expect(sample!.fullNameToken).toBeTruthy();
    expect(sample!.email).toBeUndefined();
    expect(sample!.emailToken).toBeTruthy();
    expect(sample!.phoneToken).toBeTruthy();
    expect(sample!.phone).toBeUndefined();
    expect(sample!.pan).toBeUndefined();
  }, 30_000);

  it('is reversible — re-run restores corrupted data from seed', async () => {
    const client = await getMongoClient();
    const sunriseDb = client.db(tenantDbName('sunrise', 1));

    const deleted = await sunriseDb.collection('borrowers').deleteOne({ borrowerId: SAMPLE_BORROWER_ID });
    expect(deleted.deletedCount).toBe(1);

    const afterDelete = await sunriseDb.collection('borrowers').countDocuments();
    expect(afterDelete).toBe(EXPECTED_MIGRATION_COUNTS.sunriseBorrowers - 1);

    await runMigration();
    invalidateRegistryCache();

    const restored = await sunriseDb.collection('borrowers').findOne({ borrowerId: SAMPLE_BORROWER_ID });
    expect(restored).toBeTruthy();
    expect(restored!.firstName).toBeUndefined();
    expect(restored!.firstNameToken).toBeTruthy();

    const snapshot = await readMigrationSnapshot();
    expectSnapshotMatchesExpected(snapshot);
  }, 90_000);

  it('supports zero-downtime re-migration (API stays reachable)', async () => {
    const healthChecks: number[] = [];

    const migrationPromise = runMigration().then(() => {
      invalidateRegistryCache();
    });

    for (let i = 0; i < 15; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      healthChecks.push(res.statusCode);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await migrationPromise;

    expect(healthChecks.every((code) => code === 200)).toBe(true);

    const health = JSON.parse(
      (await app.inject({ method: 'GET', url: '/health' })).body,
    ) as { status: string; registry: { tenants: number; allActive: boolean } };

    expect(health.status).toBe('ok');
    expect(health.registry.tenants).toBe(EXPECTED_MIGRATION_COUNTS.registryTenants);
    expect(health.registry.allActive).toBe(true);

    const adminToken = await login(app, 'manoj.bose@gmail.com');
    const borrowersRes = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(adminToken, 'client_sunrise_001'),
    });

    expect(borrowersRes.statusCode).toBe(200);
    const body = JSON.parse(borrowersRes.body) as { borrowers: unknown[] };
    expect(body.borrowers).toHaveLength(EXPECTED_MIGRATION_COUNTS.sunriseBorrowers);
  }, 30_000);
});
