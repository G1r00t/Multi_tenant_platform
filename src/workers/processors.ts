import type { Job } from 'bullmq';
import { runWithContextAsync } from '../context/als.js';
import type { RequestContext, Role } from '../authz/types.js';
import { getTenantDb, getTenantDbByClientId, getSystemDb } from '../db/router.js';
import { loadRegistry } from '../registry/index.js';
import { generateLegacyBreachSummary } from '../compliance/seed-report.js';
import { writeAuditEntry } from '../audit/writer.js';
import { writePaymentTenantMismatchEvent } from '../audit/security-event.js';
import { setJobStatus } from './queue.js';
import { destroyBorrowerTweak } from '../pii/vault.js';

interface ComplianceTenantReport {
  tenantId: string;
  quietHourViolations: number;
  scopeDenials: number;
  failedAuthAttempts: number;
  overduePayments: number;
  legacyBreachSummary: Awaited<ReturnType<typeof generateLegacyBreachSummary>>;
}

async function buildTenantComplianceReport(tenantId: string): Promise<ComplianceTenantReport> {
  const db = await getTenantDbByClientId(tenantId);
  const system = getSystemDb();

  const [quietHourViolations, scopeDenials, failedAuthAttempts, overduePayments, legacyBreachSummary] =
    await Promise.all([
      db.collection('audit_logs').countDocuments({
        endpoint: { $regex: /\/messages$/ },
        statusCode: 403,
        outcome: 'failure',
      }),
      system.collection('security_incidents').countDocuments({
        type: 'scope_violation',
        tenantId,
      }),
      db.collection('audit_logs').countDocuments({
        statusCode: { $in: [401, 403] },
        outcome: 'failure',
      }),
      db.collection('payments').countDocuments({
        status: { $in: ['pending', 'overdue'] },
      }),
      generateLegacyBreachSummary(),
    ]);

  return {
    tenantId,
    quietHourViolations,
    scopeDenials,
    failedAuthAttempts,
    overduePayments,
    legacyBreachSummary,
  };
}

function workerContext(tenantId: string, requestId: string): RequestContext {
  return {
    tenantId,
    userId: 'system',
    role: 'admin' as Role,
    tenantScope: 'single',
    jti: 'worker',
    requestId,
    maskingLevel: 'none',
  };
}

export async function processComplianceReport(job: Job): Promise<void> {
  const jobId = String(job.id);
  await setJobStatus(jobId, { status: 'running' });

  try {
    const { tenantId, fanOut } = job.data as { tenantId: string | null; fanOut: boolean };

    if (fanOut) {
      const registry = await loadRegistry();
      const reports = await Promise.all(
        registry.map((entry) => buildTenantComplianceReport(entry.clientId)),
      );
      await setJobStatus(jobId, { status: 'completed', result: { tenants: reports } });
      return;
    }

    if (!tenantId) {
      throw new Error('tenantId required');
    }

    const report = await buildTenantComplianceReport(tenantId);
    await setJobStatus(jobId, { status: 'completed', result: report });
  } catch (error) {
    await setJobStatus(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    throw error;
  }
}

export async function processPaymentWebhook(job: Job): Promise<void> {
  const {
    tenantId,
    reference,
    gatewayReference,
    status,
    amount,
    paidAt,
    requestId,
  } = job.data as {
    tenantId: string;
    reference: string;
    gatewayReference?: string;
    status: string;
    amount?: number;
    paidAt?: string;
    requestId: string;
  };

  await runWithContextAsync(workerContext(tenantId, requestId), async () => {
    const db = await getTenantDb();
    const payment = (await db.collection('payments').findOne({ reference })) as {
      borrowerId?: string;
      status?: string;
    } | null;

    if (!payment) {
      throw new Error('payment_not_found');
    }

    const borrower = await db.collection('borrowers').findOne({ borrowerId: payment.borrowerId });
    if (!borrower) {
      await writePaymentTenantMismatchEvent({
        tenantId,
        reference,
        borrowerId: payment.borrowerId ?? null,
        requestId,
      });
      throw new Error('borrower_tenant_mismatch');
    }

    if (payment.status === 'completed') {
      return;
    }

    const update: Record<string, unknown> = {
      status,
      updatedAt: new Date().toISOString(),
    };
    if (gatewayReference) update.gatewayReference = gatewayReference;
    if (amount != null) update.amount = amount;
    if (paidAt) update.paidAt = paidAt;

    await db.collection('payments').updateOne({ reference }, { $set: update });

    await writeAuditEntry({
      userId: 'system',
      role: 'webhook',
      tenantId,
      method: 'POST',
      endpoint: '/webhooks/payment-gateway',
      resourceIds: [reference],
      timestampUTC: new Date(),
      maskingLevel: 'none',
      outcome: 'success',
      statusCode: 200,
      requestId,
    });
  });
}

export async function processOverdueCheck(job: Job): Promise<void> {
  const { tenantId, requestId } = job.data as { tenantId: string; requestId: string };

  await runWithContextAsync(workerContext(tenantId, requestId), async () => {
    const db = await getTenantDb();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await db.collection('payments').updateMany(
      {
        status: 'pending',
        createdAt: { $lt: cutoff },
      },
      { $set: { status: 'overdue', updatedAt: new Date().toISOString() } },
    );

    await writeAuditEntry({
      userId: 'system',
      role: 'cron',
      tenantId,
      method: 'CRON',
      endpoint: '/jobs/overdue-check',
      resourceIds: [],
      timestampUTC: new Date(),
      maskingLevel: 'none',
      outcome: 'success',
      statusCode: 200,
      requestId,
    });
  });
}

export async function processErasure(job: Job): Promise<void> {
  const { tenantId, requestId } = job.data as { tenantId: string; requestId: string };
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  await runWithContextAsync(workerContext(tenantId, requestId), async () => {
    const db = await getTenantDb();
    const closedBorrowers = await db
      .collection('borrowers')
      .find({ status: 'closed', updatedAt: { $lt: cutoff.toISOString() } })
      .project({ borrowerId: 1 })
      .toArray();

    for (const borrower of closedBorrowers) {
      const borrowerId = String(borrower.borrowerId);
      await destroyBorrowerTweak(tenantId, borrowerId);
      await db.collection('borrowers').updateOne(
        { borrowerId },
        {
          $unset: {
            phoneToken: '',
            aadhaarToken: '',
            bankAccountToken: '',
            panToken: '',
            email: '',
            firstName: '',
            lastName: '',
            fullName: '',
          },
        },
      );
    }

    await writeAuditEntry({
      userId: 'system',
      role: 'cron',
      tenantId,
      method: 'CRON',
      endpoint: '/jobs/erasure',
      resourceIds: closedBorrowers.map((b) => String(b.borrowerId)),
      timestampUTC: new Date(),
      maskingLevel: 'none',
      outcome: 'success',
      statusCode: 200,
      requestId,
    });
  });
}

export async function dispatchJob(job: Job): Promise<void> {
  switch (job.name) {
    case 'compliance-report':
      return processComplianceReport(job);
    case 'payment-webhook':
      return processPaymentWebhook(job);
    case 'overdue-check':
      return processOverdueCheck(job);
    case 'erasure':
      return processErasure(job);
    default:
      return;
  }
}
