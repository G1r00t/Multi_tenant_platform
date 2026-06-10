import { describe, expect, it, vi } from 'vitest';
import { maskEmail, shapeBorrower } from '../src/api/shape.js';
import type { BorrowerDoc } from '../src/authz/scope.js';
import type { TokenService } from '../src/pii/token-service.js';

function mockTokenService(): TokenService {
  return {
    detokenizeField: vi.fn(async (_c, _b, field, token) => `plain-${field}-${token}`),
    detokenizePan: vi.fn(async (_c, _b, token) => `plain-pan-${token}`),
    detokenizeTextField: vi.fn(async (_c, _b, field, token) => `plain-${field}-${token}`),
    maskToken: (token: string) => 'X'.repeat(Math.max(0, token.length - 4)) + token.slice(-4),
  } as unknown as TokenService;
}

const sampleBorrower: BorrowerDoc = {
  borrowerId: 'b1',
  assignedTo: 'c1',
  phoneToken: '1111111111',
  aadhaarToken: '222222222222',
  bankAccountToken: '33333333333',
  panToken: 'ABCDE1234F',
  firstNameToken: 'tok-first',
  lastNameToken: 'tok-last',
  fullNameToken: 'tok-full',
  emailToken: 'tok@example.com',
  status: 'active',
};

describe('shapeBorrower', () => {
  const tokenService = mockTokenService();
  const clientId = 'client_sunrise_001';

  it('detokenizes all numeric PII for admin', async () => {
    const shaped = await shapeBorrower(sampleBorrower, 'admin', clientId, tokenService);
    expect(shaped.phone).toBe('plain-phone-1111111111');
    expect(shaped.aadhaar).toBe('plain-aadhaar-222222222222');
    expect(shaped.bankAccount).toBe('plain-bankAccount-33333333333');
    expect(shaped.pan).toBe('plain-pan-ABCDE1234F');
    expect(shaped.email).toBe('plain-email-tok@example.com');
    expect(shaped.fullName).toBe('plain-fullName-tok-full');
    expect(shaped.firstName).toBe('plain-firstName-tok-first');
    expect(shaped.phoneToken).toBeUndefined();
  });

  it('detokenizes phone/name and masks sensitive IDs for counselor', async () => {
    const shaped = await shapeBorrower(sampleBorrower, 'debt-counselor', clientId, tokenService);
    expect(shaped.phone).toBe('plain-phone-1111111111');
    expect(shaped.fullName).toBe('plain-fullName-tok-full');
    expect(shaped.firstName).toBe('plain-firstName-tok-first');
    expect(shaped.aadhaar).toBe('XXXXXXXX2222');
    expect(shaped.bankAccount).toBe('XXXXXXX3333');
    expect(shaped.pan).toBe('XXXXXX234F');
    expect(shaped.email).toBe('p*****@example.com');
  });

  it('masks all PII for engineer', async () => {
    const shaped = await shapeBorrower(sampleBorrower, 'engineer', clientId, tokenService);
    expect(shaped.phone).toBe('XXXXXX1111');
    expect(shaped.fullName).toMatch(/^X+/);
    expect(shaped.aadhaar).toBe('XXXXXXXX2222');
    expect(shaped.pan).toBe('XXXXXX234F');
    expect(shaped.email).toMatch(/^X+/);
  });
});

describe('maskEmail', () => {
  it('masks local part and keeps domain', () => {
    expect(maskEmail('gaurav.thakur@rediffmail.com')).toBe('g*****@rediffmail.com');
    expect(maskEmail('pankaj@example.com')).toBe('p*****@example.com');
  });
});
