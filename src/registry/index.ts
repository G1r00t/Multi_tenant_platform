import type { Collection } from 'mongodb';
import { getSystemDb } from '../db/router.js';
import type { CanonicalTenantId } from '../authz/types.js';

export interface TenantRegistryEntry {
  clientId: CanonicalTenantId | string;
  dbName: string;
  slug: string;
  version: number;
  status: 'active' | 'migrating';
  updatedAt: Date;
}

const CACHE_TTL_MS = 30_000;
let cache: { entries: TenantRegistryEntry[]; expiresAt: number } | null = null;

export async function loadRegistry(): Promise<TenantRegistryEntry[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.entries;
  }

  const col = getSystemDb().collection<TenantRegistryEntry>('tenant_registry');
  const entries = await col.find({ status: 'active' }).toArray();
  cache = { entries, expiresAt: now + CACHE_TTL_MS };
  return entries;
}

export function invalidateRegistryCache(): void {
  cache = null;
}

export async function resolveTenantDbName(clientId: string): Promise<string> {
  const entries = await loadRegistry();
  const entry = entries.find((e) => e.clientId === clientId);
  if (!entry) {
    throw new Error('Unknown tenant');
  }
  return entry.dbName;
}

export async function getRegistryCollection(): Promise<Collection<TenantRegistryEntry>> {
  return getSystemDb().collection<TenantRegistryEntry>('tenant_registry');
}
