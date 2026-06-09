import { describe, expect, it } from 'vitest';
import { evaluate, methodToAction, routeToResource } from '../src/authz/policy.js';

describe('policy matrix', () => {
  it('denies unauthenticated access to borrowers', () => {
    const decision = evaluate(null, 'borrowers', 'read');
    expect(decision.allowed).toBe(false);
  });

  it('blocks client-viewer from creating payments', () => {
    const decision = evaluate('client-viewer', 'payments', 'create');
    expect(decision.allowed).toBe(false);
  });

  it('blocks engineer from writing borrowers', () => {
    const decision = evaluate('engineer', 'borrowers', 'create');
    expect(decision.allowed).toBe(false);
  });

  it('allows debt-counselor to read borrowers with partial masking', () => {
    const decision = evaluate('debt-counselor', 'borrowers', 'read');
    expect(decision.allowed).toBe(true);
    expect(decision.maskingLevel).toBe('partial');
  });

  it('allows client-viewer aggregate read on borrowers list', () => {
    const decision = evaluate('client-viewer', 'borrowers', 'read');
    expect(decision.allowed).toBe(true);
    expect(decision.maskingLevel).toBe('aggregate');
  });

  it('allows public health check', () => {
    expect(routeToResource('GET', '/health')).toBe('health');
    expect(evaluate(null, 'health', 'read').allowed).toBe(true);
  });

  it('maps POST /payments to create action', () => {
    expect(routeToResource('POST', '/payments')).toBe('payments');
    expect(methodToAction('POST')).toBe('create');
  });

  it('maps POST /borrowers to borrowers resource', () => {
    expect(routeToResource('POST', '/borrowers')).toBe('borrowers');
    expect(evaluate('admin', 'borrowers', 'create').allowed).toBe(true);
    expect(evaluate('engineer', 'borrowers', 'create').allowed).toBe(false);
  });

  it('allows admin to read borrower item with full masking', () => {
    const decision = evaluate('admin', 'borrowers.item', 'read');
    expect(decision.allowed).toBe(true);
    expect(decision.maskingLevel).toBe('full');
    expect(decision.requiresTenantHeader).toBe(true);
  });

  it('denies client-viewer from reading borrower item', () => {
    expect(evaluate('client-viewer', 'borrowers.item', 'read').allowed).toBe(false);
  });

  it('allows debt-counselor partial read on borrower item', () => {
    const decision = evaluate('debt-counselor', 'borrowers.item', 'read');
    expect(decision.allowed).toBe(true);
    expect(decision.maskingLevel).toBe('partial');
  });
});
