import { describe, expect, it } from 'vitest';
import {
  buildScrubTargets,
  normalizeEmail,
  normalizeName,
  normalizeNumericPii,
  normalizePan,
  validateEmail,
  validateEmailToken,
  validateName,
  validateNumericPii,
  validatePan,
} from '../src/pii/fields.js';
import {
  clearCipherCache,
  decryptNumericPii,
  decryptPan,
  encryptNumericPii,
  encryptPan,
} from '../src/pii/ff3.js';
import {
  clearTextCipherCache,
  decryptEmail,
  decryptName,
  encryptEmail,
  encryptName,
} from '../src/pii/text-pii.js';
import { generateDekHex, generateTweakHex } from '../src/pii/vault.js';

describe('PII fields', () => {
  it('normalizes phone numbers with spaces and +91', () => {
    expect(normalizeNumericPii('79360 43811', 'phone')).toBe('7936043811');
    expect(normalizeNumericPii('+917936043811', 'phone')).toBe('7936043811');
  });

  it('validates numeric PII lengths', () => {
    expect(validateNumericPii('7936043811', 'phone')).toBe(true);
    expect(validateNumericPii('793604381', 'phone')).toBe(false);
    expect(validateNumericPii('189966462838', 'aadhaar')).toBe(true);
    expect(validateNumericPii('64693666476', 'bankAccount')).toBe(true);
    expect(validateNumericPii('9976736384200550', 'bankAccount')).toBe(true);
    expect(validateNumericPii('12345678', 'bankAccount')).toBe(false);
    expect(validateNumericPii('1234567890123456789', 'bankAccount')).toBe(false);
  });

  it('validates PAN format', () => {
    expect(validatePan('JUANL6658L')).toBe(true);
    expect(normalizePan('juanl6658l')).toBe('JUANL6658L');
    expect(validatePan('INVALID')).toBe(false);
  });

  it('validates email and name formats', () => {
    expect(validateEmail('pankaj_thakur@outlook.com')).toBe(true);
    expect(normalizeEmail('Pankaj@Example.COM')).toBe('pankaj@example.com');
    expect(validateName('Pankaj Thakur')).toBe(true);
    expect(normalizeName('  Pankaj   Thakur ')).toBe('Pankaj Thakur');
    expect(validateName('Pankaj123')).toBe(false);
  });

  it('builds scrub targets longest-first', () => {
    const targets = buildScrubTargets(
      {
        phone: '7936043811',
        bankAccount: '64693666476',
        pan: 'JUANL6658L',
        email: 'pankaj@example.com',
        fullName: 'Pankaj Thakur',
      },
      {
        phoneToken: '1234567890',
        bankAccountToken: '98765432109',
        panToken: 'abc1234567',
        emailToken: 'token@example.com',
        fullNameToken: 'Token Name',
      },
    );
    expect(targets[0]!.search.length).toBeGreaterThanOrEqual(targets[targets.length - 1]!.search.length);
  });
});

describe('FF3-1 format-preserving tokenization', () => {
  const dek = generateDekHex();
  const tweak = generateTweakHex();

  it('round-trips phone preserving 10 digits', () => {
    const plaintext = '7936043811';
    const token = encryptNumericPii(dek, tweak, 'phone', plaintext);
    expect(token).toMatch(/^\d{10}$/);
    expect(decryptNumericPii(dek, tweak, 'phone', token)).toBe(plaintext);
  });

  it('round-trips aadhaar preserving 12 digits', () => {
    const plaintext = '189966462838';
    const token = encryptNumericPii(dek, tweak, 'aadhaar', plaintext);
    expect(token).toMatch(/^\d{12}$/);
    expect(decryptNumericPii(dek, tweak, 'aadhaar', token)).toBe(plaintext);
  });

  it('round-trips 16-digit bankAccount preserving length', () => {
    const plaintext = '9976736384200550';
    const token = encryptNumericPii(dek, tweak, 'bankAccount', plaintext);
    expect(token).toMatch(/^\d{16}$/);
    expect(decryptNumericPii(dek, tweak, 'bankAccount', token)).toBe(plaintext);
  });

  it('round-trips 11-digit bankAccount preserving length', () => {
    const plaintext = '64693666476';
    const token = encryptNumericPii(dek, tweak, 'bankAccount', plaintext);
    expect(token).toMatch(/^\d{11}$/);
    expect(decryptNumericPii(dek, tweak, 'bankAccount', token)).toBe(plaintext);
  });

  it('round-trips PAN preserving 10-character format', () => {
    const plaintext = 'JUANL6658L';
    const token = encryptPan(dek, tweak, plaintext);
    expect(token).toMatch(/^[A-Z]{5}\d{4}[A-Z]$/);
    expect(token).toHaveLength(10);
    expect(decryptPan(dek, tweak, token)).toBe(plaintext);
  });

  it('is deterministic for same dek, tweak, and value', () => {
    const a = encryptNumericPii(dek, tweak, 'phone', '7936043811');
    const b = encryptNumericPii(dek, tweak, 'phone', '7936043811');
    expect(a).toBe(b);
  });

  it('produces different tokens for different tenant DEKs', () => {
    const dek2 = generateDekHex();
    const token1 = encryptNumericPii(dek, tweak, 'phone', '7936043811');
    const token2 = encryptNumericPii(dek2, tweak, 'phone', '7936043811');
    expect(token1).not.toBe(token2);
  });

  it('becomes irreversible when tweak is unknown', () => {
    const token = encryptNumericPii(dek, tweak, 'phone', '7936043811');
    const wrongTweak = generateTweakHex();
    const decrypted = decryptNumericPii(dek, wrongTweak, 'phone', token);
    expect(decrypted).not.toBe('7936043811');
    clearCipherCache();
  });
});

describe('format-preserving email and name tokenization', () => {
  const dek = generateDekHex();
  const tweak = generateTweakHex();

  it('round-trips email preserving address shape', () => {
    const plaintext = 'pankaj_thakur@outlook.com';
    const token = encryptEmail(dek, tweak, plaintext);
    expect(validateEmailToken(token)).toBe(true);
    expect(token).toContain('@');
    expect(decryptEmail(dek, tweak, token)).toBe(plaintext);
  });

  it('round-trips full name preserving letters and spaces', () => {
    const plaintext = 'Pankaj Thakur';
    const token = encryptName(dek, tweak, plaintext);
    expect(validateName(token)).toBe(true);
    expect(decryptName(dek, tweak, token)).toBe(plaintext);
  });

  it('is deterministic for same dek, tweak, and value', () => {
    const emailA = encryptEmail(dek, tweak, 'girish.dubey85@rediffmail.com');
    const emailB = encryptEmail(dek, tweak, 'girish.dubey85@rediffmail.com');
    const nameA = encryptName(dek, tweak, 'Girish Dubey');
    const nameB = encryptName(dek, tweak, 'Girish Dubey');
    expect(emailA).toBe(emailB);
    expect(nameA).toBe(nameB);
  });

  it('produces different tokens for different tenant DEKs', () => {
    const dek2 = generateDekHex();
    const email1 = encryptEmail(dek, tweak, 'pankaj@example.com');
    const email2 = encryptEmail(dek2, tweak, 'pankaj@example.com');
    const name1 = encryptName(dek, tweak, 'Pankaj Thakur');
    const name2 = encryptName(dek2, tweak, 'Pankaj Thakur');
    expect(email1).not.toBe(email2);
    expect(name1).not.toBe(name2);
    clearTextCipherCache();
  });
});
