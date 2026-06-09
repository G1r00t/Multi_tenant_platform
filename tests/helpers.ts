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
