import { MongoClient } from 'mongodb';
import { loadEnv } from '../config/env.js';

let client: MongoClient | null = null;

export async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;

  const env = loadEnv();
  client = new MongoClient(env.MONGO_URI, {
    maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 2_000,
    connectTimeoutMS: 2_000,
  });
  await client.connect();
  return client;
}

export async function closeMongoClient(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}

export function getMongoClientSync(): MongoClient {
  if (!client) {
    throw new Error('MongoClient is not connected');
  }
  return client;
}
