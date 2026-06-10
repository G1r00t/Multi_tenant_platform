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

export type TextPiiField = 'email' | 'fullName' | 'firstName' | 'lastName';

export const TEXT_PII_FIELDS: TextPiiField[] = ['email', 'fullName', 'firstName', 'lastName'];

export const TEXT_TOKEN_FIELD_NAMES: Record<TextPiiField, string> = {
  email: 'emailToken',
  fullName: 'fullNameToken',
  firstName: 'firstNameToken',
  lastName: 'lastNameToken',
};

export const TEXT_PLAIN_FIELD_NAMES: Record<TextPiiField, string> = {
  email: 'email',
  fullName: 'fullName',
  firstName: 'firstName',
  lastName: 'lastName',
};

export const EMAIL_TOKEN_FIELD = TEXT_TOKEN_FIELD_NAMES.email;
export const EMAIL_PLAIN_FIELD = TEXT_PLAIN_FIELD_NAMES.email;
export const FULL_NAME_TOKEN_FIELD = TEXT_TOKEN_FIELD_NAMES.fullName;
export const FULL_NAME_PLAIN_FIELD = TEXT_PLAIN_FIELD_NAMES.fullName;
export const FIRST_NAME_TOKEN_FIELD = TEXT_TOKEN_FIELD_NAMES.firstName;
export const FIRST_NAME_PLAIN_FIELD = TEXT_PLAIN_FIELD_NAMES.firstName;
export const LAST_NAME_TOKEN_FIELD = TEXT_TOKEN_FIELD_NAMES.lastName;
export const LAST_NAME_PLAIN_FIELD = TEXT_PLAIN_FIELD_NAMES.lastName;

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

export function validatePanToken(value: string): boolean {
  return validatePan(value);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateEmail(value: string): boolean {
  const email = normalizeEmail(value);
  return /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email);
}

/** Tokenized emails may contain digits in the TLD after FF3 encryption. */
export function validateEmailToken(value: string): boolean {
  const email = normalizeEmail(value);
  return /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z0-9]{2,}$/.test(email);
}

export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function validateName(value: string): boolean {
  return /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(normalizeName(value));
}

export function validateNameToken(value: string): boolean {
  return validateName(value);
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
  email?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
}

export interface BorrowerTokens {
  phoneToken?: string;
  aadhaarToken?: string;
  bankAccountToken?: string;
  panToken?: string;
  emailToken?: string;
  fullNameToken?: string;
  firstNameToken?: string;
  lastNameToken?: string;
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

  for (const field of TEXT_PII_FIELDS) {
    const plain = plaintext[field];
    const tokenKey = TEXT_TOKEN_FIELD_NAMES[field];
    const token = tokens[tokenKey as keyof BorrowerTokens];
    if (!plain || !token) continue;

    targets.push({ search: plain, replace: token });

    if (field === 'email') {
      const normalized = normalizeEmail(plain);
      if (normalized !== plain) {
        targets.push({ search: normalized, replace: token });
      }
    }
  }

  return targets.sort((a, b) => b.search.length - a.search.length);
}
