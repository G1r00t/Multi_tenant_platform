import { Queue } from 'bullmq';
import { getRedis } from '../auth/revocation.js';

export const QUEUE_NAME = 'platform-jobs';

export interface JobStatusRecord {
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

let queue: Queue | null = null;

function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

export function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', maxRetriesPerRequest: null },
    });
  }
  return queue;
}

export async function setJobStatus(jobId: string, update: Partial<JobStatusRecord>): Promise<void> {
  const redis = getRedis();
  if (redis.status !== 'ready') {
    await redis.connect();
  }

  const existing = await redis.get(jobKey(jobId));
  const current = existing ? (JSON.parse(existing) as JobStatusRecord) : { status: 'queued' as const };
  await redis.set(jobKey(jobId), JSON.stringify({ ...current, ...update }), 'EX', 86_400);
}

export async function getJobStatus(jobId: string): Promise<JobStatusRecord | null> {
  const redis = getRedis();
  if (redis.status !== 'ready') {
    await redis.connect();
  }

  const raw = await redis.get(jobKey(jobId));
  return raw ? (JSON.parse(raw) as JobStatusRecord) : null;
}

export async function enqueueJob(name: string, data: Record<string, unknown>): Promise<string> {
  const job = await getQueue().add(name, data, {
    removeOnComplete: 200,
    removeOnFail: 100,
  });
  const jobId = String(job.id);
  await setJobStatus(jobId, { status: 'queued' });
  return jobId;
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
