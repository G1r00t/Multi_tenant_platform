import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MONGO_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{32}$/),
  SEED_DATA_PATH: z.string().min(1),
  DEFAULT_PASSWORD: z.string().min(1).default('changeme'),
  API_PORT: z.coerce.number().default(3000),
  SERVICE_NAME: z.enum(['api', 'worker', 'migrator']).default('api'),
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(10).default(6),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = envSchema.parse(process.env);
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}

