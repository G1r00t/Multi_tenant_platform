export interface BreakerState {
  failures: number;
  openUntil: number | null;
}

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 30_000;

const breakers = new Map<string, BreakerState>();
const injectedFaults = new Set<string>();

export function isCircuitOpen(tenantId: string): boolean {
  if (injectedFaults.has(tenantId)) {
    return true;
  }

  const state = breakers.get(tenantId);
  if (!state?.openUntil) {
    return false;
  }

  if (Date.now() >= state.openUntil) {
    breakers.delete(tenantId);
    return false;
  }

  return true;
}

export function recordTenantSuccess(tenantId: string): void {
  breakers.delete(tenantId);
}

export function recordTenantFailure(tenantId: string): void {
  const current = breakers.get(tenantId) ?? { failures: 0, openUntil: null };
  current.failures += 1;

  if (current.failures >= FAILURE_THRESHOLD) {
    current.openUntil = Date.now() + OPEN_DURATION_MS;
  }

  breakers.set(tenantId, current);
}

export function getBreakerStatuses(): Record<string, 'closed' | 'open'> {
  const statuses: Record<string, 'closed' | 'open'> = {};
  for (const tenantId of injectedFaults) {
    statuses[tenantId] = 'open';
  }
  for (const [tenantId, state] of breakers.entries()) {
    statuses[tenantId] = isCircuitOpen(tenantId) ? 'open' : 'closed';
  }
  return statuses;
}

export function injectTenantFault(tenantId: string, faulted: boolean): void {
  if (faulted) {
    injectedFaults.add(tenantId);
    return;
  }
  injectedFaults.delete(tenantId);
  breakers.delete(tenantId);
}

export function resetBreakers(): void {
  breakers.clear();
  injectedFaults.clear();
}
