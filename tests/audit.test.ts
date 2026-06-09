import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';

const mongoUp = await isMongoAvailable();

interface AuditLogEntry {
  userId: string;
  role: string;
  tenantId: string;
  method: string;
  endpoint: string;
  resourceIds: string[];
  maskingLevel: string;
  outcome: 'success' | 'failure';
  statusCode: number;
}

async function fetchRecentAuditLogs(
  app: FastifyInstance,
  token: string,
  limit = 20,
): Promise<AuditLogEntry[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/audit-logs?limit=${limit}`,
    headers: authHeaders(token, 'client_sunrise_001'),
  });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { logs: AuditLogEntry[] }).logs;
}

describe.skipIf(!mongoUp)('audit trail', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
    adminToken = await login(app, 'manoj.bose@gmail.com');
  });

  afterAll(async () => {
    await closeMongoClient();
  });

  it('writes PII-free audit records for successful access', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(adminToken, 'client_sunrise_001'),
    });
    expect(res.statusCode).toBe(200);

    const logs = await fetchRecentAuditLogs(app, adminToken);
    const entry = logs.find((log) => log.endpoint === '/borrowers' && log.outcome === 'success');
    expect(entry).toBeTruthy();
    expect(entry!.userId).toBeTruthy();
    expect(entry!.maskingLevel).toBe('full');
    expect(JSON.stringify(entry)).not.toMatch(/\d{10}/);
  });

  it('logs failed scope access', async () => {
    const counselorA = await login(app, 'vivekkamath@outlook.com');
    const counselorB = await login(app, 'ajay.menon@hotmail.com');

    const listRes = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(counselorB),
    });
    const foreignId = (JSON.parse(listRes.body) as { borrowers: Array<{ borrowerId: string }> }).borrowers[0]!
      .borrowerId;

    const res = await app.inject({
      method: 'GET',
      url: `/borrowers/${foreignId}`,
      headers: authHeaders(counselorA),
    });
    expect(res.statusCode).toBe(403);

    const logs = await fetchRecentAuditLogs(app, adminToken);
    const entry = logs.find(
      (log) => log.endpoint === `/borrowers/${foreignId}` && log.outcome === 'failure',
    );
    expect(entry).toBeTruthy();
    expect(entry!.statusCode).toBe(403);
  });
});
