import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { closeRedis, getRedis } from '../src/auth/revocation.js';
import { getTenantDbByClientId, getVaultDb, SYSTEM_DB } from '../src/db/router.js';
import { destroyBorrowerTweak, ensureBorrowerTweak } from '../src/pii/vault.js';
import { assertAuditLogsContainNoPii, authHeaders, isMongoAvailable, login } from './helpers.js';
import * as quietHours from '../src/compliance/quiet-hours.js';
import { redactEndpoint } from '../src/audit/writer.js';
import { processComplianceReport, processErasure } from '../src/workers/processors.js';

const mongoUp = await isMongoAvailable();

describe.skipIf(!mongoUp)('compliance rules (docs/compliance-rules.md)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let adminToken: string;
  let engineerToken: string;
  let counselorToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
    await getRedis().connect();

    adminToken = await login(app, 'manoj.bose@gmail.com');
    engineerToken = await login(app, 'rohitsingh@rediffmail.com');
    counselorToken = await login(app, 'vivekkamath@outlook.com');
    viewerToken = await login(app, 'sachin_mukherjee1993@gmail.com');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeRedis();
    await closeMongoClient();
  });

  describe('1. data residency', () => {
    it('stores tokenization keys in _vault, separate from tenant borrower data', async () => {
      const client = await getMongoClient();
      const vaultDeks = await client.db('_vault').collection('tenant_deks').countDocuments();
      const sunriseBorrowers = await client
        .db('tenant_sunrise__v1')
        .collection('borrowers')
        .countDocuments();
      const sunriseWithTokens = await client
        .db('tenant_sunrise__v1')
        .collection('borrowers')
        .countDocuments({ phoneToken: { $exists: true } });

      expect(vaultDeks).toBeGreaterThan(0);
      expect(sunriseBorrowers).toBeGreaterThan(0);
      expect(sunriseWithTokens).toBeGreaterThan(0);

      const vaultNames = (await client.db().admin().listDatabases()).databases.map((d) => d.name);
      expect(vaultNames).toContain('_vault');
      expect(vaultNames).toContain('tenant_sunrise__v1');
      expect(vaultNames).not.toEqual(['_vault']);
    });
  });

  describe('2. data retention', () => {
    it('erasure job purges PII from closed accounts older than 90 days but keeps metadata', async () => {
      const borrowerId = randomUUID();
      const oldUpdatedAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
      const sunriseDb = await getTenantDbByClientId('client_sunrise_001');

      await ensureBorrowerTweak('client_sunrise_001', borrowerId);
      await sunriseDb.collection('borrowers').insertOne({
        borrowerId,
        status: 'closed',
        updatedAt: oldUpdatedAt,
        dpdBucket: '180+',
        outstandingAmount: 0,
        phoneToken: '9999999999',
        aadhaarToken: '123456789012',
        email: 'erasure-test@example.com',
        firstName: 'Erase',
        lastName: 'Me',
      });

      await processErasure({
        id: 'erasure-test',
        name: 'erasure',
        data: { tenantId: 'client_sunrise_001', requestId: 'retention-test' },
      } as never);

      const borrower = await sunriseDb.collection('borrowers').findOne({ borrowerId });
      const tweak = await getVaultDb().collection('borrower_tweaks').findOne({ borrowerId });

      expect(borrower?.status).toBe('closed');
      expect(borrower?.dpdBucket).toBe('180+');
      expect(borrower?.phoneToken).toBeUndefined();
      expect(borrower?.email).toBeUndefined();
      expect(tweak).toBeNull();
    });
  });

  describe('3. communication timing (quiet hours)', () => {
    it('blocks agent messages during quiet hours but allows borrower messages', async () => {
      vi.spyOn(quietHours, 'assertAgentMessageAllowed').mockImplementation((sender) => {
        if (sender === 'agent') throw new quietHours.QuietHoursViolationError();
      });

      const listRes = await app.inject({
        method: 'GET',
        url: '/borrowers',
        headers: authHeaders(counselorToken),
      });
      const borrowerId = (JSON.parse(listRes.body) as { borrowers: Array<{ borrowerId: string }> })
        .borrowers[0]!.borrowerId;

      const blocked = await app.inject({
        method: 'POST',
        url: `/conversations/${borrowerId}/messages`,
        headers: authHeaders(counselorToken),
        payload: { sender: 'agent', text: 'Pay now' },
      });
      expect(blocked.statusCode).toBe(403);

      const allowed = await app.inject({
        method: 'POST',
        url: `/conversations/${borrowerId}/messages`,
        headers: authHeaders(counselorToken),
        payload: { sender: 'borrower', text: 'I will pay tomorrow' },
      });
      expect(allowed.statusCode).toBe(201);
    });

    it('audits quiet-hours violations and surfaces them in compliance reports', async () => {
      vi.spyOn(quietHours, 'assertAgentMessageAllowed').mockImplementation((sender) => {
        if (sender === 'agent') throw new quietHours.QuietHoursViolationError();
      });

      const listRes = await app.inject({
        method: 'GET',
        url: '/borrowers',
        headers: authHeaders(counselorToken),
      });
      const borrowerId = (JSON.parse(listRes.body) as { borrowers: Array<{ borrowerId: string }> })
        .borrowers[0]!.borrowerId;

      await app.inject({
        method: 'POST',
        url: `/conversations/${borrowerId}/messages`,
        headers: authHeaders(counselorToken),
        payload: { sender: 'agent', text: 'Blocked reminder' },
      });

      const queueRes = await app.inject({
        method: 'GET',
        url: '/reports/compliance',
        headers: authHeaders(engineerToken, 'client_sunrise_001'),
      });
      const { jobId } = JSON.parse(queueRes.body) as { jobId: string };

      await processComplianceReport({
        id: jobId,
        name: 'compliance-report',
        data: { tenantId: 'client_sunrise_001', fanOut: false, requestedBy: 'test', role: 'engineer' },
      } as never);

      const pollRes = await app.inject({
        method: 'GET',
        url: `/reports/compliance/${jobId}`,
        headers: authHeaders(engineerToken, 'client_sunrise_001'),
      });
      const body = JSON.parse(pollRes.body) as {
        result: { quietHourViolations: number };
      };
      expect(body.result.quietHourViolations).toBeGreaterThan(0);
    });
  });

  describe('4. data minimization', () => {
    it('returns aggregates only for client-viewer (no borrower PII)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/borrowers',
        headers: authHeaders(viewerToken),
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.totalBorrowers).toBeTypeOf('number');
      expect(body.borrowers).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(/\d{10}/);
    });

    it('omits unauthorized PII fields from engineer responses', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/borrowers',
        headers: authHeaders(engineerToken, 'client_sunrise_001'),
      });
      const borrower = (JSON.parse(listRes.body) as { borrowers: Array<Record<string, unknown>> })
        .borrowers[0]!;

      expect(borrower.phoneToken).toBeUndefined();
      expect(borrower.aadhaarToken).toBeUndefined();
      expect(borrower.phone).toMatch(/^X+\d{4}$/);
      expect(String(borrower.email ?? '')).not.toMatch(/@.*\..*$/);
    });

    it('masks sensitive IDs for counselors while exposing contact fields', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/borrowers',
        headers: authHeaders(counselorToken),
      });
      const borrower = (JSON.parse(listRes.body) as { borrowers: Array<Record<string, unknown>> })
        .borrowers[0]!;

      expect(borrower.phone).toMatch(/^\d{10}$/);
      expect(borrower.aadhaar).toMatch(/^X+\d{4}$/);
      expect(borrower.bankAccount).toMatch(/^X+\d{4}$/);
    });
  });

  describe('5. breach detection & response', () => {
    it('revokes session on cross-tenant header mismatch', async () => {
      const token = await login(app, 'vivekkamath@outlook.com');

      const breachRes = await app.inject({
        method: 'GET',
        url: '/borrowers',
        headers: authHeaders(token, 'client_metro_002'),
      });
      expect(breachRes.statusCode).toBe(403);

      const revokedRes = await app.inject({
        method: 'GET',
        url: '/borrowers',
        headers: authHeaders(token),
      });
      expect(revokedRes.statusCode).toBe(401);
      expect(JSON.parse(revokedRes.body)).toMatchObject({ error: 'token_revoked' });

      const client = await getMongoClient();
      const incident = await client
        .db(SYSTEM_DB)
        .collection('security_incidents')
        .find({ type: 'cross_tenant_header_mismatch' })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();
      expect(incident[0]?.flaggedForReview).toBe(true);
    });

    it('logs counselor scope violations as security incidents flagged for review', async () => {
      const counselorA = await login(app, 'vivekkamath@outlook.com');
      const counselorB = await login(app, 'ajay.menon@hotmail.com');

      const foreignId = (
        JSON.parse(
          (
            await app.inject({
              method: 'GET',
              url: '/borrowers',
              headers: authHeaders(counselorB),
            })
          ).body,
        ) as { borrowers: Array<{ borrowerId: string }> }
      ).borrowers[0]!.borrowerId;

      const res = await app.inject({
        method: 'GET',
        url: `/borrowers/${foreignId}`,
        headers: authHeaders(counselorA),
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('client_metro');

      const client = await getMongoClient();
      const incident = await client.db(SYSTEM_DB).collection('security_incidents').findOne({
        type: 'scope_violation',
        borrowerId: foreignId,
      });
      expect(incident?.flaggedForReview).toBe(true);
    });
  });

  describe('6. PII in logs', () => {
    it('redacts phone-like path segments in audit endpoints', () => {
      expect(redactEndpoint('/borrowers/7400433206')).toBe('/borrowers/[redacted]');
      expect(redactEndpoint('/borrowers/abc-uuid')).toBe('/borrowers/abc-uuid');
    });

    it('writes audit records without embedded PII payloads', async () => {
      await app.inject({
        method: 'GET',
        url: '/borrowers',
        headers: authHeaders(adminToken, 'client_sunrise_001'),
      });

      const auditRes = await app.inject({
        method: 'GET',
        url: '/audit-logs?limit=10',
        headers: authHeaders(adminToken, 'client_sunrise_001'),
      });
      const logs = (JSON.parse(auditRes.body) as { logs: unknown[] }).logs;
      assertAuditLogsContainNoPii(logs);
    });
  });

  describe('7. consent & right to erasure', () => {
    it('destroys vault tweaks so erased tokens are irreversible', async () => {
      const borrowerId = randomUUID();
      await ensureBorrowerTweak('client_sunrise_001', borrowerId);
      await destroyBorrowerTweak('client_sunrise_001', borrowerId);
      const tweak = await getVaultDb().collection('borrower_tweaks').findOne({ borrowerId });
      expect(tweak).toBeNull();
    });
  });

  describe('8. access control principles', () => {
    it('denies unauthenticated and invalid-token access by default', async () => {
      const noAuth = await app.inject({ method: 'GET', url: '/borrowers' });
      expect(noAuth.statusCode).toBe(401);

      const badToken = await app.inject({
        method: 'GET',
        url: '/borrowers',
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(badToken.statusCode).toBe(401);
    });

    it('blocks client-viewer from mutating payments', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers: authHeaders(viewerToken),
        payload: { borrowerId: 'any', amount: 1 },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
