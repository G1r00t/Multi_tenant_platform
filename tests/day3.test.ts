import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { closeRedis, getRedis } from '../src/auth/revocation.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';
import * as quietHours from '../src/compliance/quiet-hours.js';
import { processPaymentWebhook } from '../src/workers/processors.js';

const mongoUp = await isMongoAvailable();

describe.skipIf(!mongoUp)('day 3 endpoints', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let adminToken: string;
  let counselorToken: string;
  let engineerToken: string;
  let viewerToken: string;
  let borrowerId: string;
  let paymentReference: string;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
    await getRedis().connect();

    adminToken = await login(app, 'manoj.bose@gmail.com');
    counselorToken = await login(app, 'vivekkamath@outlook.com');
    engineerToken = await login(app, 'rohitsingh@rediffmail.com');
    viewerToken = await login(app, 'sachin_mukherjee1993@gmail.com');

    const listRes = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(counselorToken),
    });
    const list = JSON.parse(listRes.body) as { borrowers: Array<{ borrowerId: string }> };
    borrowerId = list.borrowers[0]!.borrowerId;

    const paymentsRes = await app.inject({
      method: 'GET',
      url: `/payments/${borrowerId}`,
      headers: authHeaders(counselorToken),
    });
    const payments = JSON.parse(paymentsRes.body) as {
      payments: Array<{ reference: string }>;
    };
    paymentReference = payments.payments[0]?.reference ?? 'PAY-client_s-test0001';
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeRedis();
    await closeMongoClient();
  });

  it('returns conversation history for assigned counselor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${borrowerId}`,
      headers: authHeaders(counselorToken),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { conversations: unknown[] };
    expect(Array.isArray(body.conversations)).toBe(true);
  });

  it('blocks client-viewer from conversations', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${borrowerId}`,
      headers: authHeaders(viewerToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks agent messages during quiet hours', async () => {
    vi.spyOn(quietHours, 'assertAgentMessageAllowed').mockImplementation((sender) => {
      if (sender === 'agent') {
        throw new quietHours.QuietHoursViolationError();
      }
    });

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${borrowerId}/messages`,
      headers: authHeaders(counselorToken),
      payload: { sender: 'agent', text: 'Reminder to pay' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts payment webhook and processes job in tenant DB', async () => {
    const webhookRes = await app.inject({
      method: 'POST',
      url: '/webhooks/payment-gateway',
      payload: {
        reference: paymentReference,
        gatewayReference: 'GW-test-webhook',
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
        reference: paymentReference,
        gatewayReference: 'GW-test-webhook',
        status: 'completed',
        requestId: 'test-request',
      },
    } as never);

    const paymentRes = await app.inject({
      method: 'GET',
      url: `/payments/${borrowerId}`,
      headers: authHeaders(counselorToken),
    });
    const body = JSON.parse(paymentRes.body) as {
      payments: Array<{ reference: string; status: string }>;
    };
    const updated = body.payments.find((p) => p.reference === paymentReference);
    expect(updated?.status).toBe('completed');
  });

  it('queues compliance report for engineer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/compliance',
      headers: authHeaders(engineerToken, 'client_sunrise_001'),
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { jobId: string; status: string };
    expect(body.status).toBe('queued');
    expect(body.jobId).toBeTruthy();
  });

  it('returns audit logs for engineer with tenant header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/audit-logs?limit=5',
      headers: authHeaders(engineerToken, 'client_sunrise_001'),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { logs: unknown[] };
    expect(Array.isArray(body.logs)).toBe(true);
  });
});
