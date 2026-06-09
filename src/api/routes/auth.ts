import type { FastifyInstance } from 'fastify';
import { login } from '../../auth/login.js';
import { sendError } from '../middleware/requestId.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    if (!body?.email || !body?.password) {
      return sendError(reply, 400, 'invalid_request');
    }

    const result = await login(body.email, body.password);
    if (!result) {
      return sendError(reply, 401, 'invalid_credentials');
    }

    return reply.send(result);
  });
}
