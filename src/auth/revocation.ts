import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';
import { getSystemDb } from '../db/router.js';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(loadEnv().REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      lazyConnect: true,
    });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

function revocationKey(jti: string): string {
  return `revoked:${jti}`;
}

export async function revokeToken(jti: string, userId: string): Promise<void> {
  const client = getRedis();
  await client.set(revocationKey(jti), '1');

  await getSystemDb().collection('revocations').insertOne({
    jti,
    userId,
    revokedAt: new Date(),
  });
}

export async function isTokenRevoked(jti: string): Promise<boolean> {
  const client = getRedis();
  const result = await client.get(revocationKey(jti));
  return result === '1';
}

export async function pingRedis(): Promise<boolean> {
  try {
    const client = getRedis();
    if (client.status !== 'ready') {
      await client.connect();
    }
    const result = await client.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}
