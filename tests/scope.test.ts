import { describe, expect, it } from 'vitest';
import { counselorListFilter } from '../src/authz/scope.js';

describe('counselorListFilter', () => {
  it('returns assignedTo filter for debt-counselor', () => {
    expect(counselorListFilter('debt-counselor', 'user-123')).toEqual({ assignedTo: 'user-123' });
  });

  it('returns null for admin (no filter)', () => {
    expect(counselorListFilter('admin', 'user-123')).toBeNull();
  });

  it('returns null for engineer (no filter)', () => {
    expect(counselorListFilter('engineer', 'user-123')).toBeNull();
  });
});
