import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getTenantDb } from '../../db/router.js';
import { loadBorrowerWithScope } from '../../authz/scope.js';
import { withRequestContext } from '../middleware/tenant.js';
import { sendError } from '../middleware/requestId.js';

export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/payments', async (request, reply) => {
    return withRequestContext(request, async () => {
      if (!request.ctx?.tenantId) {
        return sendError(reply, 400, 'x_tenant_id_required');
      }

      const body = request.body as Record<string, unknown>;
      const borrowerId = String(body.borrowerId ?? '');
      if (!borrowerId) {
        return sendError(reply, 400, 'borrower_id_required');
      }

      const scope = await loadBorrowerWithScope(borrowerId);
      if (!scope.ok) {
        return sendError(reply, scope.statusCode, scope.error);
      }

      const paymentId = String(body.paymentId ?? randomUUID());
      const record = {
        paymentId,
        borrowerId,
        amount: Number(body.amount ?? 0),
        currency: String(body.currency ?? 'INR'),
        method: String(body.method ?? 'upi'),
        status: String(body.status ?? 'pending'),
        reference: String(body.reference ?? `PAY-manual-${paymentId.slice(0, 8)}`),
        gatewayReference: String(body.gatewayReference ?? `GW-${paymentId.slice(0, 8)}`),
        channel: String(body.channel ?? 'agent_collected'),
        paidAt: body.paidAt ?? null,
        createdAt: new Date().toISOString(),
      };

      const db = await getTenantDb();
      await db.collection('payments').insertOne(record);
      return reply.status(201).send(record);
    });
  });

  app.get('/payments/:borrowerId', async (request, reply) => {
    return withRequestContext(request, async () => {
      if (!request.ctx?.tenantId) {
        return sendError(reply, 400, 'x_tenant_id_required');
      }

      const borrowerId = (request.params as { borrowerId: string }).borrowerId;
      const scope = await loadBorrowerWithScope(borrowerId);
      if (!scope.ok) {
        return sendError(reply, scope.statusCode, scope.error);
      }

      const db = await getTenantDb();
      const payments = await db.collection('payments').find({ borrowerId }).toArray();
      return reply.send({ borrowerId, payments });
    });
  });
}
