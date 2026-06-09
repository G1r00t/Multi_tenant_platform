import { v4 as uuidv4 } from 'uuid';
import { loadRegistry } from '../registry/index.js';
import { enqueueJob } from './queue.js';

const DISPATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function startCronDispatcher(): NodeJS.Timeout {
  const dispatch = async () => {
    try {
      const registry = await loadRegistry();
      const requestId = uuidv4();

      await Promise.all(
        registry.map((entry) =>
          enqueueJob('overdue-check', { tenantId: entry.clientId, requestId }),
        ),
      );

      await Promise.all(
        registry.map((entry) => enqueueJob('erasure', { tenantId: entry.clientId, requestId })),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'cron_dispatch_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        }),
      );
    }
  };

  void dispatch();
  return setInterval(dispatch, DISPATCH_INTERVAL_MS);
}
