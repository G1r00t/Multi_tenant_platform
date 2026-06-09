import type { FastifyInstance } from 'fastify';
import { withRequestContext } from '../middleware/tenant.js';
import { sendError } from '../middleware/requestId.js';
import { getTenantDb, getTenantDbByClientId } from '../../db/router.js';
import { loadRegistry } from '../../registry/index.js';
import { enqueueJob, getJobStatus } from '../../workers/queue.js';

export async function registerAuditLogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit-logs', async (request, reply) => {
    return withRequestContext(request, async () => {
      const user = request.user!;
      const decision = request.decision!;
      const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 50), 200);

      if (user.tenantScope === '*' && decision.allowsFanOut && !request.ctx?.tenantId) {
        const registry = await loadRegistry();
        const tenants = await Promise.all(
          registry.map(async (entry) => {
            const db = await getTenantDbByClientId(entry.clientId);
            const logs = await db
              .collection('audit_logs')
              .find({})
              .sort({ timestampUTC: -1 })
              .limit(limit)
              .toArray();
            return { tenantId: entry.clientId, logs };
          }),
        );
        return reply.send({ tenants });
      }

      if (!request.ctx?.tenantId) {
        return sendError(reply, 400, 'x_tenant_id_required');
      }

      const db = await getTenantDb();
      const logs = await db
        .collection('audit_logs')
        .find({})
        .sort({ timestampUTC: -1 })
        .limit(limit)
        .toArray();
      return reply.send({ tenantId: request.ctx.tenantId, logs });
    });
  });
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reports/compliance', async (request, reply) => {
    return withRequestContext(request, async () => {
      const user = request.user!;
      const tenantId = request.ctx?.tenantId ?? null;
      const fanOut = user.tenantScope === '*' && !tenantId;

      if (!tenantId && !fanOut) {
        return sendError(reply, 400, 'x_tenant_id_required');
      }

      const jobId = await enqueueJob('compliance-report', {
        tenantId,
        fanOut,
        requestedBy: user.userId,
        role: user.role,
      });

      return reply.status(202).send({ jobId, status: 'queued' });
    });
  });

  app.get('/reports/compliance/:jobId', async (request, reply) => {
    return withRequestContext(request, async () => {
      const jobId = (request.params as { jobId: string }).jobId;
      const status = await getJobStatus(jobId);
      if (!status) {
        return sendError(reply, 404, 'not_found');
      }
      return reply.send(status);
    });
  });
}
