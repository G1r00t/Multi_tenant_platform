import { loadEnv } from './config/env.js';
import { getMongoClient } from './db/client.js';
import { getRedis } from './auth/revocation.js';
import { buildServer } from './api/server.js';

async function main(): Promise<void> {
  process.env.SERVICE_NAME = 'api';
  const env = loadEnv();

  await getMongoClient();
  await getRedis().connect();

  const app = await buildServer();
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  console.log(JSON.stringify({ event: 'api_started', port: env.API_PORT }));
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'api_failed', message: error.message }));
  process.exit(1);
});
