import type { FastifyInstance } from 'fastify';
import { parsePaymentReference } from '../../webhooks/reference.js';
import { enqueueJob } from '../../workers/queue.js';
import { sendError } from '../middleware/requestId.js';
import { writeWebhookRejectionEvent } from '../../audit/security-event.js';

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/payment-gateway', async (request, reply) => {
    const body = request.body as {
      reference?: string;
      gatewayReference?: string;
      status?: string;
      amount?: number;
      paidAt?: string;
    };

    const reference = body.reference;
    if (!reference) {
      await writeWebhookRejectionEvent({ reason: 'missing_reference', requestId: request.requestId });
      return sendError(reply, 400, 'reference_required');
    }

    const tenantId = parsePaymentReference(reference);
    if (!tenantId) {
      await writeWebhookRejectionEvent({
        reason: 'unknown_reference_prefix',
        reference,
        requestId: request.requestId,
      });
      return sendError(reply, 400, 'invalid_reference');
    }

    const jobId = await enqueueJob('payment-webhook', {
      tenantId,
      reference,
      gatewayReference: body.gatewayReference,
      status: body.status ?? 'completed',
      amount: body.amount,
      paidAt: body.paidAt,
      requestId: request.requestId,
    });

    return reply.status(202).send({ ok: true, jobId });
  });
}
