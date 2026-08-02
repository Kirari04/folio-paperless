type ExpoExtra = Record<string, unknown>;

function isExpoExtra(value: unknown): value is ExpoExtra {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The GitHub updater is an explicit, fail-closed build capability. A missing,
 * malformed, or contradictory marker must never make sideload UI reachable.
 */
export function allowsInAppApkUpdates(extra: unknown): boolean {
  return isExpoExtra(extra)
    && extra.folioDistribution === 'github'
    && extra.supportsInAppApkUpdates === true;
}
