import { describe, expect, it } from 'vitest';
import { assertAgentMessageAllowed, isQuietHours } from '../src/compliance/quiet-hours.js';

describe('quiet hours', () => {
  it('blocks agent messages at 9 PM IST', () => {
    const atNinePmIst = new Date('2026-06-08T15:30:00.000Z');
    expect(isQuietHours(atNinePmIst)).toBe(true);
    expect(() => assertAgentMessageAllowed('agent', atNinePmIst)).toThrow();
  });

  it('allows borrower messages during quiet hours', () => {
    const atNinePmIst = new Date('2026-06-08T15:30:00.000Z');
    expect(() => assertAgentMessageAllowed('borrower', atNinePmIst)).not.toThrow();
  });

  it('allows agent messages at noon IST', () => {
    const atNoonIst = new Date('2026-06-08T06:30:00.000Z');
    expect(isQuietHours(atNoonIst)).toBe(false);
    expect(() => assertAgentMessageAllowed('agent', atNoonIst)).not.toThrow();
  });
});
