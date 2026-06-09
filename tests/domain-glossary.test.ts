import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { SYSTEM_DB } from '../src/db/router.js';
import { isQuietHours, getLocalHour } from '../src/compliance/quiet-hours.js';
import { parsePaymentReference } from '../src/webhooks/reference.js';
import { tenantDbName, slugForTenant } from '../src/migrate/normalize.js';
import { CANONICAL_TENANTS } from '../src/authz/types.js';
import {
  BORROWER_STATUSES,
  CANONICAL_CLIENT_IDS,
  CLIENT_TYPES,
  CONVERSATION_CHANNELS,
  COUNSELOR_ROLE,
  DPD_BUCKETS,
  GATEWAY_REFERENCE_PATTERN,
  HARD_COLLECTION_BUCKETS,
  NPA_DPD_BUCKETS,
  PAYMENT_CHANNELS,
  PAYMENT_REFERENCE_PATTERN,
  PAYMENT_STATUSES,
  PLATFORM_ROLES,
  QUIET_HOURS,
  SOFT_COLLECTION_BUCKETS,
  isDpdBucket,
  isHardCollectionBucket,
  isNpaBucket,
  isSoftCollectionBucket,
} from '../src/domain/glossary.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';

interface SeedBorrower {
  clientId: string | null;
  assignedTo: string | null;
  dpdBucket: string;
  outstandingAmount: number;
  posAmount: number;
  tosAmount: number;
  settlementFloor: number;
  status: string;
  createdBy?: string;
  notes?: string;
}

interface SeedPayment {
  clientId: string;
  reference: string;
  gatewayReference: string;
  channel: string;
  status: string;
}

interface SeedClient {
  clientId: string;
  type: string;
}

interface SeedUser {
  userId: string;
  role: string;
  clientId?: string;
}

const seedPath = process.env.SEED_DATA_PATH ?? './seed-data';

async function loadSeed<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(seedPath, file), 'utf8')) as T;
}

function canonicalBorrowers(borrowers: SeedBorrower[]): SeedBorrower[] {
  return borrowers.filter((b) =>
    b.clientId ? (CANONICAL_CLIENT_IDS as readonly string[]).includes(b.clientId) : false,
  );
}

describe('domain glossary (docs/domain-glossary.md)', () => {
  describe('loan & account terms', () => {
    it('uses only documented DPD bucket ranges', async () => {
      const borrowers = await loadSeed<SeedBorrower[]>('borrowers.json');
      const buckets = new Set(borrowers.map((b) => b.dpdBucket));
      for (const bucket of buckets) {
        expect(isDpdBucket(bucket)).toBe(true);
      }
      expect([...DPD_BUCKETS].sort()).toEqual(['180+', '30-60', '60-90', '90-180']);
    });

    it('treats POS as equal to outstandingAmount for canonical accounts', async () => {
      const borrowers = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'));
      expect(borrowers.length).toBeGreaterThan(0);
      for (const borrower of borrowers) {
        expect(borrower.outstandingAmount).toBe(borrower.posAmount);
      }
    });

    it('keeps TOS below POS for canonical settlement offers', async () => {
      const borrowers = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'));
      for (const borrower of borrowers) {
        expect(borrower.tosAmount).toBeLessThan(borrower.posAmount);
        expect(borrower.settlementFloor).toBeLessThanOrEqual(borrower.posAmount);
      }
    });

    it('classifies NPA accounts as 90+ DPD buckets', async () => {
      const borrowers = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'));
      const npaBorrowers = borrowers.filter((b) => isNpaBucket(b.dpdBucket));
      expect(npaBorrowers.length).toBeGreaterThan(0);
      for (const borrower of npaBorrowers) {
        expect(NPA_DPD_BUCKETS).toContain(borrower.dpdBucket);
      }
    });

    it('includes closed accounts representing write-off state', async () => {
      const borrowers = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'));
      const closed = borrowers.filter((b) => b.status === 'closed');
      expect(closed.length).toBeGreaterThan(0);
      expect(BORROWER_STATUSES).toContain('closed');
    });
  });

  describe('collection process', () => {
    it('maps soft collection to 30–60 and 60–90 DPD buckets', async () => {
      const borrowers = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'));
      const soft = borrowers.filter((b) => isSoftCollectionBucket(b.dpdBucket));
      expect(soft.length).toBeGreaterThan(0);
      expect(SOFT_COLLECTION_BUCKETS).toEqual(['30-60', '60-90']);
    });

    it('maps hard collection to 90+ DPD buckets', async () => {
      const borrowers = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'));
      const hard = borrowers.filter((b) => isHardCollectionBucket(b.dpdBucket));
      expect(hard.length).toBeGreaterThan(0);
      expect(HARD_COLLECTION_BUCKETS).toEqual(NPA_DPD_BUCKETS);
    });

    it('records PTP and hardship cases in borrower notes', async () => {
      const borrowers = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'));
      const ptp = borrowers.filter((b) => b.notes?.includes('PTP'));
      const hardship = borrowers.filter((b) => b.notes?.toLowerCase().includes('hardship'));
      expect(ptp.length).toBeGreaterThan(0);
      expect(hardship.length).toBeGreaterThan(0);
    });

    it('uses dormant status for unresponsive accounts (ZCM)', async () => {
      const borrowers = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'));
      const dormant = borrowers.filter((b) => b.status === 'dormant');
      expect(dormant.length).toBeGreaterThan(0);
      expect(BORROWER_STATUSES).toContain('dormant');
    });
  });

  describe('compliance & regulatory', () => {
    it('defines quiet hours as 8 PM to 8 AM IST', () => {
      expect(QUIET_HOURS).toEqual({ startHour: 20, endHour: 8, timezone: 'Asia/Kolkata' });

      const ninePmIst = new Date('2026-06-08T15:30:00.000Z');
      const noonIst = new Date('2026-06-08T06:30:00.000Z');
      expect(getLocalHour(ninePmIst)).toBe(21);
      expect(isQuietHours(ninePmIst)).toBe(true);
      expect(isQuietHours(noonIst)).toBe(false);
    });

    it('onboards NBFC and cooperative bank clients', async () => {
      const clients = await loadSeed<SeedClient[]>('clients.json');
      expect(clients).toHaveLength(3);
      for (const client of clients) {
        expect(CLIENT_TYPES as readonly string[]).toContain(client.type);
      }
      expect(clients.filter((c) => c.type === 'NBFC').length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('platform-specific terms', () => {
    it('equates tenant and client via canonical clientId values', async () => {
      const clients = await loadSeed<SeedClient[]>('clients.json');
      const clientIds = clients.map((c) => c.clientId).sort();
      expect(clientIds).toEqual([...CANONICAL_CLIENT_IDS].sort());
      expect([...CANONICAL_TENANTS].sort()).toEqual(clientIds);
    });

    it('maps debt-counselor role to counselor users bound to a tenant', async () => {
      const users = await loadSeed<SeedUser[]>('users.json');
      const counselors = users.filter((u) => u.role === COUNSELOR_ROLE);
      expect(counselors.length).toBeGreaterThan(0);
      for (const counselor of counselors) {
        expect(counselor.clientId).toBeTruthy();
        expect((CANONICAL_CLIENT_IDS as readonly string[]).includes(counselor.clientId!)).toBe(true);
      }
      expect(PLATFORM_ROLES).toContain(COUNSELOR_ROLE);
    });

    it('assigns exactly one counselor per canonical borrower', async () => {
      const borrowers = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'));
      for (const borrower of borrowers) {
        expect(borrower.assignedTo).toBeTruthy();
        expect(typeof borrower.assignedTo).toBe('string');
      }
    });
  });

  describe('seed data fields', () => {
    it('stores domain amount fields on borrowers', async () => {
      const borrower = canonicalBorrowers(await loadSeed<SeedBorrower[]>('borrowers.json'))[0]!;
      expect(borrower).toMatchObject({
        dpdBucket: expect.any(String),
        outstandingAmount: expect.any(Number),
        posAmount: expect.any(Number),
        tosAmount: expect.any(Number),
        settlementFloor: expect.any(Number),
        assignedTo: expect.any(String),
        createdBy: expect.any(String),
      });
    });

    it('formats payment references as PAY-{tenant prefix}-{id}', async () => {
      const payments = await loadSeed<SeedPayment[]>('payments.json');
      expect(payments.length).toBeGreaterThan(0);
      for (const payment of payments) {
        expect(payment.reference).toMatch(PAYMENT_REFERENCE_PATTERN);
        expect(parsePaymentReference(payment.reference)).toBe(payment.clientId);
      }
    });

    it('stores gateway references and payment channels', async () => {
      const payments = await loadSeed<SeedPayment[]>('payments.json');
      const channels = new Set(payments.map((p) => p.channel));
      const statuses = new Set(payments.map((p) => p.status));

      for (const payment of payments) {
        expect(payment.gatewayReference).toMatch(GATEWAY_REFERENCE_PATTERN);
      }
      for (const channel of channels) {
        expect(PAYMENT_CHANNELS as readonly string[]).toContain(channel);
      }
      for (const status of statuses) {
        expect(PAYMENT_STATUSES as readonly string[]).toContain(status);
      }
    });
  });
});

const mongoUp = await isMongoAvailable();

describe.skipIf(!mongoUp)('domain glossary — migrated platform data', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
  });

  afterAll(async () => {
    await closeMongoClient();
  });

  it('isolates tenant data in per-client databases without clientId field', async () => {
    const client = await getMongoClient();
    for (const tenantId of CANONICAL_TENANTS) {
      const db = client.db(tenantDbName(slugForTenant(tenantId), 1));
      const withClientId = await db.collection('borrowers').countDocuments({ clientId: { $exists: true } });
      expect(withClientId).toBe(0);
      expect(await db.collection('borrowers').countDocuments()).toBeGreaterThan(0);
    }
  });

  it('links assignedTo counselors to active debt-counselor users', async () => {
    const client = await getMongoClient();
    const sunriseDb = client.db(tenantDbName('sunrise', 1));
    const system = client.db(SYSTEM_DB);

    const sample = await sunriseDb.collection('borrowers').findOne({ assignedTo: { $exists: true } });
    expect(sample?.assignedTo).toBeTruthy();

    const counselor = await system.collection('users').findOne({
      userId: sample!.assignedTo,
      role: COUNSELOR_ROLE,
      status: 'active',
    });
    expect(counselor).toBeTruthy();
  });

  it('stores conversation channels from the platform channel set', async () => {
    const client = await getMongoClient();
    const channels = await client
      .db(tenantDbName('sunrise', 1))
      .collection('conversations')
      .distinct('channel');

    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) {
      expect(CONVERSATION_CHANNELS as readonly string[]).toContain(channel);
    }
  });

  it('scopes counselor list to assigned accounts only', async () => {
    const counselorToken = await login(app, 'vivekkamath@outlook.com');
    const res = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(counselorToken),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as { borrowers: Array<{ assignedTo: string }> };
    expect(body.borrowers.length).toBeGreaterThan(0);
    const assignees = new Set(body.borrowers.map((b) => b.assignedTo));
    expect(assignees.size).toBe(1);
  });

  it('registers each client as an active tenant in the registry', async () => {
    const client = await getMongoClient();
    const system = client.db(SYSTEM_DB);
    const registry = await system.collection('tenant_registry').find({ status: 'active' }).toArray();
    const clients = await system.collection('clients').find({ status: 'active' }).toArray();

    expect(registry).toHaveLength(3);
    expect(clients).toHaveLength(3);
    expect(registry.map((r) => r.clientId).sort()).toEqual(
      clients.map((c) => c.clientId).sort(),
    );
  });
});
