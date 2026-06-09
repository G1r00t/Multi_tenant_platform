import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { closeRedis, getRedis } from '../src/auth/revocation.js';
import { getTenantDbByClientId } from '../src/db/router.js';
import { CANONICAL_TENANTS } from '../src/authz/types.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';
import { getJobStatus } from '../src/workers/queue.js';
import {
  processComplianceReport,
  processOverdueCheck,
  processPaymentWebhook,
} from '../src/workers/processors.js';

const mongoUp = await isMongoAvailable();

describe.skipIf(!mongoUp)('async processing (section 3.7)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let engineerToken: string;
  let counselorToken: string;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
    await getRedis().connect();

    engineerToken = await login(app, 'rohitsingh@rediffmail.com');
    counselorToken = await login(app, 'vivekkamath@outlook.com');
  });

  afterAll(async () => {
    await closeRedis();
    await closeMongoClient();
  });

  it('fan-out compliance report returns per-tenant metrics with platform-wide legacy summary', async () => {
    const queueRes = await app.inject({
      method: 'GET',
      url: '/reports/compliance',
      headers: authHeaders(engineerToken),
    });
    expect(queueRes.statusCode).toBe(202);

    const { jobId } = JSON.parse(queueRes.body) as { jobId: string };
    await processComplianceReport({
      id: jobId,
      name: 'compliance-report',
      data: { tenantId: null, fanOut: true, requestedBy: 'test', role: 'engineer' },
    } as never);

    const pollRes = await app.inject({
      method: 'GET',
      url: `/reports/compliance/${jobId}`,
      headers: authHeaders(engineerToken),
    });
    expect(pollRes.statusCode).toBe(200);

    const body = JSON.parse(pollRes.body) as {
      status: string;
      result: {
        tenants: Array<{
          tenantId: string;
          overduePayments: number;
          legacyBreachSummary: { totalLegacyAccessLogs: number };
        }>;
      };
    };

    expect(body.status).toBe('completed');
    expect(body.result.tenants).toHaveLength(3);
    expect(body.result.tenants.map((t) => t.tenantId).sort()).toEqual([...CANONICAL_TENANTS].sort());

    const legacyCounts = body.result.tenants.map((t) => t.legacyBreachSummary.totalLegacyAccessLogs);
    expect(new Set(legacyCounts).size).toBe(1);
    expect(legacyCounts[0]).toBeGreaterThan(0);

    const overdueByTenant = new Set(body.result.tenants.map((t) => t.overduePayments));
    expect(overdueByTenant.size).toBeGreaterThan(1);
  });

  it('single-tenant compliance report completes with tenant-scoped result', async () => {
    const queueRes = await app.inject({
      method: 'GET',
      url: '/reports/compliance',
      headers: authHeaders(engineerToken, 'client_sunrise_001'),
    });
    expect(queueRes.statusCode).toBe(202);

    const { jobId } = JSON.parse(queueRes.body) as { jobId: string };
    await processComplianceReport({
      id: jobId,
      name: 'compliance-report',
      data: { tenantId: 'client_sunrise_001', fanOut: false, requestedBy: 'test', role: 'engineer' },
    } as never);

    const status = await getJobStatus(jobId);
    expect(status?.status).toBe('completed');
    expect(status?.result).toMatchObject({ tenantId: 'client_sunrise_001' });
  });

  it('overdue-check updates only the targeted tenant database', async () => {
    const sunriseRef = `PAY-client_s-test-${randomUUID().slice(0, 8)}`;
    const metroRef = `PAY-client_m-test-${randomUUID().slice(0, 8)}`;
    const oldCreatedAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

    const sunriseDb = await getTenantDbByClientId('client_sunrise_001');
    const metroDb = await getTenantDbByClientId('client_metro_002');

    await sunriseDb.collection('payments').insertOne({
      paymentId: randomUUID(),
      borrowerId: 'test-borrower-sunrise',
      amount: 100,
      currency: 'INR',
      method: 'upi',
      status: 'pending',
      reference: sunriseRef,
      createdAt: oldCreatedAt,
    });
    await metroDb.collection('payments').insertOne({
      paymentId: randomUUID(),
      borrowerId: 'test-borrower-metro',
      amount: 100,
      currency: 'INR',
      method: 'upi',
      status: 'pending',
      reference: metroRef,
      createdAt: oldCreatedAt,
    });

    await processOverdueCheck({
      id: 'overdue-sunrise',
      name: 'overdue-check',
      data: { tenantId: 'client_sunrise_001', requestId: 'test-overdue' },
    } as never);

    const sunrisePayment = await sunriseDb.collection('payments').findOne({ reference: sunriseRef });
    const metroPayment = await metroDb.collection('payments').findOne({ reference: metroRef });

    expect(sunrisePayment?.status).toBe('overdue');
    expect(metroPayment?.status).toBe('pending');

    const audit = await sunriseDb
      .collection('audit_logs')
      .find({ endpoint: '/jobs/overdue-check' })
      .sort({ timestampUTC: -1 })
      .limit(1)
      .toArray();
    expect(audit[0]?.tenantId).toBe('client_sunrise_001');
  });

  it('payment webhook resolves tenant from reference and updates payment status', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(counselorToken),
    });
    const { borrowers } = JSON.parse(listRes.body) as { borrowers: Array<{ borrowerId: string }> };
    const borrowerId = borrowers[0]!.borrowerId;

    const reference = `PAY-client_s-webhook-${randomUUID().slice(0, 8)}`;
    const sunriseDb = await getTenantDbByClientId('client_sunrise_001');
    await sunriseDb.collection('payments').insertOne({
      paymentId: randomUUID(),
      borrowerId,
      amount: 500,
      currency: 'INR',
      method: 'upi',
      status: 'pending',
      reference,
      createdAt: new Date().toISOString(),
    });

    const webhookRes = await app.inject({
      method: 'POST',
      url: '/webhooks/payment-gateway',
      payload: {
        reference,
        gatewayReference: 'GW-async-test',
        status: 'completed',
      },
    });
    expect(webhookRes.statusCode).toBe(202);

    const { jobId } = JSON.parse(webhookRes.body) as { jobId: string };
    await processPaymentWebhook({
      id: jobId,
      name: 'payment-webhook',
      data: {
        tenantId: 'client_sunrise_001',
        reference,
        gatewayReference: 'GW-async-test',
        status: 'completed',
        requestId: 'test-webhook',
      },
    } as never);

    const paymentRes = await app.inject({
      method: 'GET',
      url: `/payments/${borrowerId}`,
      headers: authHeaders(counselorToken),
    });
    expect(paymentRes.statusCode).toBe(200);

    const body = JSON.parse(paymentRes.body) as {
      payments: Array<{ reference: string; status: string }>;
    };
    const updated = body.payments.find((p) => p.reference === reference);
    expect(updated?.status).toBe('completed');
  });

  it('rejects payment webhook when reference prefix is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/payment-gateway',
      payload: {
        reference: 'PAY-client_x-unknown',
        gatewayReference: 'GW-bad',
        status: 'completed',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
