import { createRequire } from 'node:module';
import type { NumericPiiField } from './fields.js';
import {
  FIELD_CONFIG,
  normalizeNumericPii,
  normalizePan,
  validateNumericPii,
  validatePan,
} from './fields.js';

const require = createRequire(import.meta.url);
const FF3Cipher = require('ff3/lib/FF3Cipher') as new (
  key: string,
  tweak: string,
  radix?: number,
) => {
  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
};

const cipherCache = new Map<string, InstanceType<typeof FF3Cipher>>();

const PAN_RADIX = 36;

function cacheKey(dekHex: string, tweakHex: string, field: string, radix: number): string {
  return `${dekHex}:${tweakHex}:${field}:${radix}`;
}

function getCipher(
  dekHex: string,
  tweakHex: string,
  field: string,
  radix: number,
): InstanceType<typeof FF3Cipher> {
  const key = cacheKey(dekHex, tweakHex, field, radix);
  let cipher = cipherCache.get(key);
  if (!cipher) {
    cipher = new FF3Cipher(dekHex, tweakHex, radix);
    cipherCache.set(key, cipher);
  }
  return cipher;
}

function getNumericCipher(
  dekHex: string,
  tweakHex: string,
  field: NumericPiiField,
): InstanceType<typeof FF3Cipher> {
  const { radix } = FIELD_CONFIG[field];
  return getCipher(dekHex, tweakHex, field, radix);
}

export function encryptNumericPii(
  dekHex: string,
  tweakHex: string,
  field: NumericPiiField,
  plaintext: string,
): string {
  const normalized = normalizeNumericPii(plaintext, field);
  if (!validateNumericPii(normalized, field)) {
    throw new Error(`invalid_${field}_format`);
  }

  const cipher = getNumericCipher(dekHex, tweakHex, field);
  return cipher.encrypt(normalized);
}

export function decryptNumericPii(
  dekHex: string,
  tweakHex: string,
  field: NumericPiiField,
  token: string,
): string {
  const cipher = getNumericCipher(dekHex, tweakHex, field);
  return cipher.decrypt(token);
}

export function encryptPan(dekHex: string, tweakHex: string, plaintext: string): string {
  const normalized = normalizePan(plaintext).toLowerCase();
  if (!validatePan(normalized)) {
    throw new Error('invalid_pan_format');
  }
  const cipher = getCipher(dekHex, tweakHex, 'pan', PAN_RADIX);
  return cipher.encrypt(normalized);
}

export function decryptPan(dekHex: string, tweakHex: string, token: string): string {
  const cipher = getCipher(dekHex, tweakHex, 'pan', PAN_RADIX);
  return normalizePan(cipher.decrypt(token));
}

export function clearCipherCache(): void {
  cipherCache.clear();
}
