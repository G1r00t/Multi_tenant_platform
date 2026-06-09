import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    request.requestId = (request.headers['x-request-id'] as string) || uuidv4();
  });

  app.addHook('onResponse', async (request, reply) => {
    const logPayload = {
      requestId: request.requestId,
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
    };
    console.log(JSON.stringify(logPayload));
  });
}

export function sendError(reply: FastifyReply, statusCode: number, error: string): void {
  reply.status(statusCode).send({ error });
}
