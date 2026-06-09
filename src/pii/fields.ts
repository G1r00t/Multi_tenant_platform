export type NumericPiiField = 'phone' | 'aadhaar' | 'bankAccount';

export const NUMERIC_PII_FIELDS: NumericPiiField[] = ['phone', 'aadhaar', 'bankAccount'];

export const TOKEN_FIELD_NAMES: Record<NumericPiiField, string> = {
  phone: 'phoneToken',
  aadhaar: 'aadhaarToken',
  bankAccount: 'bankAccountToken',
};

export const PLAIN_FIELD_NAMES: Record<NumericPiiField, string> = {
  phone: 'phone',
  aadhaar: 'aadhaar',
  bankAccount: 'bankAccount',
};

export const PAN_TOKEN_FIELD = 'panToken';
export const PAN_PLAIN_FIELD = 'pan';

export const BANK_ACCOUNT_MIN_LENGTH = 9;
export const BANK_ACCOUNT_MAX_LENGTH = 18;

export interface FieldConfig {
  length: number;
  radix: number;
}

export const FIELD_CONFIG: Record<NumericPiiField, FieldConfig> = {
  phone: { length: 10, radix: 10 },
  aadhaar: { length: 12, radix: 10 },
  bankAccount: { length: BANK_ACCOUNT_MAX_LENGTH, radix: 10 },
};

export function normalizeNumericPii(value: string, field: NumericPiiField): string {
  let normalized = value.replace(/[\s\-]/g, '');
  if (field === 'phone') {
    normalized = normalized.replace(/^\+91/, '');
  }
  return normalized;
}

export function normalizePan(value: string): string {
  return value.replace(/\s/g, '').toUpperCase();
}

export function validatePan(value: string): boolean {
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(normalizePan(value));
}

export function validateNumericPii(value: string, field: NumericPiiField): boolean {
  const normalized = normalizeNumericPii(value, field);

  if (field === 'bankAccount') {
    if (!/^\d+$/.test(normalized)) return false;
    return (
      normalized.length >= BANK_ACCOUNT_MIN_LENGTH && normalized.length <= BANK_ACCOUNT_MAX_LENGTH
    );
  }

  const { length, radix } = FIELD_CONFIG[field];
  if (normalized.length !== length) return false;
  const pattern = radix === 10 ? /^\d+$/ : /^[0-9a-z]+$/;
  return pattern.test(normalized);
}

export interface BorrowerPlaintextPii {
  phone?: string;
  aadhaar?: string;
  bankAccount?: string;
  pan?: string;
}

export interface BorrowerTokens {
  phoneToken?: string;
  aadhaarToken?: string;
  bankAccountToken?: string;
  panToken?: string;
}

export function buildScrubTargets(
  plaintext: BorrowerPlaintextPii,
  tokens: BorrowerTokens,
): Array<{ search: string; replace: string }> {
  const targets: Array<{ search: string; replace: string }> = [];

  for (const field of NUMERIC_PII_FIELDS) {
    const plain = plaintext[field];
    const tokenKey = TOKEN_FIELD_NAMES[field];
    const token = tokens[tokenKey as keyof BorrowerTokens];
    if (!plain || !token) continue;

    const normalized = normalizeNumericPii(plain, field);
    targets.push({ search: normalized, replace: token });

    if (field === 'phone' && plain !== normalized) {
      targets.push({ search: plain, replace: token });
    }

    const spaced = normalized.replace(/(\d{5})(\d{5})/, '$1 $2');
    if (spaced !== normalized) {
      targets.push({ search: spaced, replace: token });
    }
  }

  if (plaintext.pan && tokens.panToken) {
    targets.push({ search: plaintext.pan, replace: tokens.panToken });
    targets.push({ search: plaintext.pan.toLowerCase(), replace: tokens.panToken });
  }

  return targets.sort((a, b) => b.search.length - a.search.length);
}
