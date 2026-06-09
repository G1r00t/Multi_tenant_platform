import type { Action, PolicyDecision, Resource, Role } from './types.js';

const DEFAULT_DENY: PolicyDecision = {
  allowed: false,
  maskingLevel: 'none',
};

function readDecision(maskingLevel: PolicyDecision['maskingLevel'], extra?: Partial<PolicyDecision>): PolicyDecision {
  return { allowed: true, maskingLevel, ...extra };
}

export function evaluate(role: Role | null, resource: Resource, action: Action): PolicyDecision {
  if (resource === 'auth.login' || resource === 'health') {
    return readDecision('none');
  }

  if (!role) return DEFAULT_DENY;

  if (action === 'create' || action === 'update' || action === 'delete') {
    if (role === 'client-viewer' || role === 'engineer') {
      return DEFAULT_DENY;
    }
    if (role === 'admin') {
      return readDecision('full', { requiresTenantHeader: true });
    }
    if (role === 'debt-counselor') {
      return readDecision('partial');
    }
    return DEFAULT_DENY;
  }

  if (resource === 'borrowers' && action === 'read') {
    switch (role) {
      case 'admin':
        return readDecision('full', { requiresTenantHeader: true });
      case 'debt-counselor':
        return readDecision('partial');
      case 'engineer':
        return readDecision('masked', { allowsFanOut: true });
      case 'client-viewer':
        return readDecision('aggregate');
      default:
        return DEFAULT_DENY;
    }
  }

  if (resource === 'borrowers.item' && action === 'read') {
    switch (role) {
      case 'admin':
        return readDecision('full', { requiresTenantHeader: true });
      case 'debt-counselor':
        return readDecision('partial');
      case 'engineer':
        return readDecision('masked', { requiresTenantHeader: true });
      case 'client-viewer':
        return DEFAULT_DENY;
      default:
        return DEFAULT_DENY;
    }
  }

  if (resource === 'conversations' || resource === 'payments.item') {
    switch (role) {
      case 'admin':
        return readDecision('full', { requiresTenantHeader: true });
      case 'debt-counselor':
        return readDecision('partial');
      case 'engineer':
        return readDecision('masked', { requiresTenantHeader: true });
      case 'client-viewer':
        return DEFAULT_DENY;
      default:
        return DEFAULT_DENY;
    }
  }

  if (resource === 'conversations.messages' || resource === 'payments') {
    if (role === 'client-viewer' || role === 'engineer') {
      return DEFAULT_DENY;
    }
    if (role === 'admin') {
      return readDecision('full', { requiresTenantHeader: true });
    }
    if (role === 'debt-counselor') {
      return readDecision('partial');
    }
    return DEFAULT_DENY;
  }

  if (resource === 'reports.compliance' || resource === 'audit-logs') {
    if (role === 'admin' || role === 'engineer') {
      return readDecision(role === 'admin' ? 'full' : 'masked', { allowsFanOut: true });
    }
    return DEFAULT_DENY;
  }

  if (resource === 'webhooks.payment') {
    return readDecision('none');
  }

  return DEFAULT_DENY;
}

export function routeToResource(method: string, path: string): Resource | null {
  if (path === '/health') return 'health';
  if (path === '/auth/login') return 'auth.login';
  if (path === '/borrowers' && (method === 'GET' || method === 'POST')) return 'borrowers';
  if (path.startsWith('/borrowers/')) return 'borrowers.item';
  if (path.startsWith('/conversations/') && path.endsWith('/messages')) return 'conversations.messages';
  if (path.startsWith('/conversations/')) return 'conversations';
  if (path === '/payments' && method === 'POST') return 'payments';
  if (path.startsWith('/payments/')) return 'payments.item';
  if (path.startsWith('/reports/compliance')) return 'reports.compliance';
  if (path === '/webhooks/payment-gateway') return 'webhooks.payment';
  if (path === '/audit-logs') return 'audit-logs';
  return null;
}

export function methodToAction(method: string): Action {
  switch (method.toUpperCase()) {
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'read';
  }
}
