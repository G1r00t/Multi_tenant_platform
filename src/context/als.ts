import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from '../authz/types.js';

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx) {
    throw new Error('Request context is not available');
  }
  return ctx;
}

export function tryGetContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

export async function runWithContextAsync<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return requestContext.run(ctx, fn);
}
