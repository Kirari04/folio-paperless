export type PrintResultPlatform = 'android' | 'ios' | 'web';

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * SDK 57 exposes an exact iOS cancellation code. Android resolves when its
 * dialog opens, so a later dismissal cannot be observed by the app.
 */
export function classifyPrintRejection(
  error: unknown,
  platform: PrintResultPlatform,
): 'canceled' | 'print' {
  return platform === 'ios' && errorCode(error) === 'ERR_PRINT_INCOMPLETE'
    ? 'canceled'
    : 'print';
}
