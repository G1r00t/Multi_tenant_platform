import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { revokeToken } from '../../auth/revocation.js';
import { getSystemDb } from '../../db/router.js';
import type { RequestContext } from '../../authz/types.js';
import { sendError } from './requestId.js';

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: RequestContext;
  }
}

async function recordBreachIncident(
  userId: string,
  role: string,
  jwtTenantId: string,
  headerTenantId: string,
  requestId: string,
): Promise<void> {
  await getSystemDb().collection('security_incidents').insertOne({
    type: 'cross_tenant_header_mismatch',
    userId,
    role,
    jwtTenantId,
    headerTenantId,
    requestId,
    flaggedForReview: true,
    createdAt: new Date(),
  });
}

export function registerTenantContext(app: FastifyInstance): void {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/auth/login' || path === '/webhooks/payment-gateway') {
      return;
    }

    const user = request.user;
    const decision = request.decision;
    if (!user || !decision) return;

    const headerTenant = request.headers['x-tenant-id'] as string | undefined;

    if (user.tenantScope === 'single') {
      const jwtTenant = user.tenantId;
      if (!jwtTenant) {
        return sendError(reply, 403, 'forbidden');
      }

      if (headerTenant && headerTenant !== jwtTenant) {
        await recordBreachIncident(user.userId, user.role, jwtTenant, headerTenant, request.requestId);
        await revokeToken(user.jti, user.userId);
        return sendError(reply, 403, 'forbidden');
      }

      request.ctx = {
        tenantId: jwtTenant,
        userId: user.userId,
        role: user.role,
        tenantScope: 'single',
        jti: user.jti,
        requestId: request.requestId,
        maskingLevel: decision.maskingLevel,
      };
      return;
    }

    if (decision.requiresTenantHeader && !headerTenant && !decision.allowsFanOut) {
      return sendError(reply, 400, 'x_tenant_id_required');
    }

    request.ctx = {
      tenantId: headerTenant ?? null,
      userId: user.userId,
      role: user.role,
      tenantScope: '*',
      jti: user.jti,
      requestId: request.requestId,
      maskingLevel: decision.maskingLevel,
    };
  });
}

export async function withRequestContext<T>(
  request: FastifyRequest,
  handler: () => Promise<T>,
): Promise<T> {
  if (!request.ctx) {
    throw new Error('Request context missing');
  }
  const { runWithContextAsync } = await import('../../context/als.js');
  return runWithContextAsync(request.ctx, handler);
}
