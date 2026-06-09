import { Worker, Queue } from 'bullmq';
import { loadEnv } from './config/env.js';
import { getMongoClient, closeMongoClient } from './db/client.js';
import { closeRedis, getRedis } from './auth/revocation.js';
import { dispatchJob } from './workers/processors.js';
import { QUEUE_NAME, closeQueue } from './workers/queue.js';
import { startCronDispatcher } from './workers/cron.js';

async function main(): Promise<void> {
  process.env.SERVICE_NAME = 'worker';
  const env = loadEnv();

  await getMongoClient();
  await getRedis().connect();

  const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null as null };

  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.add('worker-ready', { startedAt: new Date().toISOString() });

  const worker = new Worker(QUEUE_NAME, dispatchJob, { connection });

  worker.on('failed', (job, err) => {
    console.error(
      JSON.stringify({ event: 'job_failed', jobId: job?.id, name: job?.name, message: err.message }),
    );
  });

  const cronHandle = startCronDispatcher();

  console.log(JSON.stringify({ event: 'worker_ready' }));

  const shutdown = async () => {
    clearInterval(cronHandle);
    await worker.close();
    await closeQueue();
    await closeRedis();
    await closeMongoClient();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'worker_failed', message: error.message }));
  process.exit(1);
});
