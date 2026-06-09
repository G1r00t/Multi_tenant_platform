import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getTenantDb, getTenantDbByClientId } from '../../db/router.js';
import { loadRegistry } from '../../registry/index.js';
import { counselorListFilter, loadBorrowerWithScope } from '../../authz/scope.js';
import type { BorrowerDoc } from '../../authz/scope.js';
import { getTokenService } from '../../pii/token-service.js';
import { shapeBorrower, shapeBorrowers } from '../shape.js';
import { withRequestContext } from '../middleware/tenant.js';
import { sendError } from '../middleware/requestId.js';
import type { CanonicalTenantId } from '../../authz/types.js';

export async function registerBorrowerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/borrowers', async (request, reply) => {
    return withRequestContext(request, async () => {
      if (!request.ctx?.tenantId) {
        return sendError(reply, 400, 'x_tenant_id_required');
      }

      const body = request.body as Record<string, unknown>;
      const borrowerId = String(body.borrowerId ?? randomUUID());
      const tokenService = getTokenService();
      const clientId = request.ctx.tenantId as CanonicalTenantId;

      const rawRecord: Record<string, unknown> = {
        ...body,
        borrowerId,
        createdAt: body.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (request.user!.role === 'debt-counselor') {
        rawRecord.assignedTo = request.user!.userId;
      }

      const { record } = await tokenService.tokenizeBorrowerRecord(clientId, rawRecord);
      const db = await getTenantDb();
      await db.collection('borrowers').insertOne(record);

      const shaped = await shapeBorrower(
        record as BorrowerDoc,
        request.user!.role,
        clientId,
        tokenService,
      );
      return reply.status(201).send(shaped);
    });
  });

  app.get('/borrowers', async (request, reply) => {
    return withRequestContext(request, async () => {
      const user = request.user!;
      const decision = request.decision!;
      const tokenService = getTokenService();

      if (user.role === 'client-viewer') {
        const db = await getTenantDb();
        const [totalBorrowers, byStatus, byDpdBucket, outstandingAgg] = await Promise.all([
          db.collection('borrowers').countDocuments(),
          db
            .collection('borrowers')
            .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
            .toArray(),
          db
            .collection('borrowers')
            .aggregate([{ $group: { _id: '$dpdBucket', count: { $sum: 1 } } }])
            .toArray(),
          db
            .collection('borrowers')
            .aggregate([{ $group: { _id: null, total: { $sum: '$outstandingAmount' } } }])
            .toArray(),
        ]);

        return reply.send({
          tenantId: request.ctx!.tenantId,
          totalBorrowers,
          byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
          byDpdBucket: Object.fromEntries(byDpdBucket.map((r) => [r._id, r.count])),
          totalOutstanding: outstandingAgg[0]?.total ?? 0,
        });
      }

      if (user.tenantScope === '*' && decision.allowsFanOut && !request.ctx?.tenantId) {
        const registry = await loadRegistry();
        const results = await Promise.all(
          registry.map(async (entry) => {
            const db = await getTenantDbByClientId(entry.clientId);
            const filter = counselorListFilter(user.role, user.userId) ?? {};
            const docs = (await db
              .collection('borrowers')
              .find(filter)
              .limit(100)
              .toArray()) as unknown as BorrowerDoc[];
            const shaped = await shapeBorrowers(docs, user.role, entry.clientId, tokenService);
            return { tenantId: entry.clientId, borrowers: shaped };
          }),
        );
        return reply.send({ tenants: results });
      }

      if (!request.ctx?.tenantId) {
        return sendError(reply, 400, 'x_tenant_id_required');
      }

      const clientId = request.ctx.tenantId as CanonicalTenantId;
      const db = await getTenantDb();
      const filter = counselorListFilter(user.role, user.userId) ?? {};
      const docs = (await db.collection('borrowers').find(filter).toArray()) as unknown as BorrowerDoc[];
      const shaped = await shapeBorrowers(docs, user.role, clientId, tokenService);
      return reply.send({ tenantId: clientId, borrowers: shaped });
    });
  });

  app.get('/borrowers/:id', async (request, reply) => {
    return withRequestContext(request, async () => {
      if (!request.ctx?.tenantId) {
        return sendError(reply, 400, 'x_tenant_id_required');
      }

      const borrowerId = (request.params as { id: string }).id;
      const scope = await loadBorrowerWithScope(borrowerId);
      if (!scope.ok) {
        return sendError(reply, scope.statusCode, scope.error);
      }

      const tokenService = getTokenService();
      const shaped = await shapeBorrower(
        scope.borrower,
        request.user!.role,
        request.ctx.tenantId,
        tokenService,
      );
      return reply.send(shaped);
    });
  });

  app.put('/borrowers/:id', async (request, reply) => {
    return withRequestContext(request, async () => {
      if (!request.ctx?.tenantId) {
        return sendError(reply, 400, 'x_tenant_id_required');
      }

      const borrowerId = (request.params as { id: string }).id;
      const scope = await loadBorrowerWithScope(borrowerId);
      if (!scope.ok) {
        return sendError(reply, scope.statusCode, scope.error);
      }

      const body = request.body as Record<string, unknown>;
      const clientId = request.ctx.tenantId as CanonicalTenantId;
      const tokenService = getTokenService();

      const updates: Record<string, unknown> = { ...body, updatedAt: new Date().toISOString() };
      delete updates.borrowerId;
      delete updates._id;

      for (const field of ['phone', 'aadhaar', 'bankAccount'] as const) {
        if (updates[field] != null) {
          const tokenFieldName =
            field === 'phone' ? 'phoneToken' : field === 'aadhaar' ? 'aadhaarToken' : 'bankAccountToken';
          updates[tokenFieldName] = await tokenService.tokenizeField(
            clientId,
            borrowerId,
            field,
            String(updates[field]),
          );
          delete updates[field];
        }
      }

      if (updates.pan != null) {
        updates.panToken = await tokenService.tokenizePan(clientId, borrowerId, String(updates.pan));
        delete updates.pan;
      }

      const db = await getTenantDb();
      await db.collection('borrowers').updateOne({ borrowerId }, { $set: updates });
      const updated = (await db.collection('borrowers').findOne({ borrowerId })) as unknown as BorrowerDoc;
      const shaped = await shapeBorrower(updated, request.user!.role, clientId, tokenService);
      return reply.send(shaped);
    });
  });
}
