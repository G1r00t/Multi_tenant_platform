import { getTenantDb } from '../db/router.js';
import type { MaskingLevel } from '../authz/types.js';

export interface AuditEntry {
  userId: string;
  role: string;
  tenantId: string;
  method: string;
  endpoint: string;
  resourceIds: string[];
  timestampUTC: Date;
  maskingLevel: MaskingLevel;
  outcome: 'success' | 'failure';
  statusCode: number;
  requestId: string;
}

export async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  const db = await getTenantDb();
  await db.collection('audit_logs').insertOne(entry);
}

export function extractResourceIds(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  if (segments.length >= 2) {
    return [segments[segments.length - 1]!];
  }
  return [];
}

export function redactEndpoint(path: string): string {
  return path.replace(/\/\d{10,}/g, '/[redacted]');
}
