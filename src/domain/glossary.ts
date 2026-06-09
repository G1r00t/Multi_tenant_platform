import type { CanonicalTenantId } from '../authz/types.js';

/** DPD bucket ranges from docs/domain-glossary.md */
export const DPD_BUCKETS = ['30-60', '60-90', '90-180', '180+'] as const;
export type DpdBucket = (typeof DPD_BUCKETS)[number];

/** 90+ days past due — regulatory NPA classification */
export const NPA_DPD_BUCKETS: readonly DpdBucket[] = ['90-180', '180+'];

/** Early-stage collection (30–60 DPD) */
export const SOFT_COLLECTION_BUCKETS: readonly DpdBucket[] = ['30-60', '60-90'];

/** Late-stage collection (90+ DPD) */
export const HARD_COLLECTION_BUCKETS: readonly DpdBucket[] = ['90-180', '180+'];

export const BORROWER_STATUSES = ['active', 'dormant', 'closed'] as const;
export type BorrowerStatus = (typeof BORROWER_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'overdue'] as const;
export const PAYMENT_CHANNELS = ['payment_link', 'agent_collected', 'auto_debit', 'direct'] as const;
export const CONVERSATION_CHANNELS = ['whatsapp', 'sms', 'chat', 'voice'] as const;

export const CLIENT_TYPES = ['NBFC', 'cooperative_bank'] as const;
export const PLATFORM_ROLES = ['admin', 'debt-counselor', 'engineer', 'client-viewer'] as const;

export const CANONICAL_CLIENT_IDS: readonly CanonicalTenantId[] = [
  'client_sunrise_001',
  'client_metro_002',
  'client_digital_003',
];

export const PAYMENT_REFERENCE_PATTERN = /^PAY-client_[smd]-[a-f0-9]+$/;
export const GATEWAY_REFERENCE_PATTERN = /^GW-/;

export const QUIET_HOURS = {
  startHour: 20,
  endHour: 8,
  timezone: 'Asia/Kolkata',
} as const;

export const COUNSELOR_ROLE = 'debt-counselor' as const;

export function isDpdBucket(value: string): value is DpdBucket {
  return (DPD_BUCKETS as readonly string[]).includes(value);
}

export function isNpaBucket(bucket: string): boolean {
  return (NPA_DPD_BUCKETS as readonly string[]).includes(bucket);
}

export function isSoftCollectionBucket(bucket: string): boolean {
  return (SOFT_COLLECTION_BUCKETS as readonly string[]).includes(bucket);
}

export function isHardCollectionBucket(bucket: string): boolean {
  return (HARD_COLLECTION_BUCKETS as readonly string[]).includes(bucket);
}
