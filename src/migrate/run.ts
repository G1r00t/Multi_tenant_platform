import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from 'mongodb';
import { loadEnv } from '../config/env.js';
import { getMongoClient, closeMongoClient } from '../db/client.js';
import { SYSTEM_DB, VAULT_DB } from '../db/router.js';
import { invalidateRegistryCache } from '../registry/index.js';
import {
  CANONICAL_TENANTS,
  type CanonicalTenantId,
  TENANT_SLUGS,
} from '../authz/types.js';
import { hashPassword } from '../auth/login.js';
import {
  normalizeBorrower,
  slugForTenant,
  tenantDbName,
  type SeedBorrower,
} from './normalize.js';
import { validateMigrationCounts } from './validate.js';

const BATCH_SIZE = 1000;

interface SeedUser {
  userId: string;
  email: string;
  role: string;
  clientId?: string;
  status: string;
}

async function readJson<T>(seedPath: string, file: string): Promise<T> {
  const content = await readFile(path.join(seedPath, file), 'utf8');
  return JSON.parse(content) as T;
}

async function ensureCollection(db: Db, name: string, indexes: Record<string, 1>[] = []): Promise<void> {
  const collections = await db.listCollections({ name }).toArray();
  if (collections.length === 0) {
    await db.createCollection(name);
  }
  for (const index of indexes) {
    await db.collection(name).createIndex(index);
  }
}

async function bootstrapDatabases(): Promise<void> {
  const client = await getMongoClient();
  const system = client.db(SYSTEM_DB);
  const vault = client.db(VAULT_DB);

  const systemCollections = [
    'tenant_registry',
    'clients',
    'users',
    'revocations',
    'legacy_access_logs',
    'quarantine_borrowers',
    'migration_log',
    'security_incidents',
  ];
  for (const name of systemCollections) {
    await ensureCollection(system, name);
  }

  await ensureCollection(vault, 'tenant_deks');
  await ensureCollection(vault, 'borrower_tweaks');

  for (const tenantId of CANONICAL_TENANTS) {
    const slug = slugForTenant(tenantId);
    const db = client.db(tenantDbName(slug, 1));
    await ensureCollection(db, 'borrowers', [{ assignedTo: 1 }, { status: 1 }, { dpdBucket: 1 }]);
    await ensureCollection(db, 'conversations', [{ borrowerId: 1 }]);
    await ensureCollection(db, 'payments', [{ borrowerId: 1 }, { reference: 1 }]);
    await ensureCollection(db, 'audit_logs');
  }
}

async function clearExistingData(): Promise<void> {
  const client = await getMongoClient();
  const dbs = [
    SYSTEM_DB,
    VAULT_DB,
    ...CANONICAL_TENANTS.map((id) => tenantDbName(slugForTenant(id), 1)),
  ];

  for (const dbName of dbs) {
    const db = client.db(dbName);
    const collections = await db.listCollections().toArray();
    for (const col of collections) {
      await db.collection(col.name).deleteMany({});
    }
  }
}

function fixCrossTenantAssignments(
  borrowers: Record<string, unknown>[],
  users: SeedUser[],
): { borrowers: Record<string, unknown>[]; fixes: Record<string, unknown>[] } {
  const counselorsByTenant = new Map<string, SeedUser[]>();
  for (const user of users) {
    if (user.role === 'debt-counselor' && user.clientId) {
      const list = counselorsByTenant.get(user.clientId) ?? [];
      list.push(user);
      counselorsByTenant.set(user.clientId, list);
    }
  }

  const loadCounts = new Map<string, number>();
  const fixes: Record<string, unknown>[] = [];

  const fixed = borrowers.map((borrower) => {
    const tenantId = borrower._tenantId as string;
    const assignedTo = borrower.assignedTo as string | null | undefined;
    if (!assignedTo || tenantId === 'quarantine') return borrower;

    const counselor = users.find((u) => u.userId === assignedTo);
    if (counselor && counselor.clientId === tenantId) {
      return borrower;
    }

    const counselors = counselorsByTenant.get(tenantId) ?? [];
    if (counselors.length === 0) return borrower;

    let selected = counselors[0];
    let minLoad = loadCounts.get(selected.userId) ?? 0;
    for (const c of counselors) {
      const load = loadCounts.get(c.userId) ?? 0;
      if (load < minLoad) {
        minLoad = load;
        selected = c;
      }
    }

    loadCounts.set(selected.userId, minLoad + 1);

    fixes.push({
      borrowerId: borrower.borrowerId,
      previousAssignedTo: assignedTo,
      newAssignedTo: selected.userId,
      tenantId,
      reason: 'cross_tenant_assignment_fix',
      fixedAt: new Date(),
    });

    return { ...borrower, assignedTo: selected.userId };
  });

  return { borrowers: fixed, fixes };
}

async function bulkInsert(db: Db, collection: string, docs: Record<string, unknown>[]): Promise<void> {
  if (docs.length === 0) return;
  const col = db.collection(collection);
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    await col.insertMany(batch, { ordered: false });
  }
}

export async function runMigration(): Promise<void> {
  const started = Date.now();
  const env = loadEnv();
  const seedPath = env.SEED_DATA_PATH;

  await getMongoClient();
  await bootstrapDatabases();
  await clearExistingData();

  const [clientsData, users, borrowersRaw, conversations, payments, accessLogs] = await Promise.all([
    readJson<Record<string, unknown>[]>(seedPath, 'clients.json'),
    readJson<SeedUser[]>(seedPath, 'users.json'),
    readJson<SeedBorrower[]>(seedPath, 'borrowers.json'),
    readJson<Record<string, unknown>[]>(seedPath, 'conversations.json'),
    readJson<Record<string, unknown>[]>(seedPath, 'payments.json'),
    readJson<Record<string, unknown>[]>(seedPath, 'access_logs.json'),
  ]);

  const client = await getMongoClient();
  const system = client.db(SYSTEM_DB);

  await bulkInsert(system, 'legacy_access_logs', accessLogs);
  await bulkInsert(system, 'clients', clientsData);

  const passwordHash = await hashPassword(env.DEFAULT_PASSWORD);
  const userDocs = users.map((u) => ({
    userId: u.userId,
    email: u.email,
    role: u.role,
    clientId: u.clientId,
    status: u.status,
    passwordHash,
  }));
  await bulkInsert(system, 'users', userDocs);

  const registryEntries = CANONICAL_TENANTS.map((clientId) => ({
    clientId,
    dbName: tenantDbName(slugForTenant(clientId), 1),
    slug: TENANT_SLUGS[clientId],
    version: 1,
    status: 'active' as const,
    updatedAt: new Date(),
  }));
  await bulkInsert(system, 'tenant_registry', registryEntries);

  const partitioned: Record<CanonicalTenantId | 'quarantine', Record<string, unknown>[]> = {
    client_sunrise_001: [],
    client_metro_002: [],
    client_digital_003: [],
    quarantine: [],
  };

  for (const raw of borrowersRaw) {
    const { record, resolvedTenant } = normalizeBorrower(raw);
    record._tenantId = resolvedTenant;
    partitioned[resolvedTenant].push(record);
  }

  const { borrowers: fixedBorrowers, fixes } = fixCrossTenantAssignments(
    [
      ...partitioned.client_sunrise_001,
      ...partitioned.client_metro_002,
      ...partitioned.client_digital_003,
    ],
    users,
  );

  if (fixes.length > 0) {
    await bulkInsert(system, 'migration_log', fixes);
  }

  const byTenant: Record<CanonicalTenantId, Record<string, unknown>[]> = {
    client_sunrise_001: [],
    client_metro_002: [],
    client_digital_003: [],
  };

  for (const b of fixedBorrowers) {
    const tenantId = b._tenantId as CanonicalTenantId;
    const { _tenantId, ...rest } = b;
    byTenant[tenantId].push(rest);
  }

  for (const tenantId of CANONICAL_TENANTS) {
    const db = client.db(tenantDbName(slugForTenant(tenantId), 1));
    await bulkInsert(db, 'borrowers', byTenant[tenantId]);
  }

  await bulkInsert(system, 'quarantine_borrowers', partitioned.quarantine);

  const borrowerTenantMap = new Map<string, CanonicalTenantId>();
  for (const tenantId of CANONICAL_TENANTS) {
    for (const b of byTenant[tenantId]) {
      borrowerTenantMap.set(String(b.borrowerId), tenantId);
    }
  }

  const conversationsByTenant: Record<CanonicalTenantId, Record<string, unknown>[]> = {
    client_sunrise_001: [],
    client_metro_002: [],
    client_digital_003: [],
  };

  for (const convo of conversations) {
    const tenantId = borrowerTenantMap.get(String(convo.borrowerId));
    if (!tenantId) continue;
    const { clientId: _c, ...rest } = convo as Record<string, unknown> & { clientId?: string };
    conversationsByTenant[tenantId].push(rest);
  }

  const paymentsByTenant: Record<CanonicalTenantId, Record<string, unknown>[]> = {
    client_sunrise_001: [],
    client_metro_002: [],
    client_digital_003: [],
  };

  for (const payment of payments) {
    const tenantId = borrowerTenantMap.get(String(payment.borrowerId));
    if (!tenantId) continue;
    const { clientId: _c, ...rest } = payment as Record<string, unknown> & { clientId?: string };
    paymentsByTenant[tenantId].push(rest);
  }

  for (const tenantId of CANONICAL_TENANTS) {
    const db = client.db(tenantDbName(slugForTenant(tenantId), 1));
    await bulkInsert(db, 'conversations', conversationsByTenant[tenantId]);
    await bulkInsert(db, 'payments', paymentsByTenant[tenantId]);
  }

  await validateMigrationCounts({
    sunriseBorrowers: byTenant.client_sunrise_001.length,
    metroBorrowers: byTenant.client_metro_002.length,
    digitalBorrowers: byTenant.client_digital_003.length,
    quarantineBorrowers: partitioned.quarantine.length,
    conversations: conversations.length,
    payments: payments.length,
    users: userDocs.length,
    legacyLogs: accessLogs.length,
    assignmentFixes: fixes.length,
  });

  invalidateRegistryCache();

  const durationMs = Date.now() - started;
  console.log(
    JSON.stringify({
      event: 'migration_complete',
      durationMs,
      durationSeconds: (durationMs / 1000).toFixed(2),
      assignmentFixes: fixes.length,
    }),
  );
}

export async function runMigrationAndExit(): Promise<void> {
  try {
    await runMigration();
    await closeMongoClient();
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'migration_failed',
        message: error instanceof Error ? error.message : 'unknown_error',
      }),
    );
    await closeMongoClient();
    process.exit(1);
  }
}
