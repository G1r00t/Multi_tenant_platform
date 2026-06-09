import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../../config/env.js';
import { getMongoClient } from '../../db/client.js';
import { pingRedis } from '../../auth/revocation.js';
import { loadRegistry } from '../../registry/index.js';
import { getBreakerStatuses } from '../../db/circuit-breaker.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const env = loadEnv();
    let mongoStatus = 'disconnected';
    let registryStatus = { tenants: 0, allActive: false };

    try {
      await getMongoClient();
      mongoStatus = 'connected';
      const registry = await loadRegistry();
      registryStatus = {
        tenants: registry.length,
        allActive: registry.every((r) => r.status === 'active'),
      };
    } catch {
      mongoStatus = 'disconnected';
    }

    const redisOk = await pingRedis();
    const breakers = getBreakerStatuses();
    const status = mongoStatus === 'connected' && redisOk && registryStatus.allActive ? 'ok' : 'degraded';

    return reply.send({
      status,
      mongo: mongoStatus,
      redis: redisOk ? 'connected' : 'disconnected',
      registry: registryStatus,
      breakers,
      pool: { service: env.SERVICE_NAME, maxPoolSize: env.MONGO_MAX_POOL_SIZE },
    });
  });
}
