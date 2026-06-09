import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { getMongoClient, closeMongoClient } from '../src/db/client.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';

const mongoUp = await isMongoAvailable();

describe.skipIf(!mongoUp)('borrower scope and masking', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let counselorA: string;
  let counselorB: string;
  let adminToken: string;
  let engineerToken: string;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
    counselorA = await login(app, 'vivekkamath@outlook.com');
    counselorB = await login(app, 'ajay.menon@hotmail.com');
    adminToken = await login(app, 'manoj.bose@gmail.com');
    engineerToken = await login(app, 'rohitsingh@rediffmail.com');
  });

  afterAll(async () => {
    await closeMongoClient();
  });

  it('returns 403 when counselor accesses another counselors borrower', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(counselorB),
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body) as { borrowers: Array<{ borrowerId: string }> };
    expect(list.borrowers.length).toBeGreaterThan(0);
    const foreignId = list.borrowers[0]!.borrowerId;

    const res = await app.inject({
      method: 'GET',
      url: `/borrowers/${foreignId}`,
      headers: authHeaders(counselorA),
    });
    expect(res.statusCode).toBe(403);

    const client = await getMongoClient();
    const incident = await client
      .db('_system')
      .collection('security_incidents')
      .findOne({ type: 'scope_violation', borrowerId: foreignId });
    expect(incident).toBeTruthy();
  });

  it('counselor list only returns assigned borrowers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(counselorA),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { borrowers: Array<{ assignedTo?: string }> };
    expect(body.borrowers.length).toBeGreaterThan(0);
    for (const b of body.borrowers) {
      expect(b.assignedTo).toBe('05f5e270-1190-449a-80fb-706b5f464d90');
    }
  });

  it('admin sees detokenized phone', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(adminToken, 'client_sunrise_001'),
    });
    const list = JSON.parse(listRes.body) as { borrowers: Array<{ borrowerId: string; phone?: string }> };
    const borrower = list.borrowers[0]!;
    expect(borrower.phone).toMatch(/^\d{10}$/);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/borrowers/${borrower.borrowerId}`,
      headers: authHeaders(adminToken, 'client_sunrise_001'),
    });
    const detail = JSON.parse(detailRes.body) as { phone?: string; email?: string; pan?: string };
    expect(detail.phone).toMatch(/^\d{10}$/);
    expect(detail.email).toBeTruthy();
    expect(detail.pan).toMatch(/^[A-Z]{5}\d{4}[A-Z]$/);
  });

  it('engineer sees masked phone', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(engineerToken, 'client_sunrise_001'),
    });
    const list = JSON.parse(listRes.body) as { borrowers: Array<{ phone?: string }> };
    expect(list.borrowers[0]!.phone).toMatch(/^X+\d{4}$/);
  });
});
