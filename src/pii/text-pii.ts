import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  normalizeEmail,
  normalizeName,
  validateEmail,
  validateEmailToken,
  validateName,
  validateNameToken,
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

const RADIX36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const RADIX26_ALPHABET = '0123456789abcdefghijklmnop';
const LETTERS_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

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

function deriveShortPermutation(
  dekHex: string,
  tweakHex: string,
  context: string,
  alphabet: string,
): string[] {
  const hash = createHash('sha256').update(`${dekHex}:${tweakHex}:${context}`).digest();
  const perm = [...alphabet];
  for (let i = perm.length - 1; i > 0; i--) {
    const j = hash[i % hash.length]! % (i + 1);
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  return perm;
}

function deriveShortAlphanumericPermutation(
  dekHex: string,
  tweakHex: string,
  context: string,
): string[] {
  return deriveShortPermutation(dekHex, tweakHex, context, RADIX36_ALPHABET);
}

function deriveShortLetterPermutation(
  dekHex: string,
  tweakHex: string,
  context: string,
): string[] {
  return deriveShortPermutation(dekHex, tweakHex, context, LETTERS_ALPHABET);
}

function encryptShortAlphanumeric(
  run: string,
  dekHex: string,
  tweakHex: string,
  context: string,
): string {
  const perm = deriveShortAlphanumericPermutation(dekHex, tweakHex, `enc:${context}`);
  return [...run].map((char) => perm[RADIX36_ALPHABET.indexOf(char)]!).join('');
}

function decryptShortAlphanumeric(
  run: string,
  dekHex: string,
  tweakHex: string,
  context: string,
): string {
  const perm = deriveShortAlphanumericPermutation(dekHex, tweakHex, `enc:${context}`);
  const inverse = new Map(perm.map((char, idx) => [char, RADIX36_ALPHABET[idx]!]));
  return [...run].map((char) => inverse.get(char) ?? char).join('');
}

function encryptShortLetters(
  run: string,
  dekHex: string,
  tweakHex: string,
  context: string,
): string {
  const perm = deriveShortLetterPermutation(dekHex, tweakHex, `enc:${context}`);
  return [...run.toLowerCase()].map((char) => perm[LETTERS_ALPHABET.indexOf(char)]!).join('');
}

function decryptShortLetters(
  run: string,
  dekHex: string,
  tweakHex: string,
  context: string,
): string {
  const perm = deriveShortLetterPermutation(dekHex, tweakHex, `enc:${context}`);
  const inverse = new Map(perm.map((char, idx) => [char, LETTERS_ALPHABET[idx]!]));
  return [...run.toLowerCase()].map((char) => inverse.get(char) ?? char).join('');
}

function applyCasePattern(source: string, target: string): string {
  return [...source]
    .map((char, index) => {
      const mapped = target[index]!;
      return char === char.toUpperCase() && char !== char.toLowerCase()
        ? mapped.toUpperCase()
        : mapped.toLowerCase();
    })
    .join('');
}

function encryptAlphanumericRun(
  run: string,
  dekHex: string,
  tweakHex: string,
  context: string,
): string {
  if (run.length < 4) {
    return encryptShortAlphanumeric(run, dekHex, tweakHex, context);
  }
  const cipher = getCipher(dekHex, tweakHex, context, 36);
  return cipher.encrypt(run);
}

function decryptAlphanumericRun(
  run: string,
  dekHex: string,
  tweakHex: string,
  context: string,
): string {
  if (run.length < 4) {
    return decryptShortAlphanumeric(run, dekHex, tweakHex, context);
  }
  const cipher = getCipher(dekHex, tweakHex, context, 36);
  return cipher.decrypt(run);
}

function encryptLetterRun(
  run: string,
  dekHex: string,
  tweakHex: string,
  context: string,
): string {
  const lower = run.toLowerCase();
  let encryptedLower: string;
  if (lower.length < 5) {
    encryptedLower = encryptShortLetters(lower, dekHex, tweakHex, `name:${context}`);
  } else {
    const cipher = getCipher(dekHex, tweakHex, `name:${context}`, 26);
    encryptedLower = radix26InputToLetters(cipher.encrypt(lettersToRadix26Input(lower))).toLowerCase();
  }

  return applyCasePattern(run, encryptedLower);
}

function decryptLetterRun(
  run: string,
  dekHex: string,
  tweakHex: string,
  context: string,
): string {
  const lower = run.toLowerCase();
  let decryptedLower: string;
  if (lower.length < 5) {
    decryptedLower = decryptShortLetters(lower, dekHex, tweakHex, `name:${context}`);
  } else {
    const cipher = getCipher(dekHex, tweakHex, `name:${context}`, 26);
    decryptedLower = radix26InputToLetters(cipher.decrypt(lettersToRadix26Input(lower))).toLowerCase();
  }

  return applyCasePattern(run, decryptedLower);
}

function mapTokenizedRuns(
  value: string,
  pattern: RegExp,
  transform: (run: string, index: number) => string,
): string {
  let runIndex = 0;
  return value.replace(pattern, (run) => transform(run, runIndex++));
}

export function encryptEmail(dekHex: string, tweakHex: string, plaintext: string): string {
  const email = normalizeEmail(plaintext);
  if (!validateEmail(email)) {
    throw new Error('invalid_email_format');
  }

  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  const tokenLocal = mapTokenizedRuns(local, /[a-z0-9]+/g, (run, index) =>
    encryptAlphanumericRun(run, dekHex, tweakHex, `email-local-${index}`),
  );

  const tokenDomain = mapTokenizedRuns(domain, /[a-z0-9]+/g, (run, index) =>
    encryptAlphanumericRun(run, dekHex, tweakHex, `email-domain-${index}`),
  );

  const token = `${tokenLocal}@${tokenDomain}`;
  if (!validateEmailToken(token)) {
    throw new Error('invalid_email_token_format');
  }
  return token;
}

export function decryptEmail(dekHex: string, tweakHex: string, token: string): string {
  const email = normalizeEmail(token);
  if (!validateEmailToken(email)) {
    throw new Error('invalid_email_token_format');
  }

  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  const plainLocal = mapTokenizedRuns(local, /[a-z0-9]+/g, (run, index) =>
    decryptAlphanumericRun(run, dekHex, tweakHex, `email-local-${index}`),
  );

  const plainDomain = mapTokenizedRuns(domain, /[a-z0-9]+/g, (run, index) =>
    decryptAlphanumericRun(run, dekHex, tweakHex, `email-domain-${index}`),
  );

  const plain = `${plainLocal}@${plainDomain}`;
  if (!validateEmail(plain)) {
    throw new Error('invalid_email_decrypt');
  }
  return plain;
}

export function encryptName(dekHex: string, tweakHex: string, plaintext: string): string {
  const name = normalizeName(plaintext);
  if (!validateName(name)) {
    throw new Error('invalid_name_format');
  }

  const token = mapTokenizedRuns(name, /[A-Za-z]+/g, (run, index) =>
    encryptLetterRun(run, dekHex, tweakHex, `name-${index}`),
  );

  if (!validateNameToken(token)) {
    throw new Error('invalid_name_token_format');
  }
  return token;
}

export function decryptName(dekHex: string, tweakHex: string, token: string): string {
  const name = normalizeName(token);
  if (!validateNameToken(name)) {
    throw new Error('invalid_name_token_format');
  }

  const plain = mapTokenizedRuns(name, /[A-Za-z]+/g, (run, index) =>
    decryptLetterRun(run, dekHex, tweakHex, `name-${index}`),
  );

  if (!validateName(plain)) {
    throw new Error('invalid_name_decrypt');
  }
  return plain;
}

export function clearTextCipherCache(): void {
  cipherCache.clear();
}
