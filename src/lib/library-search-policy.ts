import type { PersistentTaskErrorCode } from '../types/tasks.ts';
import { classifyTaskFailure } from './task-policy.ts';

// Only a momentary connectivity or server failure may be answered from the
// synchronized cache. Authentication, authorization, and API-version failures
// have to reach the screen, because cached documents would otherwise be
// presented as if they were live filtered results.
const CACHEABLE_FAILURE_CODES = new Set<PersistentTaskErrorCode>([
  'network',
  'rate-limited',
  'server',
  'timeout',
]);

function failureStatus(error: unknown) {
  // PaperlessApiError carries the HTTP status; other rejections do not.
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function canServeCachedLibraryResults(error: unknown) {
  const status = failureStatus(error);
  const message = error instanceof Error ? error.message : '';
  // A deterministic client refusal (401, 403, 404, 406, 413, …) will not
  // resolve itself on the next keystroke, so it never reaches the cache.
  if (typeof status === 'number' && status !== 429 && status < 500) return false;
  return CACHEABLE_FAILURE_CODES.has(classifyTaskFailure(status, message).code);
}
