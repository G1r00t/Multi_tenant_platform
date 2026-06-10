import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { closeRedis, getRedis } from '../src/auth/revocation.js';
import { getTenantDbByClientId } from '../src/db/router.js';
import { tenantDbName, slugForTenant } from '../src/migrate/normalize.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';
import * as quietHours from '../src/compliance/quiet-hours.js';

const mongoUp = await isMongoAvailable();
const SUNRISE = 'client_sunrise_001';
const COUNSELOR_USER_ID = '05f5e270-1190-449a-80fb-706b5f464d90';

function uniquePhone(): string {
  const digits = randomUUID().replace(/\D/g, '').slice(0, 9);
  return `9${digits.padStart(9, '0').slice(0, 9)}`;
}

describe.skipIf(!mongoUp)('live write paths (post-migration API)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let counselorToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
    await getRedis().connect();
    counselorToken = await login(app, 'vivekkamath@outlook.com');
    adminToken = await login(app, 'manoj.bose@gmail.com');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeRedis();
    await closeMongoClient();
  });

  it('POST /borrowers tokenizes PII and auto-assigns counselor', async () => {
    const phone = uniquePhone();
    const borrowerId = randomUUID();

    const res = await app.inject({
      method: 'POST',
      url: '/borrowers',
      headers: authHeaders(counselorToken),
      payload: {
        borrowerId,
        firstName: 'Live',
        lastName: 'WriteTest',
        phone,
        aadhaar: '123456789012',
        pan: 'ABCDE1234F',
        status: 'active',
        dpdBucket: '30-60',
        outstandingAmount: 10000,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      borrowerId: string;
      phone?: string;
      assignedTo?: string;
      phoneToken?: string;
    };
    expect(body.borrowerId).toBe(borrowerId);
    expect(body.phone).toBe(phone);
    expect(body.assignedTo).toBe(COUNSELOR_USER_ID);
    expect(body.phoneToken).toBeUndefined();

    const db = await getTenantDbByClientId(SUNRISE);
    const stored = await db.collection('borrowers').findOne({ borrowerId });
    expect(stored).toBeTruthy();
    expect(stored!.phoneToken).toMatch(/^\d{10}$/);
    expect(stored!.phone).toBeUndefined();
    expect(stored!.aadhaarToken).toMatch(/^\d{12}$/);
    expect(stored!.panToken).toMatch(/^[A-Z]{5}\d{4}[A-Z]$/);
    expect(stored!.assignedTo).toBe(COUNSELOR_USER_ID);
  });

  it('POST /conversations/:id/messages scrubs borrower PII from message text at write time', async () => {
    vi.spyOn(quietHours, 'assertAgentMessageAllowed').mockImplementation(() => {});

    const phone = uniquePhone();
    const borrowerId = randomUUID();

    const createRes = await app.inject({
      method: 'POST',
      url: '/borrowers',
      headers: authHeaders(counselorToken),
      payload: {
        borrowerId,
        firstName: 'Msg',
        lastName: 'ScrubTest',
        phone,
        status: 'active',
        dpdBucket: '30-60',
        outstandingAmount: 5000,
      },
    });
    expect(createRes.statusCode).toBe(201);

    const db = await getTenantDbByClientId(SUNRISE);
    const borrower = await db.collection('borrowers').findOne({ borrowerId });
    const phoneToken = String(borrower!.phoneToken);

    const msgRes = await app.inject({
      method: 'POST',
      url: `/conversations/${borrowerId}/messages`,
      headers: authHeaders(counselorToken),
      payload: {
        sender: 'agent',
        text: `Please confirm your number ${phone} before we proceed.`,
      },
    });
    expect(msgRes.statusCode).toBe(201);

    const convo = await db.collection('conversations').findOne({ borrowerId });
    expect(convo).toBeTruthy();
    const storedText = (convo!.messages as Array<{ text: string }>)[0]!.text;
    expect(storedText).toContain(phoneToken);
    expect(storedText).not.toContain(phone);

    const apiRes = await app.inject({
      method: 'GET',
      url: `/conversations/${borrowerId}`,
      headers: authHeaders(counselorToken),
    });
    expect(apiRes.statusCode).toBe(200);
    const apiBody = JSON.parse(apiRes.body) as {
      conversations: Array<{ messages: Array<{ text: string }> }>;
    };
    const apiText = apiBody.conversations[0]!.messages[0]!.text;
    expect(apiText).toContain(phone);
    expect(apiText).not.toContain(phoneToken);
  });

  it('PUT /borrowers/:id re-tokenizes changed PII fields', async () => {
    const originalPhone = uniquePhone();
    const updatedPhone = uniquePhone();
    const borrowerId = randomUUID();

    const createRes = await app.inject({
      method: 'POST',
      url: '/borrowers',
      headers: authHeaders(adminToken, SUNRISE),
      payload: {
        borrowerId,
        firstName: 'Update',
        lastName: 'Test',
        phone: originalPhone,
        status: 'active',
        dpdBucket: '60-90',
        outstandingAmount: 8000,
        assignedTo: COUNSELOR_USER_ID,
      },
    });
    expect(createRes.statusCode).toBe(201);

    const db = await getTenantDbByClientId(SUNRISE);
    const before = await db.collection('borrowers').findOne({ borrowerId });
    const originalToken = String(before!.phoneToken);

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/borrowers/${borrowerId}`,
      headers: authHeaders(adminToken, SUNRISE),
      payload: { phone: updatedPhone },
    });
    expect(updateRes.statusCode).toBe(200);

    const updated = JSON.parse(updateRes.body) as { phone?: string };
    expect(updated.phone).toBe(updatedPhone);

    const after = await db.collection('borrowers').findOne({ borrowerId });
    expect(after!.phoneToken).toMatch(/^\d{10}$/);
    expect(after!.phoneToken).not.toBe(originalToken);
    expect(after!.phone).toBeUndefined();

    const counselorView = await app.inject({
      method: 'GET',
      url: `/borrowers/${borrowerId}`,
      headers: authHeaders(counselorToken),
    });
    expect(counselorView.statusCode).toBe(200);
    expect(JSON.parse(counselorView.body).phone).toBe(updatedPhone);
  });

  it('POST /payments records payment for scoped borrower', async () => {
    const borrowerId = randomUUID();
    const paymentId = randomUUID();
    const reference = `PAY-client_s-live-${randomUUID().slice(0, 8)}`;

    const createRes = await app.inject({
      method: 'POST',
      url: '/borrowers',
      headers: authHeaders(counselorToken),
      payload: {
        borrowerId,
        firstName: 'Pay',
        lastName: 'Test',
        phone: uniquePhone(),
        status: 'active',
        dpdBucket: '30-60',
        outstandingAmount: 3000,
      },
    });
    expect(createRes.statusCode).toBe(201);

    const payRes = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: authHeaders(counselorToken),
      payload: {
        paymentId,
        borrowerId,
        amount: 1500,
        currency: 'INR',
        method: 'upi',
        status: 'pending',
        reference,
        channel: 'agent_collected',
      },
    });
    expect(payRes.statusCode).toBe(201);

    const created = JSON.parse(payRes.body) as {
      paymentId: string;
      borrowerId: string;
      amount: number;
      reference: string;
      status: string;
    };
    expect(created.paymentId).toBe(paymentId);
    expect(created.borrowerId).toBe(borrowerId);
    expect(created.amount).toBe(1500);
    expect(created.reference).toBe(reference);
    expect(created.status).toBe('pending');

    const dbName = tenantDbName(slugForTenant(SUNRISE), 1);
    const stored = await (await getMongoClient())
      .db(dbName)
      .collection('payments')
      .findOne({ paymentId });
    expect(stored?.reference).toBe(reference);
    expect(stored?.borrowerId).toBe(borrowerId);

    const listRes = await app.inject({
      method: 'GET',
      url: `/payments/${borrowerId}`,
      headers: authHeaders(counselorToken),
    });
    expect(listRes.statusCode).toBe(200);
    const payments = JSON.parse(listRes.body) as {
      payments: Array<{ paymentId: string; reference: string }>;
    };
    expect(payments.payments.some((p) => p.paymentId === paymentId)).toBe(true);
  });
});
