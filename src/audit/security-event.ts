import { getSystemDb } from '../db/router.js';

export interface SecurityEventInput {
  userId: string;
  role: string;
  tenantId: string;
  borrowerId: string;
  assignedTo: string | null;
  requestId: string;
}

export async function writeScopeViolationEvent(input: SecurityEventInput): Promise<void> {
  await getSystemDb().collection('security_incidents').insertOne({
    type: 'scope_violation',
    userId: input.userId,
    role: input.role,
    tenantId: input.tenantId,
    borrowerId: input.borrowerId,
    assignedTo: input.assignedTo,
    requestId: input.requestId,
    flaggedForReview: true,
    createdAt: new Date(),
  });
}

export async function writeWebhookRejectionEvent(input: {
  reason: string;
  reference?: string;
  requestId: string;
}): Promise<void> {
  await getSystemDb().collection('security_incidents').insertOne({
    type: 'webhook_rejection',
    reason: input.reason,
    reference: input.reference,
    requestId: input.requestId,
    flaggedForReview: true,
    createdAt: new Date(),
  });
}

export async function writePaymentTenantMismatchEvent(input: {
  tenantId: string;
  reference: string;
  borrowerId: string | null;
  requestId: string;
}): Promise<void> {
  await getSystemDb().collection('security_incidents').insertOne({
    type: 'payment_tenant_mismatch',
    tenantId: input.tenantId,
    reference: input.reference,
    borrowerId: input.borrowerId,
    requestId: input.requestId,
    flaggedForReview: true,
    createdAt: new Date(),
  });
}
