import Fastify from 'fastify';
import { registerRequestId } from './middleware/requestId.js';
import { registerAuthn } from './middleware/authn.js';
import { registerAuthz } from './middleware/authz.js';
import { registerTenantContext } from './middleware/tenant.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBorrowerRoutes } from './routes/borrowers.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerReportRoutes, registerAuditLogRoutes } from './routes/reports.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerAuditMiddleware } from '../audit/middleware.js';
import { TenantUnavailableError } from '../db/router.js';

export async function buildServer() {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error: Error, request, reply) => {
    if (error instanceof TenantUnavailableError) {
      return reply.status(503).send({ error: 'tenant_unavailable' });
    }

    console.error(
      JSON.stringify({
        event: 'unhandled_error',
        requestId: request.requestId,
        message: error.message,
      }),
    );
    reply.status(500).send({ error: 'internal_error' });
  });

  registerRequestId(app);
  registerAuthn(app);
  registerAuthz(app);
  registerTenantContext(app);
  registerAuditMiddleware(app);

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerBorrowerRoutes(app);
  await registerConversationRoutes(app);
  await registerPaymentRoutes(app);
  await registerReportRoutes(app);
  await registerAuditLogRoutes(app);
  await registerWebhookRoutes(app);

  return app;
}
