import type { ApiAuditRecord, ApiAuditor } from './types';
import { logger } from '@/lib/observability/logger';
import { appendAuditEvent } from '@/lib/audit';

function databaseConfigured(): boolean {
  return Boolean(
    process.env.PGDATABASE_URL || process.env.COZE_SUPABASE_DB_URL || process.env.DATABASE_URL,
  );
}

export const databaseApiAuditor: ApiAuditor = {
  async record(event: ApiAuditRecord): Promise<void> {
    if (!databaseConfigured()) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Persistent audit storage is not configured');
      }
      if (process.env.NODE_ENV !== 'test') logger.warn('audit.persistence.unavailable', event);
      return;
    }
    await appendAuditEvent(event);
  },
};
