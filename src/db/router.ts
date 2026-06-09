import type { Db } from 'mongodb';
import { getContext } from '../context/als.js';
import { getMongoClientSync } from './client.js';
import { resolveTenantDbName } from '../registry/index.js';
import { isCircuitOpen, recordTenantFailure, recordTenantSuccess } from './circuit-breaker.js';

export class TenantUnavailableError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string) {
    super('tenant_unavailable');
    this.name = 'TenantUnavailableError';
    this.tenantId = tenantId;
  }
}

export const SYSTEM_DB = '_system';
export const VAULT_DB = '_vault';

export function getSystemDb(): Db {
  return getMongoClientSync().db(SYSTEM_DB);
}

export function getVaultDb(): Db {
  return getMongoClientSync().db(VAULT_DB);
}

async function openTenantDb(clientId: string): Promise<Db> {
  if (isCircuitOpen(clientId)) {
    throw new TenantUnavailableError(clientId);
  }

  try {
    const dbName = await resolveTenantDbName(clientId);
    const db = getMongoClientSync().db(dbName);
    await db.command({ ping: 1 });
    recordTenantSuccess(clientId);
    return db;
  } catch (error) {
    recordTenantFailure(clientId);
    throw error;
  }
}

export async function getTenantDb(): Promise<Db> {
  const ctx = getContext();
  if (!ctx.tenantId) {
    throw new Error('Tenant context is required');
  }
  return openTenantDb(ctx.tenantId);
}

export async function getTenantDbByClientId(clientId: string): Promise<Db> {
  return openTenantDb(clientId);
}
