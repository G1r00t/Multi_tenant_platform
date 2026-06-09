export type Role = 'admin' | 'debt-counselor' | 'engineer' | 'client-viewer';

export type TenantScope = '*' | 'single';

export type MaskingLevel = 'full' | 'partial' | 'masked' | 'aggregate' | 'none';

export type Resource =
  | 'auth.login'
  | 'health'
  | 'borrowers'
  | 'borrowers.item'
  | 'conversations'
  | 'conversations.messages'
  | 'payments'
  | 'payments.item'
  | 'reports.compliance'
  | 'webhooks.payment'
  | 'audit-logs';

export type Action = 'read' | 'create' | 'update' | 'delete';

export interface PolicyDecision {
  allowed: boolean;
  requiresTenantHeader?: boolean;
  allowsFanOut?: boolean;
  maskingLevel: MaskingLevel;
}

export interface JwtPayload {
  userId: string;
  role: Role;
  tenantId?: string;
  tenantScope?: TenantScope;
  jti: string;
  iat: number;
  exp: number;
}

export interface RequestContext {
  tenantId: string | null;
  userId: string;
  role: Role;
  tenantScope: TenantScope;
  jti: string;
  requestId: string;
  maskingLevel: MaskingLevel;
}

export interface AuthenticatedUser {
  userId: string;
  role: Role;
  tenantId?: string;
  tenantScope: TenantScope;
  jti: string;
}

export const CANONICAL_TENANTS = [
  'client_sunrise_001',
  'client_metro_002',
  'client_digital_003',
] as const;

export type CanonicalTenantId = (typeof CANONICAL_TENANTS)[number];

export const TENANT_SLUGS: Record<CanonicalTenantId, string> = {
  client_sunrise_001: 'sunrise',
  client_metro_002: 'metro',
  client_digital_003: 'digital',
};
