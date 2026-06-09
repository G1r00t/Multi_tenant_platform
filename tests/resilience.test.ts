import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { injectTenantFault, resetBreakers } from '../src/db/circuit-breaker.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';

const mongoUp = await isMongoAvailable();

describe.skipIf(!mongoUp)('tenant circuit breaker', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
    adminToken = await login(app, 'manoj.bose@gmail.com');
  });

  afterAll(async () => {
    resetBreakers();
    await closeMongoClient();
  });

  it('returns 503 for faulted tenant while others succeed', async () => {
    injectTenantFault('client_metro_002', true);

    const faulted = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(adminToken, 'client_metro_002'),
    });
    expect(faulted.statusCode).toBe(503);
    expect(JSON.parse(faulted.body)).toEqual({ error: 'tenant_unavailable' });

    const healthy = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(adminToken, 'client_sunrise_001'),
    });
    expect(healthy.statusCode).toBe(200);

    injectTenantFault('client_metro_002', false);
  });
});
