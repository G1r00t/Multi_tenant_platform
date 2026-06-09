import type { Role } from '../authz/types.js';
import type { TokenService } from '../pii/token-service.js';
import {
  NUMERIC_PII_FIELDS,
  PLAIN_FIELD_NAMES,
  TOKEN_FIELD_NAMES,
  type NumericPiiField,
} from '../pii/fields.js';

export interface BorrowerDoc {
  borrowerId: string;
  assignedTo?: string | null;
  phoneToken?: string;
  aadhaarToken?: string;
  bankAccountToken?: string;
  panToken?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  [key: string]: unknown;
}

export type ShapedBorrower = Record<string, unknown>;

function maskToken(token: string): string {
  if (token.length <= 4) return 'X'.repeat(token.length);
  return 'X'.repeat(token.length - 4) + token.slice(-4);
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '*****';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}*****@${domain}`;
}

async function resolveNumericField(
  role: Role,
  tokenService: TokenService,
  clientId: string,
  borrowerId: string,
  field: NumericPiiField,
  token: string | undefined,
): Promise<{ key: string; value: string } | null> {
  if (!token) return null;
  const plainKey = PLAIN_FIELD_NAMES[field];

  switch (role) {
    case 'admin':
      return {
        key: plainKey,
        value: await tokenService.detokenizeField(clientId, borrowerId, field, token),
      };
    case 'debt-counselor':
      return {
        key: plainKey,
        value: await tokenService.detokenizeField(clientId, borrowerId, field, token),
      };
    case 'engineer':
      return { key: plainKey, value: maskToken(token) };
    default:
      return null;
  }
}

async function resolveSensitiveNumericField(
  role: Role,
  tokenService: TokenService,
  clientId: string,
  borrowerId: string,
  field: NumericPiiField,
  token: string | undefined,
): Promise<{ key: string; value: string } | null> {
  if (!token) return null;
  const plainKey = PLAIN_FIELD_NAMES[field];

  switch (role) {
    case 'admin':
      return {
        key: plainKey,
        value: await tokenService.detokenizeField(clientId, borrowerId, field, token),
      };
    case 'debt-counselor':
      return { key: plainKey, value: maskToken(token) };
    case 'engineer':
      return { key: plainKey, value: maskToken(token) };
    default:
      return null;
  }
}

async function resolvePanField(
  role: Role,
  tokenService: TokenService,
  clientId: string,
  borrowerId: string,
  token: string | undefined,
): Promise<{ key: string; value: string } | null> {
  if (!token) return null;

  switch (role) {
    case 'admin':
      return { key: 'pan', value: await tokenService.detokenizePan(clientId, borrowerId, token) };
    case 'debt-counselor':
    case 'engineer':
      return { key: 'pan', value: maskToken(token) };
    default:
      return null;
  }
}

export async function shapeBorrower(
  doc: BorrowerDoc,
  role: Role,
  clientId: string,
  tokenService: TokenService,
): Promise<ShapedBorrower> {
  const { borrowerId } = doc;
  const result: ShapedBorrower = {};

  for (const [key, value] of Object.entries(doc)) {
    if (key.endsWith('Token')) continue;
    if (['phone', 'aadhaar', 'bankAccount', 'email', 'pan'].includes(key)) continue;
    result[key] = value;
  }

  const phone = await resolveNumericField(
    role,
    tokenService,
    clientId,
    borrowerId,
    'phone',
    doc.phoneToken,
  );
  if (phone) result[phone.key] = phone.value;

  const aadhaar = await resolveSensitiveNumericField(
    role,
    tokenService,
    clientId,
    borrowerId,
    'aadhaar',
    doc.aadhaarToken,
  );
  if (aadhaar) result[aadhaar.key] = aadhaar.value;

  const bankAccount = await resolveSensitiveNumericField(
    role,
    tokenService,
    clientId,
    borrowerId,
    'bankAccount',
    doc.bankAccountToken,
  );
  if (bankAccount) result[bankAccount.key] = bankAccount.value;

  const pan = await resolvePanField(role, tokenService, clientId, borrowerId, doc.panToken);
  if (pan) result[pan.key] = pan.value;

  if (role === 'admin') {
    if (doc.email) result.email = doc.email;
  } else if (role === 'debt-counselor' && doc.email) {
    result.email = maskEmail(doc.email);
  } else if (role === 'engineer' && doc.email) {
    result.email = maskToken(doc.email);
  }

  for (const field of NUMERIC_PII_FIELDS) {
    delete result[TOKEN_FIELD_NAMES[field]];
  }

  return result;
}

export async function shapeBorrowers(
  docs: BorrowerDoc[],
  role: Role,
  clientId: string,
  tokenService: TokenService,
): Promise<ShapedBorrower[]> {
  return Promise.all(docs.map((doc) => shapeBorrower(doc, role, clientId, tokenService)));
}

export function appliedMaskingLevel(role: Role): 'full' | 'partial' | 'masked' | 'aggregate' {
  switch (role) {
    case 'admin':
      return 'full';
    case 'debt-counselor':
      return 'partial';
    case 'engineer':
      return 'masked';
    case 'client-viewer':
      return 'aggregate';
    default:
      return 'none' as never;
  }
}
