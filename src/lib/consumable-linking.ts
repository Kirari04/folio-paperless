export interface ConsumableLinkingCache {
  clearInitialURL(): void;
  getLinkingURL(): string | null;
}

/**
 * Clear Expo's process-wide cached URL before granting it routing authority.
 * This ordering prevents a handled cold or warm link from being returned again
 * when the protected routing gateway remounts after biometric unlock.
 */
export function consumeLinkingUrl(
  url: string,
  cache: ConsumableLinkingCache,
  consume: (url: string) => void,
): void {
  cache.clearInitialURL();
  consume(url);
}

export function consumeCachedLinkingUrl(
  cache: ConsumableLinkingCache,
  consume: (url: string) => void,
): boolean {
  const url = cache.getLinkingURL();
  if (!url) return false;
  consumeLinkingUrl(url, cache, consume);
  return true;
}
