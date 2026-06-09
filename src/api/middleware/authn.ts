import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken, toAuthenticatedUser } from '../../auth/jwt.js';
import { isTokenRevoked } from '../../auth/revocation.js';
import type { AuthenticatedUser } from '../../authz/types.js';
import { sendError } from './requestId.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const PUBLIC_PATHS = new Set(['/health', '/auth/login', '/webhooks/payment-gateway']);

export function registerAuthn(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0];
    if (PUBLIC_PATHS.has(path)) return;

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return sendError(reply, 401, 'unauthorized');
    }

    try {
      const token = header.slice('Bearer '.length);
      const payload = verifyToken(token);
      if (await isTokenRevoked(payload.jti)) {
        return sendError(reply, 401, 'token_revoked');
      }
      request.user = toAuthenticatedUser(payload);
    } catch {
      return sendError(reply, 401, 'unauthorized');
    }
  });
}
