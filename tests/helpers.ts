import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';

export async function login(app: FastifyInstance, email: string, password = 'changeme'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${res.body}`);
  }
  return (JSON.parse(res.body) as { token: string }).token;
}

export function authHeaders(token: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  if (tenantId) {
    headers['x-tenant-id'] = tenantId;
  }
  return headers;
}

/** Audit logs must never carry borrower PII fields or phone-shaped resource IDs. */
export function assertAuditLogsContainNoPii(logs: unknown[]): void {
  const forbidden = ['phone', 'email', 'aadhaar', 'pan', 'bankAccount', 'firstName', 'lastName'];
  for (const log of logs) {
    const entry = log as Record<string, unknown>;
    for (const key of forbidden) {
      expect(entry).not.toHaveProperty(key);
    }
    const resourceIds = entry.resourceIds as string[] | undefined;
    if (resourceIds) {
      for (const id of resourceIds) {
        expect(id).not.toMatch(/^[6-9]\d{9}$/);
      }
    }
  }
}

export async function isMongoAvailable(): Promise<boolean> {
  try {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017', {
      serverSelectionTimeoutMS: 2000,
    });
    await client.connect();
    await client.close();
    return true;
  } catch {
    return false;
  }
}
