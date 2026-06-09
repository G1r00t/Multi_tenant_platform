import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';

const mongoUp = await isMongoAvailable();

describe.skipIf(!mongoUp)('tenant isolation under concurrent load', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
  });

  afterAll(async () => {
    await closeMongoClient();
  });

  it('never returns cross-tenant borrower IDs', async () => {
    const [sunriseAdmin, metroAdmin, digitalAdmin] = await Promise.all([
      login(app, 'manoj.bose@gmail.com'),
      login(app, 'vivek.shah30@hotmail.com'),
      login(app, 'deepak.verma@rediffmail.com'),
    ]);

    const tenants = [
      { token: sunriseAdmin, tenantId: 'client_sunrise_001' },
      { token: metroAdmin, tenantId: 'client_metro_002' },
      { token: digitalAdmin, tenantId: 'client_digital_003' },
    ];

    const responses = await Promise.all(
      tenants.flatMap(({ token, tenantId }) =>
        Array.from({ length: 5 }, () =>
          app.inject({
            method: 'GET',
            url: '/borrowers',
            headers: authHeaders(token, tenantId),
          }),
        ),
      ),
    );

    const idsByTenant = new Map<string, Set<string>>();
    for (let i = 0; i < tenants.length; i++) {
      const tenantId = tenants[i]!.tenantId;
      const tenantResponses = responses.slice(i * 5, i * 5 + 5);
      const ids = new Set<string>();
      for (const res of tenantResponses) {
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { borrowers: Array<{ borrowerId: string }> };
        for (const b of body.borrowers) {
          ids.add(b.borrowerId);
        }
      }
      idsByTenant.set(tenantId, ids);
    }

    const allIds = [...idsByTenant.values()];
    for (let i = 0; i < allIds.length; i++) {
      for (let j = i + 1; j < allIds.length; j++) {
        const overlap = [...allIds[i]!].filter((id) => allIds[j]!.has(id));
        expect(overlap).toEqual([]);
      }
    }
  });
});
