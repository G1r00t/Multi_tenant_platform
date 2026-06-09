import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { NumericPiiField } from './fields.js';
import {
  FIELD_CONFIG,
  normalizeNumericPii,
  normalizePan,
  validateNumericPii,
  validatePan,
  validatePanToken,
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

/** FF3 radix-26 alphabet (first 26 characters). */
const RADIX26_ALPHABET = '0123456789abcdefghijklmnop';

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

function letterToRadix26Char(letter: string): string {
  const index = letter.toUpperCase().charCodeAt(0) - 65;
  return RADIX26_ALPHABET[index]!;
}

function radix26CharToLetter(char: string): string {
  const index = RADIX26_ALPHABET.indexOf(char);
  return String.fromCharCode(65 + index);
}

function lettersToRadix26Input(letters: string): string {
  return [...letters.toUpperCase()].map((c) => letterToRadix26Char(c)).join('');
}

function radix26InputToLetters(input: string): string {
  return [...input].map((c) => radix26CharToLetter(c)).join('');
}

const PAN_DIGIT_MOD = 10_000;

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x;
}

function modInverse(a: number, mod: number): number {
  let t = 0;
  let newT = 1;
  let r = mod;
  let newR = a % mod;
  while (newR !== 0) {
    const quotient = Math.floor(r / newR);
    [t, newT] = [newT, t - quotient * newT];
    [r, newR] = [newR, r - quotient * newR];
  }
  if (r > 1) {
    throw new Error('pan_digit_not_invertible');
  }
  return ((t % mod) + mod) % mod;
}

function derivePanDigitPermutation(
  dekHex: string,
  tweakHex: string,
): { a: number; b: number; aInv: number } {
  const hash = createHash('sha256').update(`${dekHex}:${tweakHex}:pan-digits`).digest();
  let a = (hash.readUInt32BE(0) % 4_000) + 1_001;
  while (gcd(a, PAN_DIGIT_MOD) !== 1) {
    a += 2;
  }
  const b = hash.readUInt32BE(4) % PAN_DIGIT_MOD;
  return { a, b, aInv: modInverse(a, PAN_DIGIT_MOD) };
}

function encryptPanDigits4(digits4: string, dekHex: string, tweakHex: string): string {
  const value = Number.parseInt(digits4, 10);
  const { a, b } = derivePanDigitPermutation(dekHex, tweakHex);
  return String((a * value + b) % PAN_DIGIT_MOD).padStart(4, '0');
}

function decryptPanDigits4(tokenDigits4: string, dekHex: string, tweakHex: string): string {
  const value = Number.parseInt(tokenDigits4, 10);
  const { aInv, b } = derivePanDigitPermutation(dekHex, tweakHex);
  return String((aInv * ((value - b + PAN_DIGIT_MOD) % PAN_DIGIT_MOD)) % PAN_DIGIT_MOD).padStart(
    4,
    '0',
  );
}

function panLastLetterOffset(dekHex: string, tweakHex: string): number {
  const hash = createHash('sha256').update(`${dekHex}:${tweakHex}:pan-last-letter`).digest();
  return hash[0]! % 26;
}

function encryptPanLetter(letter: string, dekHex: string, tweakHex: string): string {
  const offset = panLastLetterOffset(dekHex, tweakHex);
  const idx = (letter.toUpperCase().charCodeAt(0) - 65 + offset) % 26;
  return String.fromCharCode(65 + idx);
}

function decryptPanLetter(tokenLetter: string, dekHex: string, tweakHex: string): string {
  const offset = panLastLetterOffset(dekHex, tweakHex);
  const idx = (tokenLetter.toUpperCase().charCodeAt(0) - 65 - offset + 26) % 26;
  return String.fromCharCode(65 + idx);
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

/** Format-preserving PAN: AAAAA9999A — 5 letters, 4 digits, 1 letter. */
export function encryptPan(dekHex: string, tweakHex: string, plaintext: string): string {
  const pan = normalizePan(plaintext);
  if (!validatePan(pan)) {
    throw new Error('invalid_pan_format');
  }

  const letters5 = pan.slice(0, 5);
  const digits4 = pan.slice(5, 9);
  const letter1 = pan.slice(9, 10);

  const cipherAlpha5 = getCipher(dekHex, tweakHex, 'pan-alpha5', 26);

  const tokenLetters5 = radix26InputToLetters(
    cipherAlpha5.encrypt(lettersToRadix26Input(letters5)),
  );
  const tokenDigits4 = encryptPanDigits4(digits4, dekHex, tweakHex);
  const tokenLetter1 = encryptPanLetter(letter1, dekHex, tweakHex);

  const token = tokenLetters5 + tokenDigits4 + tokenLetter1;
  if (!validatePanToken(token)) {
    throw new Error('invalid_pan_token_format');
  }
  return token;
}

export function decryptPan(dekHex: string, tweakHex: string, token: string): string {
  const normalized = normalizePan(token);
  if (!validatePanToken(normalized)) {
    throw new Error('invalid_pan_token_format');
  }

  const cipherAlpha5 = getCipher(dekHex, tweakHex, 'pan-alpha5', 26);

  const letters5 = radix26InputToLetters(
    cipherAlpha5.decrypt(lettersToRadix26Input(normalized.slice(0, 5))),
  );
  const digits4 = decryptPanDigits4(normalized.slice(5, 9), dekHex, tweakHex);
  const letter1 = decryptPanLetter(normalized.slice(9, 10), dekHex, tweakHex);

  const pan = letters5 + digits4 + letter1;
  if (!validatePan(pan)) {
    throw new Error('invalid_pan_decrypt');
  }
  return pan;
}

export function clearCipherCache(): void {
  cipherCache.clear();
}
