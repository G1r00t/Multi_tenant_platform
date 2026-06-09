import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // migration tests wipe shared Mongo state — never run test files in parallel
    fileParallelism: false,
    env: {
      MONGO_URI: 'mongodb://127.0.0.1:27017',
      REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_SECRET: 'local-dev-jwt-secret-min-16-chars',
      MASTER_KEY: '0123456789abcdef0123456789abcdef',
      SEED_DATA_PATH: './seed-data',
      DEFAULT_PASSWORD: 'changeme',
      SERVICE_NAME: 'api',
      MONGO_MAX_POOL_SIZE: '6',
    },
  },
});
