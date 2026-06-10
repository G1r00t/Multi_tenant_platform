import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getTenantDb } from '../../db/router.js';
import { loadBorrowerWithScope } from '../../authz/scope.js';
import { getTokenService } from '../../pii/token-service.js';
import {
  NUMERIC_PII_FIELDS,
  PAN_TOKEN_FIELD,
  TEXT_PII_FIELDS,
  TEXT_TOKEN_FIELD_NAMES,
  TOKEN_FIELD_NAMES,
  type BorrowerPlaintextPii,
  type BorrowerTokens,
} from '../../pii/fields.js';
import { withRequestContext } from '../middleware/tenant.js';
import { sendError } from '../middleware/requestId.js';
import type { CanonicalTenantId } from '../../authz/types.js';
import {
  assertAgentMessageAllowed,
  QuietHoursViolationError,
} from '../../compliance/quiet-hours.js';

interface ConversationMessage {
  sender: string;
  text: string;
  timestamp: string;
}

interface ConversationDoc {
  conversationId: string;
  borrowerId: string;
  channel?: string;
  status?: string;
  messages: ConversationMessage[];
}

function borrowerTokensFromDoc(doc: Record<string, unknown>): BorrowerTokens {
  return {
    phoneToken: doc.phoneToken as string | undefined,
    aadhaarToken: doc.aadhaarToken as string | undefined,
    bankAccountToken: doc.bankAccountToken as string | undefined,
    panToken: doc.panToken as string | undefined,
    emailToken: doc.emailToken as string | undefined,
    fullNameToken: doc.fullNameToken as string | undefined,
    firstNameToken: doc.firstNameToken as string | undefined,
    lastNameToken: doc.lastNameToken as string | undefined,
  };
}

async function borrowerPlaintextPii(
  clientId: CanonicalTenantId,
  borrowerId: string,
  doc: Record<string, unknown>,
): Promise<BorrowerPlaintextPii> {
  const tokenService = getTokenService();
  const plaintext: BorrowerPlaintextPii = {};

  for (const field of NUMERIC_PII_FIELDS) {
    const token = doc[TOKEN_FIELD_NAMES[field]] as string | undefined;
    if (!token) continue;
    plaintext[field] = await tokenService.detokenizeField(clientId, borrowerId, field, token);
  }

  const panToken = doc[PAN_TOKEN_FIELD] as string | undefined;
  if (panToken) {
    plaintext.pan = await tokenService.detokenizePan(clientId, borrowerId, panToken);
  }

  for (const field of TEXT_PII_FIELDS) {
    const token = doc[TEXT_TOKEN_FIELD_NAMES[field]] as string | undefined;
    if (!token) continue;
    plaintext[field] = await tokenService.detokenizeTextField(clientId, borrowerId, field, token);
  }

  return plaintext;
}

async function shapeConversationDoc(
  convo: ConversationDoc,
  borrowerDoc: Record<string, unknown>,
  role: import('../../authz/types.js').Role,
  clientId: CanonicalTenantId,
): Promise<ConversationDoc> {
  const tokenService = getTokenService();
  const tokens = borrowerTokensFromDoc(borrowerDoc);
  const messages = await Promise.all(
    convo.messages.map(async (message) => ({
      ...message,
      text: await tokenService.shapeConversationText(
        clientId,
        convo.borrowerId,
        role,
        message.text,
        tokens,
      ),
    })),
  );
  return { ...convo, messages };
}

export async function registerConversationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/conversations/:borrowerId', async (request, reply) => {
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
      const conversations = (await db
        .collection('conversations')
        .find({ borrowerId })
        .toArray()) as unknown as ConversationDoc[];

      const clientId = request.ctx.tenantId as CanonicalTenantId;
      const shaped = await Promise.all(
        conversations.map((convo) =>
          shapeConversationDoc(convo, scope.borrower, request.user!.role, clientId),
        ),
      );

      return reply.send({ borrowerId, conversations: shaped });
    });
  });

  app.post('/conversations/:borrowerId/messages', async (request, reply) => {
    return withRequestContext(request, async () => {
      if (!request.ctx?.tenantId) {
        return sendError(reply, 400, 'x_tenant_id_required');
      }

      const borrowerId = (request.params as { borrowerId: string }).borrowerId;
      const scope = await loadBorrowerWithScope(borrowerId);
      if (!scope.ok) {
        return sendError(reply, scope.statusCode, scope.error);
      }

      const body = request.body as { sender?: string; text?: string };
      const sender = body.sender;
      const text = body.text;

      if (sender !== 'agent' && sender !== 'borrower') {
        return sendError(reply, 400, 'invalid_sender');
      }
      if (!text || text.trim() === '') {
        return sendError(reply, 400, 'text_required');
      }

      try {
        assertAgentMessageAllowed(sender);
      } catch (error) {
        if (error instanceof QuietHoursViolationError) {
          return sendError(reply, 403, error.code);
        }
        throw error;
      }

      const clientId = request.ctx.tenantId as CanonicalTenantId;
      const tokenService = getTokenService();
      const tokens = borrowerTokensFromDoc(scope.borrower);
      const plaintextPii = await borrowerPlaintextPii(clientId, borrowerId, scope.borrower);
      const tokenizedText = tokenService.scrubConversationText(text, plaintextPii, tokens);

      const message: ConversationMessage = {
        sender,
        text: tokenizedText,
        timestamp: new Date().toISOString(),
      };

      const db = await getTenantDb();
      const existing = (await db
        .collection('conversations')
        .findOne({ borrowerId }, { sort: { 'messages.timestamp': -1 } })) as ConversationDoc | null;

      if (existing) {
        await db.collection('conversations').updateOne(
          { conversationId: existing.conversationId },
          { $push: { messages: message } } as Record<string, unknown>,
        );
        const updated = (await db.collection('conversations').findOne({
          conversationId: existing.conversationId,
        })) as unknown as ConversationDoc;
        const shaped = await shapeConversationDoc(updated, scope.borrower, request.user!.role, clientId);
        return reply.status(201).send(shaped);
      }

      const conversation: ConversationDoc = {
        conversationId: randomUUID(),
        borrowerId,
        channel: 'whatsapp',
        status: 'ongoing',
        messages: [message],
      };
      await db.collection('conversations').insertOne(conversation);
      const shaped = await shapeConversationDoc(conversation, scope.borrower, request.user!.role, clientId);
      return reply.status(201).send(shaped);
    });
  });
}

export { borrowerTokensFromDoc, shapeConversationDoc };
