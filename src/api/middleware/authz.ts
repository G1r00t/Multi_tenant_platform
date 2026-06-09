import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { evaluate, methodToAction, routeToResource } from '../../authz/policy.js';
import { sendError } from './requestId.js';

const PUBLIC_PATHS = new Set(['/health', '/auth/login', '/webhooks/payment-gateway']);

export function registerAuthz(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0];
    if (PUBLIC_PATHS.has(path)) return;
    const resource = routeToResource(request.method, path);
    if (!resource) {
      return sendError(reply, 404, 'not_found');
    }

    const action = methodToAction(request.method);
    const role = request.user?.role ?? null;
    const decision = evaluate(role, resource, action);

    if (!decision.allowed) {
      const status = role ? 403 : 401;
      return sendError(reply, status, status === 401 ? 'unauthorized' : 'forbidden');
    }

    request.decision = decision;
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    decision?: ReturnType<typeof evaluate>;
  }
}
