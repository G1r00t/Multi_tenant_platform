import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extractResourceIds, redactEndpoint, writeAuditEntry } from './writer.js';
import { runWithContextAsync } from '../context/als.js';

const SKIP_PATHS = new Set(['/health']);

export function registerAuditMiddleware(app: FastifyInstance): void {
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (SKIP_PATHS.has(path)) return;

    const ctx = request.ctx;
    if (!ctx?.tenantId) return;

    const statusCode = reply.statusCode;
    const outcome = statusCode >= 200 && statusCode < 400 ? 'success' : 'failure';

    try {
      await runWithContextAsync(ctx, async () => {
        await writeAuditEntry({
          userId: ctx.userId,
          role: ctx.role,
          tenantId: ctx.tenantId!,
          method: request.method,
          endpoint: redactEndpoint(path),
          resourceIds: extractResourceIds(path),
          timestampUTC: new Date(),
          maskingLevel: ctx.maskingLevel,
          outcome,
          statusCode,
          requestId: ctx.requestId,
        });
      });
    } catch {
      // Audit failures must not break responses
    }
  });
}
