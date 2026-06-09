import { runMigrationAndExit } from './migrate/run.js';

process.env.SERVICE_NAME = 'migrator';
process.env.MONGO_MAX_POOL_SIZE = process.env.MONGO_MAX_POOL_SIZE ?? '8';

runMigrationAndExit();
