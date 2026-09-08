import { ApiProblem } from '@/lib/api-security';
import { ArchiveObjectError } from '@/lib/conversation-archive/object-store';
/** Public read failures have stable status codes; storage details never cross the boundary. */
export function mediaEvidenceProblem(error: unknown): never {
  if (error instanceof ApiProblem) throw error;
  if (error instanceof ArchiveObjectError) throw new ApiProblem({ status: error.status, code: error.code, title: '证据存储暂不可用', detail: '请检查对象版本与存储连接后重试。' });
  const code = error instanceof Error ? error.message : '';
  const status: Record<string, number> = { MEDIA_EVIDENCE_NOT_FOUND: 404, MEDIA_EVIDENCE_NOT_AVAILABLE: 409, MEDIA_EVIDENCE_GRANT_UNAVAILABLE: 403, MEDIA_EVIDENCE_GRANT_CHANGED: 409, MEDIA_EVIDENCE_HOLD_INVALID: 422, MEDIA_EVIDENCE_HOLD_UNAVAILABLE: 409, MEDIA_EVIDENCE_HOLD_CANNOT_SHORTEN: 409 };
  if (status[code]) throw new ApiProblem({ status: status[code], code, title: '证据访问不可用', detail: code });
  if (/^MEDIA_EVIDENCE_[A-Z_]+$/.test(code)) throw new ApiProblem({ status: 503, code: 'MEDIA_EVIDENCE_STORAGE_UNAVAILABLE', title: '证据存储暂不可用', detail: '证据完整性校验或存储读取失败，请恢复服务后重试。' });
  throw error;
}
