import type { MaskingLevel, Role } from './types.js';
import { getTenantDb } from '../db/router.js';
import { getContext } from '../context/als.js';
import { writeScopeViolationEvent } from '../audit/security-event.js';

export interface BorrowerDoc {
  borrowerId: string;
  assignedTo?: string | null;
  [key: string]: unknown;
}

export type ScopeResult =
  | { ok: true; borrower: BorrowerDoc }
  | { ok: false; statusCode: 403 | 404; error: string };

export async function loadBorrowerWithScope(borrowerId: string): Promise<ScopeResult> {
  const ctx = getContext();
  const db = await getTenantDb();
  const borrower = (await db.collection('borrowers').findOne({ borrowerId })) as BorrowerDoc | null;

  if (!borrower) {
    return { ok: false, statusCode: 404, error: 'not_found' };
  }

  if (ctx.role === 'client-viewer') {
    return { ok: false, statusCode: 403, error: 'forbidden' };
  }

  if (ctx.role === 'debt-counselor' && borrower.assignedTo !== ctx.userId) {
    await writeScopeViolationEvent({
      userId: ctx.userId,
      role: ctx.role,
      tenantId: ctx.tenantId!,
      borrowerId,
      assignedTo: borrower.assignedTo ?? null,
      requestId: ctx.requestId,
    });
    return { ok: false, statusCode: 403, error: 'forbidden' };
  }

  return { ok: true, borrower };
}

export function counselorListFilter(role: Role, userId: string): Record<string, unknown> | null {
  if (role === 'debt-counselor') {
    return { assignedTo: userId };
  }
  return null;
}

export function effectiveMaskingLevel(role: Role, decisionLevel: MaskingLevel): MaskingLevel {
  if (role === 'admin') return 'full';
  if (role === 'debt-counselor') return 'partial';
  if (role === 'engineer') return 'masked';
  if (role === 'client-viewer') return 'aggregate';
  return decisionLevel;
}
