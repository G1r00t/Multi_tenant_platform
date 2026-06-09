import { getSystemDb } from '../db/router.js';

export interface LegacyBreachSummary {
  crossTenantCounselorAssignmentsFixed: number;
  clientViewerWriteSuccesses: number;
  malformedClientIdRecords: number;
  totalLegacyAccessLogs: number;
}

export async function generateLegacyBreachSummary(): Promise<LegacyBreachSummary> {
  const system = getSystemDb();

  const [migrationFixes, quarantineCount, legacyLogs, viewerWrites] = await Promise.all([
    system.collection('migration_log').countDocuments({ reason: 'cross_tenant_assignment_fix' }),
    system.collection('quarantine_borrowers').countDocuments(),
    system.collection('legacy_access_logs').countDocuments(),
    system.collection('legacy_access_logs').countDocuments({
      userRole: 'client-viewer',
      statusCode: { $gte: 200, $lt: 300 },
      method: { $in: ['POST', 'PUT', 'PATCH', 'DELETE'] },
    }),
  ]);

  return {
    crossTenantCounselorAssignmentsFixed: migrationFixes,
    clientViewerWriteSuccesses: viewerWrites,
    malformedClientIdRecords: quarantineCount,
    totalLegacyAccessLogs: legacyLogs,
  };
}
