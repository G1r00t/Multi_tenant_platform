import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { closeMongoClient, getMongoClient } from '../src/db/client.js';
import { tenantDbName, slugForTenant } from '../src/migrate/normalize.js';
import { authHeaders, isMongoAvailable, login } from './helpers.js';

const mongoUp = await isMongoAvailable();

/** Seed borrower whose phone is scrubbed into WhatsApp conversation messages. */
const CONSISTENCY_BORROWER_ID = '709dc7f4-65f0-4791-b4a7-367092ba16da';
const CONSISTENCY_PLAIN_PHONE = '7936043811';

describe.skipIf(!mongoUp)('tokenization consistency', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
    await getMongoClient();
  });

  afterAll(async () => {
    await closeMongoClient();
  });

  it('matches borrower phone token in conversation messages', async () => {
    const adminToken = await login(app, 'manoj.bose@gmail.com');
    const client = await getMongoClient();
    const db = client.db(tenantDbName(slugForTenant('client_sunrise_001'), 1));

    const borrower = await db.collection('borrowers').findOne({
      borrowerId: CONSISTENCY_BORROWER_ID,
      phoneToken: { $exists: true },
    });
    expect(borrower?.phoneToken).toBeTruthy();

    // Token is embedded inside message text, not the whole message field.
    const conversation = await db.collection('conversations').findOne({
      borrowerId: borrower!.borrowerId,
      'messages.text': { $regex: borrower!.phoneToken as string },
    });
    expect(conversation).toBeTruthy();

    const listRes = await app.inject({
      method: 'GET',
      url: '/borrowers',
      headers: authHeaders(adminToken, 'client_sunrise_001'),
    });
    const list = JSON.parse(listRes.body) as { borrowers: Array<{ borrowerId: string; phone?: string }> };
    const fromApi = list.borrowers.find((b) => b.borrowerId === borrower!.borrowerId);
    expect(fromApi?.phone).toBe(CONSISTENCY_PLAIN_PHONE);
  });
});
